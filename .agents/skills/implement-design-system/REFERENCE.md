# Reference — implement-design-system

Deterministic behavior of `scripts/apply_design.py`. Everything here is derived from the script; when in doubt, the script is the source of truth.

## DESIGN.md schema

YAML frontmatter between `---` fences. Only `colors:` is required for color work; `typography:` drives fonts, tracking, and line spacing.

```yaml
---
name: BrandName            # optional; used as theme name (defaults to file stem)
colors:
  background: '#FBF9F6'    # 6-digit hex, with or without quotes/#
  on-surface: '#16100E'
  primary: '#314163'
  outline: 'rgba(22,16,14,0.12)'   # rgba() is composited over `background` to flat hex
typography:
  display-xl:              # style key (see font selection below)
    fontFamily: DM Serif Text
    fontSize: 4.5rem       # rem only; 1rem ≡ 12 pt in PPTX terms
    fontWeight: '400'
    lineHeight: 0.95       # unitless multiplier
    letterSpacing: -0.06em # em, or bare float
---
```

Parsing constraints (regex-based, not a YAML library):

- Exactly 2-space indent for color keys and typography style keys; 4-space indent for typography fields.
- Colors must be 6-digit hex or `rgba(r,g,b,a)`. 3-digit hex, `hsl()`, named colors are **ignored silently**.
- `rgba()` values are alpha-composited over the `background` (or `surface`) color already parsed above them — order matters; define `background` first.
- A typography entry without `fontFamily` is dropped.
- Other frontmatter sections (`rounded:`, `spacing:`…) are ignored — harmless to keep.

## Color token fallback chains

The script resolves semantic roles by trying token names in order (first hit wins):

| Role | Token names tried, in order | Final fallback |
|---|---|---|
| background | `background`, `surface`, `white` | `FFFFFF` |
| surface_dim | `surface-dim`, `surface-container`, `secondary`, `surface` | background |
| ink (text) | `on-surface`, `foreground`, `black` | `111111` |
| muted | `on-surface-variant`, `muted-foreground`, `foreground-muted` | ink |
| primary | `primary`, `accent`, `brand` | ink |
| on_primary | `on-primary`, `white`, `background` | background |
| error | `error`, `destructive` | primary |
| outline | `outline`, `border`, `outline-variant` | muted |
| display font | first of `display-xl`, `display-lg`, `headline-md`, `headline`, `h1` | Georgia |
| body font | first of `body-base`, `body`, `body-lg`, `label-sm` | Arial |

Implication: a DESIGN.md using only shadcn-style names (`foreground`, `accent`, `destructive`, `border`) works unmodified.

## CLI reference

```
python apply_design.py INPUT [-d DESIGN.md] [-o OUTPUT] [flags]
```

| Flag | Default | Effect |
|---|---|---|
| `INPUT` (positional) | `Modele_SCIAM_avec_layouts.potx` | `.potx` or `.pptx` to convert — always pass explicitly |
| `-d, --design` | `DESIGN.md` | Path to the design token file |
| `-o, --output` | `<stem>_DESIGN<ext>` | Output path; existing file is replaced |
| `--color-map OLD=TOKEN_OR_HEX ...` | none | Explicit per-color overrides; `OLD` is 6-digit hex (no `#`), target is a DESIGN.md token name or hex. Wins over inference. |
| `--font-map "OLD=NEW" ...` | none | Explicit font replacements (case-insensitive on OLD). Wins over size-based selection. |
| `--display-threshold N` | `2800` | OOXML size units (1/100 pt) at/above which the display font + bold-stripping applies. 2800 = 28 pt. |
| `--no-infer-colors` | off | Only apply `--color-map` entries; skip brightness/chroma classification |
| `--recolor-dark-images` | off | Repaint near-black pixels (R<90, G<95, B<110) of PNG/JPG media to `on-primary`. Requires Pillow; skips with a warning otherwise. |
| `--work-dir DIR` / `--keep-work-dir` | temp dir | Extract location; keep it to inspect the rewritten XML |
| `--quiet` | off | Suppress per-file logs and the audit |

## What the script rewrites

| Target | Files | Transformation |
|---|---|---|
| Theme | `ppt/theme/theme1.xml` (overwritten) | New `clrScheme` + `fontScheme` from tokens; Office-default `fmtScheme` |
| Literal colors | every `*.xml` in `ppt/slides`, `slideLayouts`, `slideMasters`, `notesMasters`, `notesSlides` | Each `val="RRGGBB"` / `lastClr="RRGGBB"` replaced via the color map |
| Fonts | same files | Inside each `<a:rPr>`/`<a:defRPr>`: `latin/ea/cs` typefaces → display or body font by size; theme fonts (`+mj-lt`, `+mn-lt`) preserved; on display-size runs `b="1"` is stripped |
| Tracking | same | `spc` set per run from the nearest typography style's `letterSpacing` (by fontSize distance), else built-in curve (≥32 pt → −0.06 em … <22 pt → 0) |
| Line height | masters/layouts list styles (`lvlNpPr`) | `<a:lnSpc><a:spcPct>` from nearest style's `lineHeight`, else built-in curve (40 pt → 95 % … 12 pt → 150 %) |
| Media (opt-in) | `ppt/media/*.png|jpg` | Dark pixels → `on-primary` (logo inversion for dark→light themes) |

Theme color-slot mapping: `dk1`=ink, `lt1`=background, `dk2`=primary, `lt2`=surface_dim, `accent1`=primary, `accent2`=muted, `accent3`=surface_dim, `accent4`=ink, `accent5`=error, `accent6`=outline, `hlink`=primary, `folHlink`=muted.

## Color classification (inference rules)

Each source color already equal to a DESIGN.md value is kept. Otherwise it's converted to HLS and classified top-down (L=lightness 0–1, S=saturation, H=hue°):

| Rule (first match wins) | Mapped to |
|---|---|
| L ≥ 0.96 | background |
| L ≥ 0.84 | surface_dim |
| L ≤ 0.24 | ink |
| H ≤ 18° or H ≥ 345°, S ≥ 0.45, L < 0.72 | error |
| S ≤ 0.18 and L < 0.45 | muted |
| S ≤ 0.18 and L < 0.78 | outline |
| S ≤ 0.18 (lighter) | surface_dim |
| anything else (saturated mid-tone) | primary |

Known misfire modes — audit for these every run:

- **Orange/warm brand colors** land in `error` (hue ≤ 18°). Override: `--color-map FF6B35=primary`.
- **Multiple saturated brand hues** (blue + green + purple) all collapse to `primary`. Override each.
- **Dark brand colors** (navy `1A2B4C`, L ≤ 0.24) become `ink` instead of `primary`.

## Size unit conversions

- OOXML `sz` is 1/100 pt: `sz="2800"` = 28 pt.
- rem↔pt bridge: 1 rem = 12 pt (so `fontSize: 3rem` matches 36 pt runs).
- Tracking: `spc` = letterSpacing(em) × pt × 100. Line spacing: `spcPct val` = lineHeight × 100000.
