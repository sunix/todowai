#!/usr/bin/env python3
"""
Apply a DESIGN.md design system to a PowerPoint template or deck.

The script is intended to be copied into a Codex skill and run against arbitrary
.potx/.pptx files:

    python apply_design.py input.potx -d DESIGN.md -o output.potx

For unknown templates, colors are inferred from their brightness/chroma. For
repeatable brand conversions, pass explicit overrides:

    python apply_design.py input.potx --color-map 324B75=primary FFFFFF=background
"""

from __future__ import annotations

import argparse
import colorsys
import os
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path


DEFAULT_INPUT = "Modele_SCIAM_avec_layouts.potx"
DEFAULT_OUTPUT_SUFFIX = "_DESIGN"
OOXML_DIRS = (
    "ppt/slides",
    "ppt/slideLayouts",
    "ppt/slideMasters",
    "ppt/notesMasters",
    "ppt/notesSlides",
)
XML_COLOR_RE = re.compile(
    r'(?i)((?:val|lastClr)=")([0-9a-f]{6})(")'
)
TYPEFACE_RE = re.compile(r'typeface="([^"]*)"')


@dataclass(frozen=True)
class TypeStyle:
    name: str
    font_family: str
    font_size_rem: float | None = None
    line_height: float | None = None
    letter_spacing_em: float | None = None
    font_weight: str | None = None


@dataclass(frozen=True)
class DesignSystem:
    name: str
    colors: dict[str, str]
    typography: dict[str, TypeStyle]

    def color(self, *names: str, fallback: str = "000000") -> str:
        for name in names:
            value = self.colors.get(name)
            if value:
                return value
        return fallback

    @property
    def background(self) -> str:
        return self.color("background", "surface", "white", fallback="FFFFFF")

    @property
    def surface_dim(self) -> str:
        return self.color("surface-dim", "surface-container", "secondary", "surface", fallback=self.background)

    @property
    def ink(self) -> str:
        return self.color("on-surface", "foreground", "black", fallback="111111")

    @property
    def muted(self) -> str:
        return self.color("on-surface-variant", "muted-foreground", "foreground-muted", fallback=self.ink)

    @property
    def primary(self) -> str:
        return self.color("primary", "accent", "brand", fallback=self.ink)

    @property
    def on_primary(self) -> str:
        return self.color("on-primary", "white", "background", fallback=self.background)

    @property
    def error(self) -> str:
        return self.color("error", "destructive", fallback=self.primary)

    @property
    def outline(self) -> str:
        return self.color("outline", "border", "outline-variant", fallback=self.muted)

    @property
    def display_font(self) -> str:
        for key in ("display-xl", "display-lg", "headline-md", "headline", "h1"):
            style = self.typography.get(key)
            if style:
                return style.font_family
        return "Georgia"

    @property
    def body_font(self) -> str:
        for key in ("body-base", "body", "body-lg", "label-sm"):
            style = self.typography.get(key)
            if style:
                return style.font_family
        return "Arial"


def parse_design_md(path: Path) -> DesignSystem:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not match:
        raise ValueError(f"No YAML frontmatter found in {path}")

    body = match.group(1)
    colors = _parse_colors(body)
    typography = _parse_typography(body)
    name = _parse_scalar(body, "name") or path.stem
    return DesignSystem(name=name, colors=colors, typography=typography)


def _parse_scalar(frontmatter: str, key: str) -> str | None:
    pattern = re.compile(rf"^{re.escape(key)}:\s*['\"]?([^'\"]+)['\"]?\s*$", re.MULTILINE)
    match = pattern.search(frontmatter)
    return match.group(1).strip() if match else None


def _parse_colors(frontmatter: str) -> dict[str, str]:
    colors: dict[str, str] = {}
    in_colors = False
    for line in frontmatter.splitlines():
        if line.strip() == "colors:":
            in_colors = True
            continue
        if in_colors and line and not line.startswith((" ", "#")):
            break
        if not in_colors:
            continue

        hex_match = re.match(r"\s+([a-zA-Z0-9_-]+):\s*['\"]?#([0-9A-Fa-f]{6})['\"]?", line)
        if hex_match:
            colors[hex_match.group(1)] = hex_match.group(2).upper()
            continue

        rgba_match = re.match(
            r"\s+([a-zA-Z0-9_-]+):\s*['\"]?rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)['\"]?",
            line,
        )
        if rgba_match:
            key, r, g, b, alpha = rgba_match.groups()
            base = colors.get("background") or colors.get("surface") or "FFFFFF"
            colors[key] = composite_rgba_over_hex((int(r), int(g), int(b)), float(alpha), base)
    return colors


