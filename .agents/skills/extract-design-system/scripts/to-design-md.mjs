#!/usr/bin/env node
/**
 * to-design-md.mjs — Convert raw extraction JSON to DESIGN.md YAML frontmatter
 *
 * Usage:
 *   node scripts/extract-web.mjs https://example.com \
 *     | node scripts/to-design-md.mjs --name "Acme" > DESIGN.md
 *
 *   # Full pipeline with color dedup:
 *   node scripts/extract-web.mjs https://example.com > raw.json
 *   python3 scripts/dedupe-colors.py < <(node -e "
 *     const r = JSON.parse(require('fs').readFileSync('raw.json'));
 *     console.log(JSON.stringify(r.hardcodedHex))") > colors.json
 *   node scripts/to-design-md.mjs --name "Acme" --colors colors.json < raw.json
 *
 * Input:  JSON from extract-web.mjs or scan-codebase.mjs (stdin)
 * Output: DESIGN.md with YAML frontmatter written to stdout
 *         (redirect to DESIGN.md or let the agent write it)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, def = null) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const brandName = getArg("--name", "Brand");
const colorsFile = getArg("--colors", null);
const outputFile = getArg("--out", null);

// ── Read input ─────────────────────────────────────────────────────────────

// Read JSON from --input flag (for Windows compat) or stdin
const inputFile = getArg("--input", null);

let raw;
try {
  let src;
  if (inputFile) {
    src = readFileSync(inputFile, "utf-8");
  } else {
    // Cross-platform stdin read
    src = readFileSync(
      process.platform === "win32" ? "\\\\.\\CONIN$" : "/dev/stdin",
      "utf-8",
    );
  }
  raw = JSON.parse(src);
} catch {
  console.error(
    "Could not read JSON. Use: node to-design-md.mjs --input raw.json  OR pipe via stdin on Unix.",
  );
  process.exit(1);
}

let deduped = null;
if (colorsFile && existsSync(colorsFile)) {
  try {
    deduped = JSON.parse(readFileSync(colorsFile, "utf-8"));
  } catch {
    /* ignore */
  }
}

// ── Tailwind scale maps ────────────────────────────────────────────────────

const TW_SIZE_TO_REM = {
  "text-xs": 0.75,
  "text-sm": 0.875,
  "text-base": 1,
  "text-lg": 1.125,
  "text-xl": 1.25,
  "text-2xl": 1.5,
  "text-3xl": 1.875,
  "text-4xl": 2.25,
  "text-5xl": 3,
  "text-6xl": 3.75,
  "text-7xl": 4.5,
  "text-8xl": 6,
  "text-9xl": 8,
};

const TW_SPACING = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  3.5: 14,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  11: 44,
  12: 48,
  14: 56,
  16: 64,
  20: 80,
  24: 96,
  28: 112,
  32: 128,
};

const TW_ROUNDED = {
  "rounded-none": "0",
  "rounded-sm": "0.125rem",
  rounded: "0.25rem",
  "rounded-md": "0.375rem",
  "rounded-lg": "0.5rem",
  "rounded-xl": "0.75rem",
  "rounded-2xl": "1rem",
  "rounded-3xl": "1.5rem",
  "rounded-full": "9999px",
  "rounded-4xl": "9999px",
};

// ── Extract usable data from raw JSON ─────────────────────────────────────

function inferColors(raw, deduped) {
  if (deduped && deduped.length) {
    return deduped.reduce((acc, c) => {
      const key = c.name.toLowerCase().replace(/\s+/g, "-");
      acc[key] = c.hex;
      return acc;
    }, {});
  }

  // Fallback: map semantic CSS vars if present
  const vars = raw.cssVars ?? {};
  const colors = {};

  const semanticMap = [
    ["background", ["--background", "--bg", "--color-background"]],
    [
      "foreground",
      ["--foreground", "--fg", "--color-foreground", "--on-surface"],
    ],
    [
      "primary",
      ["--primary", "--color-primary", "--brand-primary", "--accent"],
    ],
    ["primary-foreground", ["--primary-foreground", "--on-primary"]],
    ["secondary", ["--secondary", "--color-secondary"]],
    ["secondary-foreground", ["--secondary-foreground", "--on-secondary"]],
    ["muted", ["--muted", "--color-muted", "--surface-variant"]],
    ["muted-foreground", ["--muted-foreground", "--color-muted-foreground"]],
    ["card", ["--card", "--color-card", "--surface"]],
    ["card-foreground", ["--card-foreground", "--on-card"]],
    ["border", ["--border", "--color-border", "--outline"]],
    ["ring", ["--ring", "--color-ring", "--focus-ring"]],
    ["destructive", ["--destructive", "--color-error", "--error"]],
    ["destructive-foreground", ["--destructive-foreground", "--on-error"]],
  ];

  for (const [name, candidates] of semanticMap) {
    for (const key of candidates) {
      if (vars[key]) {
        colors[name] = vars[key].trim();
        break;
      }
    }
  }

  // Pull hex values directly from hardcoded list if vars are empty
  if (Object.keys(colors).length < 3 && raw.hardcodedHex?.length) {
    raw.hardcodedHex.slice(0, 10).forEach((hex, i) => {
      colors[`color-${i + 1}`] = hex;
    });
  }

  return colors;
}

function inferTypography(raw) {
  const scale = {};
  const tw = raw.tailwind ?? {};
  const sizes = [
    ...new Set(
      (tw.typography?.size ?? []).map((c) => c.replace(/^[a-z]+:/, "")),
    ),
  ];

  // Find the largest size used — assume that's the display
  const sizeOrder = Object.keys(TW_SIZE_TO_REM);
  const usedSizes = sizes
    .map((s) => s.replace(/^.*:/, "")) // strip modifiers
    .filter((s) => TW_SIZE_TO_REM[s])
    .sort((a, b) => TW_SIZE_TO_REM[b] - TW_SIZE_TO_REM[a]);

  const fontClasses = [
    ...new Set(
      (tw.typography?.font ?? []).map((c) => c.replace(/^[a-z]+:/, "")),
    ),
  ];
  const fonts = fontClasses.filter((c) =>
    /^font-(?!bold|medium|semibold|light|thin|normal|extrabold|black|sans|serif|mono)/.test(
      c,
    ),
  );

  // Leading values used
  const leadings = [
    ...new Set(
      (tw.typography?.leading ?? []).map((c) => c.replace(/^[a-z]+:/, "")),
    ),
  ];

  // Build type roles from the size spread
  const roles = [
    { key: "display-xl", label: "Hero / display XL", idx: 0 },
    { key: "display-lg", label: "Display LG", idx: 1 },
    { key: "headline-md", label: "Section heading", idx: 2 },
    { key: "title-lg", label: "Card title", idx: 3 },
    { key: "body-base", label: "Body text", idx: 4 },
    { key: "label-sm", label: "Label / caption", idx: 5 },
  ];

  for (const role of roles) {
    const twClass = usedSizes[role.idx];
    if (!twClass) continue;
    const rem = TW_SIZE_TO_REM[twClass];
    scale[role.key] = {
      fontSize: `${rem}rem`,
      fontWeight: role.idx < 2 ? "400" : role.idx < 4 ? "500" : "400",
      lineHeight:
        role.idx < 2
          ? `${(rem * 0.95).toFixed(2)}rem`
          : `${(rem * 1.3).toFixed(2)}rem`,
      letterSpacing: role.idx < 3 ? "-0.02em" : "0",
      // Font family placeholder — agent fills in from font detection
      fontFamily: "[infer from fonts]",
    };
  }

  return { scale, detectedFontClasses: fonts, leadings };
}

function inferSpacing(raw) {
  const tw = raw.tailwind ?? {};
  const gaps = (tw.spacing?.gap ?? [])
    .map((c) => c.replace(/^[a-z]+:/, "").replace("gap-", ""))
    .filter((v) => TW_SPACING[v])
    .map((v) => TW_SPACING[v]);

  const paddings = (tw.spacing?.padding ?? [])
    .map((c) => c.replace(/^[a-z]+:/, "").match(/(?:py|px|p)-(\d+\.?\d*)/)?.[1])
    .filter(Boolean)
    .map((v) => TW_SPACING[v])
    .filter(Boolean);

  const allValues = [...new Set([...gaps, ...paddings])].sort((a, b) => a - b);
  const unit = allValues[0] ?? 4;

  return {
    unit: `${unit}px`,
    xs: `${unit}px`,
    sm: `${unit * 2}px`,
    md: `${unit * 4}px`,
    lg: `${unit * 6}px`,
    xl: `${unit * 8}px`,
    "2xl": `${unit * 16}px`,
    gutter: `${unit * 4}px`,
  };
}