def _parse_typography(frontmatter: str) -> dict[str, TypeStyle]:
    typography: dict[str, TypeStyle] = {}
    in_typography = False
    current: str | None = None
    fields: dict[str, str] = {}

    def flush() -> None:
        nonlocal fields, current
        if current and fields.get("fontFamily"):
            typography[current] = TypeStyle(
                name=current,
                font_family=fields["fontFamily"],
                font_size_rem=_parse_rem(fields.get("fontSize")),
                line_height=_parse_float(fields.get("lineHeight")),
                letter_spacing_em=_parse_em(fields.get("letterSpacing")),
                font_weight=fields.get("fontWeight"),
            )
        fields = {}

    for line in frontmatter.splitlines():
        if line.strip() == "typography:":
            in_typography = True
            continue
        if in_typography and line and not line.startswith(" "):
            flush()
            break
        if not in_typography:
            continue

        style_match = re.match(r"^  ([a-zA-Z0-9_-]+):\s*$", line)
        if style_match:
            flush()
            current = style_match.group(1)
            continue

        field_match = re.match(r"^    ([a-zA-Z0-9_-]+):\s+(.+?)\s*$", line)
        if field_match:
            key, value = field_match.groups()
            fields[key] = value.strip().strip("'\"")

    flush()
    return typography


def _parse_rem(value: str | None) -> float | None:
    if not value:
        return None
    match = re.match(r"([\d.]+)rem", value)
    return float(match.group(1)) if match else None


def _parse_float(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _parse_em(value: str | None) -> float | None:
    if not value:
        return None
    match = re.match(r"([+-]?[\d.]+)em", value)
    if match:
        return float(match.group(1))
    try:
        return float(value)
    except ValueError:
        return None


def composite_rgba_over_hex(rgb: tuple[int, int, int], alpha: float, background: str) -> str:
    bg = [int(background[i : i + 2], 16) for i in (0, 2, 4)]
    return "".join(f"{round(channel * alpha + bg[index] * (1 - alpha)):02X}" for index, channel in enumerate(rgb))


def normalize_hex(value: str) -> str:
    value = value.strip().lstrip("#").upper()
    if not re.fullmatch(r"[0-9A-F]{6}", value):
        raise ValueError(f"Expected a 6-digit hex color, got {value!r}")
    return value


def relpath(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def extract_package(source: Path, work_dir: Path) -> None:
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as zf:
        zf.extractall(work_dir)


def pack_package(work_dir: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(work_dir.rglob("*")):
            if path.is_file():
                zf.write(path, relpath(path, work_dir))


def iter_xml_files(work_dir: Path) -> list[Path]:
    files: list[Path] = []
    for folder in OOXML_DIRS:
        directory = work_dir / folder
        if directory.is_dir():
            files.extend(sorted(directory.glob("*.xml")))
    return files


def collect_palette(xml_files: list[Path]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for path in xml_files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in XML_COLOR_RE.finditer(text):
            color = match.group(2).upper()
            counts[color] = counts.get(color, 0) + 1
    return counts


def collect_fonts(xml_files: list[Path]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for path in xml_files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in TYPEFACE_RE.finditer(text):
            font = match.group(1)
            if font:
                counts[font] = counts.get(font, 0) + 1
    return counts


def parse_color_overrides(values: list[str], design: DesignSystem) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"Color map must use OLD=token-or-hex, got {value!r}")
        old, target = value.split("=", 1)
        old_hex = normalize_hex(old)
        target = target.strip()
        overrides[old_hex] = normalize_hex(target) if target.startswith("#") or re.fullmatch(r"[0-9A-Fa-f]{6}", target) else design.color(target, fallback="")
        if not overrides[old_hex]:
            raise ValueError(f"Unknown DESIGN.md color token {target!r}")
    return overrides


def infer_color_map(palette: dict[str, int], design: DesignSystem, explicit: dict[str, str]) -> dict[str, str]:
    color_map: dict[str, str] = dict(explicit)
    for color in palette:
        if color in color_map:
            continue
        if color in set(design.colors.values()):
            color_map[color] = color
            continue
        color_map[color] = classify_color(color, design)
    return color_map


def classify_color(color: str, design: DesignSystem) -> str:
    r, g, b = (int(color[i : i + 2], 16) / 255 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    hue = h * 360

    if l >= 0.96:
        return design.background
    if l >= 0.84:
        return design.surface_dim
    if l <= 0.24:
        return design.ink
    if 0.0 <= hue <= 18.0 or hue >= 345.0:
        if s >= 0.45 and l < 0.72:
            return design.error
    if s <= 0.18:
        if l < 0.45:
            return design.muted
        return design.outline if l < 0.78 else design.surface_dim
    return design.primary


def replace_colors(text: str, color_map: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        old = match.group(2).upper()
        return f"{match.group(1)}{color_map.get(old, old)}{match.group(3)}"

    return XML_COLOR_RE.sub(replace, text)


RPR_RE = re.compile(r"<a:rPr\b[^>]*/>|<a:rPr\b[^>]*>.*?</a:rPr>", re.DOTALL)
DEFRPR_RE = re.compile(r"<a:defRPr\b[^>]*/>|<a:defRPr\b[^>]*>.*?</a:defRPr>", re.DOTALL)
SZ_RE = re.compile(r'\bsz="(\d+)"')
BOLD_RE = re.compile(r'\s*\bb="1"')
SPC_RE = re.compile(r'\bspc="(-?\d+)"')
OPEN_RPR_RE = re.compile(r"(<a:(?:r|def)RPr\b)([^>]*?)(\s*/?>)")
FONT_TAG_RE = re.compile(r'(<a:(?:latin|ea|cs)\b[^>]*\btypeface=")([^"]*)(")')
LATIN_RE = re.compile(r"<a:latin\b")


def parse_font_overrides(values: list[str]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"Font map must use OLD=NEW, got {value!r}")
        old, new = value.split("=", 1)
        overrides[old.strip().lower()] = new.strip()
    return overrides


def replace_fonts(text: str, design: DesignSystem, font_overrides: dict[str, str], display_threshold: int) -> str:
    def transform(block: str) -> str:
        size = int(match.group(1)) if (match := SZ_RE.search(block)) else 0
        target_font = design.display_font if size >= display_threshold else design.body_font

        def replace_font_tag(match: re.Match[str]) -> str:
            old_font = match.group(2)
            if old_font.startswith("+"):
                new_font = old_font
            else:
                new_font = font_overrides.get(old_font.lower(), target_font)
            return f"{match.group(1)}{new_font}{match.group(3)}"

        if FONT_TAG_RE.search(block):
            block = FONT_TAG_RE.sub(replace_font_tag, block)
        else:
            block = _inject_latin_font(block, target_font)

        if size >= display_threshold:
            block = BOLD_RE.sub("", block)
            block = block.replace('pitchFamily="34"', 'pitchFamily="18"')

        if size:
            block = _apply_tracking(block, size, design)
        return block

    text = RPR_RE.sub(lambda match: transform(match.group()), text)
    return DEFRPR_RE.sub(lambda match: transform(match.group()), text)


def _inject_latin_font(block: str, font: str) -> str:
    latin = f'<a:latin typeface="{font}"/>'
    if block.endswith("/>"):
        return block[:-2] + f">{latin}</a:defRPr>" if block.startswith("<a:defRPr") else block[:-2] + f">{latin}</a:rPr>"
    close_tag = "</a:defRPr>" if "</a:defRPr>" in block else "</a:rPr>"
    return block.replace(close_tag, latin + close_tag, 1)


def _apply_tracking(block: str, size: int, design: DesignSystem) -> str:
    spc = tracking_for_size(size, design)
    if SPC_RE.search(block):
        return SPC_RE.sub(f'spc="{spc}"', block)
    return OPEN_RPR_RE.sub(lambda match: f'{match.group(1)}{match.group(2)} spc="{spc}"{match.group(3)}', block, count=1)


def tracking_for_size(size: int, design: DesignSystem) -> int:
    pt = size / 100.0
    rem = pt / 12.0
    candidates = sorted(
        (style for style in design.typography.values() if style.font_size_rem is not None and style.letter_spacing_em is not None),
        key=lambda style: abs((style.font_size_rem or 0) - rem),
    )
    if candidates:
        return round((candidates[0].letter_spacing_em or 0) * pt * 100)
    if pt >= 32:
        return round(-0.06 * pt * 100)
    if pt >= 28:
        return round(-0.04 * pt * 100)
    if pt >= 22:
        return round(-0.02 * pt * 100)
    return 0


LVL_PPR_RE = re.compile(r"<a:lvl\d+pPr\b.*?</a:lvl\d+pPr>", re.DOTALL)
DEFRPR_SZ_LVL = re.compile(r'<a:defRPr\b[^>]*\bsz="(\d+)"')
LNSPC_RE = re.compile(r"<a:lnSpc>.*?</a:lnSpc>", re.DOTALL)
LVL_OPEN_RE = re.compile(r"(<a:lvl\d+pPr\b[^>]*>)")


def add_line_spacing(text: str, design: DesignSystem) -> str:
    def transform(block: str) -> str:
        match = DEFRPR_SZ_LVL.search(block)
        if not match:
            return block
        pct = line_spacing_for_size(int(match.group(1)), design)
        if pct is None:
            return block
        lnspc = f'<a:lnSpc><a:spcPct val="{pct}"/></a:lnSpc>'
        if LNSPC_RE.search(block):
            return LNSPC_RE.sub(lnspc, block)
        return LVL_OPEN_RE.sub(lambda open_match: open_match.group(1) + lnspc, block, count=1)

    return LVL_PPR_RE.sub(lambda match: transform(match.group()), text)


def line_spacing_for_size(size: int, design: DesignSystem) -> int | None:
    pt = size / 100.0
    rem = pt / 12.0
    candidates = sorted(
        (style for style in design.typography.values() if style.font_size_rem is not None and style.line_height is not None),
        key=lambda style: abs((style.font_size_rem or 0) - rem),
    )
    if candidates:
        return round((candidates[0].line_height or 1.0) * 100000)
    if pt >= 40:
        return 95000
    if pt >= 32:
        return 100000
    if pt >= 28:
        return 105000
    if pt >= 22:
        return 120000
    if pt >= 18:
        return 135000
    if pt >= 12:
        return 150000
    if pt >= 10:
        return 143000
    return None


def build_theme_xml(design: DesignSystem) -> str:
    def tag(name: str, color: str) -> str:
        return f'<a:{name}><a:srgbClr val="{color}"/></a:{name}>'

    return "".join(
        [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
            f' name="{escape_xml_attr(design.name)}"><a:themeElements>',
            f'<a:clrScheme name="{escape_xml_attr(design.name)}">',
            tag("dk1", design.ink),
            tag("lt1", design.background),
            tag("dk2", design.primary),
            tag("lt2", design.surface_dim),
            tag("accent1", design.primary),
            tag("accent2", design.muted),
            tag("accent3", design.surface_dim),
            tag("accent4", design.ink),
            tag("accent5", design.error),
            tag("accent6", design.outline),
            tag("hlink", design.primary),
            tag("folHlink", design.muted),
            "</a:clrScheme>",
            f'<a:fontScheme name="{escape_xml_attr(design.name)}">',
            f'<a:majorFont><a:latin typeface="{escape_xml_attr(design.display_font)}"/>',
            '<a:ea typeface=""/><a:cs typeface=""/></a:majorFont>',
            f'<a:minorFont><a:latin typeface="{escape_xml_attr(design.body_font)}"/>',
            '<a:ea typeface=""/><a:cs typeface=""/></a:minorFont>',
            "</a:fontScheme>",
            '<a:fmtScheme name="Office">',
            '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
            '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs>',
            '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="85000"/></a:schemeClr></a:gs>',
            '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>',
            '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="80000"/></a:schemeClr></a:gs>',
            '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:gs>',
            '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>',
            '<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
            '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>',
            '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
            '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>',
            '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
            '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst>',
            '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>',
            '<a:effectStyle><a:effectLst/></a:effectStyle>',
            '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">',
            '<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>',
            '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
            '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>',
            '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/></a:schemeClr></a:gs>',
            '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/></a:schemeClr></a:gs></a:gsLst>',
            '<a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst>',
            "</a:fmtScheme></a:themeElements>",
            "<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>",
        ]
    )


def escape_xml_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def write_theme(work_dir: Path, design: DesignSystem) -> Path:
    theme_dir = work_dir / "ppt" / "theme"
    theme_dir.mkdir(parents=True, exist_ok=True)
    theme_path = theme_dir / "theme1.xml"
    theme_path.write_text(build_theme_xml(design), encoding="utf-8")
    return theme_path


def process_xml_file(path: Path, design: DesignSystem, color_map: dict[str, str], font_map: dict[str, str], display_threshold: int) -> bool:
    original = path.read_text(encoding="utf-8", errors="ignore")
    updated = replace_colors(original, color_map)
    updated = replace_fonts(updated, design, font_map, display_threshold)
    updated = add_line_spacing(updated, design)
    if updated == original:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def recolor_dark_images(work_dir: Path, design: DesignSystem, *, verbose: bool) -> int:
    try:
        from PIL import Image
    except ImportError:
        if verbose:
            print("  [images]    Pillow not installed; skipped image recoloring")
        return 0

    media_dir = work_dir / "ppt" / "media"
    if not media_dir.is_dir():
        return 0
    target = tuple(int(design.on_primary[i : i + 2], 16) for i in (0, 2, 4))
    changed = 0
    for path in sorted(media_dir.glob("*")):
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            continue
        try:
            image = Image.open(path).convert("RGBA")
        except Exception:
            continue
        pixels = image.load()
        touched = False
        for y in range(image.height):
            for x in range(image.width):
                r, g, b, a = pixels[x, y]
                if a and r < 90 and g < 95 and b < 110:
                    pixels[x, y] = (*target, a)
                    touched = True
        if touched:
            image.save(path)
            changed += 1
    return changed


def default_output_for(source: Path) -> Path:
    return source.with_name(f"{source.stem}{DEFAULT_OUTPUT_SUFFIX}{source.suffix}")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Apply DESIGN.md tokens to a POTX/PPTX file.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT, help="Input .potx/.pptx file")
    parser.add_argument("-d", "--design", default="DESIGN.md", help="Path to DESIGN.md")
    parser.add_argument("-o", "--output", help="Output .potx/.pptx path")
    parser.add_argument("--work-dir", help="Extraction directory. Defaults to a temporary directory.")
    parser.add_argument("--keep-work-dir", action="store_true", help="Keep the extracted working directory after packaging")
    parser.add_argument("--color-map", nargs="*", default=[], metavar="OLD=TOKEN_OR_HEX", help="Explicit color overrides")
    parser.add_argument("--font-map", nargs="*", default=[], metavar="OLD=NEW", help="Explicit font overrides")
    parser.add_argument("--display-threshold", type=int, default=2800, help="Minimum OOXML font size for display font, in 1/100 pt")
    parser.add_argument("--no-infer-colors", action="store_true", help="Only apply explicit color mappings")
    parser.add_argument("--recolor-dark-images", action="store_true", help="Also recolor very dark pixels in media images to on-primary")
    parser.add_argument("--quiet", action="store_true", help="Reduce logging")
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    source = Path(args.input).resolve()
    design_path = Path(args.design).resolve()
    output = Path(args.output).resolve() if args.output else default_output_for(source).resolve()

    if not source.exists():
        raise FileNotFoundError(source)
    if source.suffix.lower() not in {".potx", ".pptx"}:
        raise ValueError("Input must be a .potx or .pptx file")

    design = parse_design_md(design_path)
    explicit_colors = parse_color_overrides(args.color_map, design)
    font_map = parse_font_overrides(args.font_map)
    verbose = not args.quiet

    temp_context = None
    if args.work_dir:
        work_dir = Path(args.work_dir).resolve()
    else:
        temp_context = tempfile.TemporaryDirectory(prefix="apply_design_")
        work_dir = Path(temp_context.name)

    try:
        extract_package(source, work_dir)
        if verbose:
            print(f"  [extracted] {source}")

        xml_files = iter_xml_files(work_dir)
        palette = collect_palette(xml_files)
        color_map = explicit_colors if args.no_infer_colors else infer_color_map(palette, design, explicit_colors)

        theme_path = write_theme(work_dir, design)
        if verbose:
            print(f"  [theme]     {relpath(theme_path, work_dir)}")

        changed = 0
        for path in xml_files:
            if process_xml_file(path, design, color_map, font_map, args.display_threshold):
                changed += 1
                if verbose:
                    print(f"  [updated]   {relpath(path, work_dir)}")

        image_count = recolor_dark_images(work_dir, design, verbose=verbose) if args.recolor_dark_images else 0
        if image_count and verbose:
            print(f"  [images]    recolored {image_count} media file(s)")

        pack_package(work_dir, output)
        if verbose:
            print_audit(work_dir, design, palette, color_map, changed, len(xml_files), output)
    finally:
        if temp_context and not args.keep_work_dir:
            temp_context.cleanup()


def print_audit(
    work_dir: Path,
    design: DesignSystem,
    original_palette: dict[str, int],
    color_map: dict[str, str],
    changed: int,
    total_xml_files: int,
    output: Path,
) -> None:
    print(f"\n  {changed} of {total_xml_files} XML file(s) updated")
    print("\n  Color mapping:")
    for old, count in sorted(original_palette.items(), key=lambda item: (-item[1], item[0])):
        new = color_map.get(old, old)
        label = next((name for name, value in design.colors.items() if value == new), "inferred")
        print(f"    {count:>4}x  #{old} -> #{new}  ({label})")

    final_fonts = collect_fonts(iter_xml_files(work_dir))
    print("\n  Final font usage:")
    for font, count in sorted(final_fonts.items(), key=lambda item: (-item[1], item[0])):
        print(f"    {count:>4}x  {font}")

    print(f"\n  Output: {output}\n")


if __name__ == "__main__":
    main()