function inferRounded(raw) {
  const tw = raw.tailwind ?? {};
  const found = [
    ...new Set(
      (tw.effects?.rounded ?? []).map((c) => c.replace(/^[a-z]+:/, "")),
    ),
  ];
  const out = {};
  for (const cls of found) {
    const val = TW_ROUNDED[cls];
    if (val) {
      const key = cls.replace("rounded-", "") || "DEFAULT";
      out[key] = val;
    }
  }
  if (!out.full && found.some((c) => c.includes("full") || c.includes("4xl")))
    out.full = "9999px";
  if (!out.DEFAULT) out.DEFAULT = "0.25rem";
  return out;
}

// ── YAML serialiser (no deps) ──────────────────────────────────────────────

function toYaml(obj, indent = 0) {
  const pad = " ".repeat(indent);
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      out += `${pad}${k}:\n${toYaml(v, indent + 2)}`;
    } else if (Array.isArray(v)) {
      out += `${pad}${k}:\n${v.map((i) => `${pad}  - ${i}`).join("\n")}\n`;
    } else {
      const val =
        typeof v === "string" &&
        (v.startsWith("#") || v.includes(" ") || v.includes(":"))
          ? `'${v}'`
          : v;
      out += `${pad}${k}: ${val}\n`;
    }
  }
  return out;
}

// ── Build the DESIGN.md ────────────────────────────────────────────────────

function buildDesignMd(raw, deduped) {
  const colors = inferColors(raw, deduped);
  const { scale, detectedFontClasses, leadings } = inferTypography(raw);
  const spacing = inferSpacing(raw);
  const rounded = inferRounded(raw);

  const frontmatter = {
    name: brandName,
    colors,
    typography: scale,
    rounded,
    spacing,
  };

  const stack = raw.stack ?? {};
  const meta = raw.meta ?? {};
  const fonts = (raw.fonts ?? [])
    .map((f) => f.family ?? f.url ?? "")
    .filter(Boolean);

  const stackNotes =
    Object.entries(stack)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "unknown";

  const fontNotes = fonts.length
    ? fonts.slice(0, 4).join(", ")
    : detectedFontClasses.length
      ? detectedFontClasses.join(", ")
      : '[fonts not detected — check <link rel="preload"> or @font-face rules]';

  const colorCount = Object.keys(colors).length;
  const hexList = deduped
    ? deduped.map((c) => `- **${c.name}** \`${c.hex}\` — ${c.role}`).join("\n")
    : Object.entries(colors)
        .map(([k, v]) => `- **${k}** \`${v}\``)
        .join("\n");

  const inferred =
    colorCount < 3
      ? "\n> ⚠️ **Few colors detected.** Semantic token values may require runtime resolution. Values marked `[inferred]` are framework defaults — verify against the live site.\n"
      : "";

  return `---
${toYaml(frontmatter)}---

<!-- AUTO-GENERATED by to-design-md.mjs — fill in prose sections below -->
<!-- Stack detected: ${stackNotes} -->
<!-- Fonts detected: ${fontNotes} -->
<!-- Source: ${raw.url ?? raw.root ?? "unknown"} -->

## Brand & Style

[TODO: 2-paragraph editorial description of the brand's mood, philosophy, and visual personality.
What does the design communicate? What feeling does it create?]

## Colors
${inferred}
${hexList}

[TODO: Group by function. Describe each color's character and intended role, not just its value.]

## Typography

**Fonts detected:** ${fontNotes}

[TODO: Describe each font family — its character, what it communicates. Then document the full type hierarchy:
display, headline, body, label sizes with font-size, weight, line-height, letter-spacing.]

## Layout & Spacing

**Spacing unit:** ${spacing.unit}

[TODO: Document the grid system, max content width, section rhythm, responsive breakpoints,
whitespace philosophy, and touch-target sizing.]

## Elevation & Depth

[TODO: How is depth communicated? Shadows? Glassmorphism/blur? Border opacity? Flat?
Document the exact treatment and when each level is used.]

## Shapes

[TODO: Document the border-radius language. What does it communicate? Buttons vs cards vs chips.
Note the full range from pill to square.]

## Components

### Buttons
[TODO]

### Cards
[TODO]

### Navigation
[TODO]

### Inputs & Forms
[TODO]

### Domain-Specific Components
[TODO: 1-2 components unique to this product]
`;
}

// ── Main ───────────────────────────────────────────────────────────────────

const md = buildDesignMd(raw, deduped);

if (outputFile) {
  const dir = outputFile.split("/").slice(0, -1).join("/");
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputFile, md, "utf-8");
  console.error(`Written to ${outputFile}`);
} else {
  process.stdout.write(md);
}
