---
name: extract-design-system
description: >-
  Extract a comprehensive design system from any source — live website URL,
  frontend codebase (React, Vue, Svelte, Angular, plain HTML/CSS), Figma link,
  or PPTX slide deck. Produces a structured DESIGN.md with YAML token frontmatter
  and optionally a full design system folder (CSS token files, React components,
  UI kit HTML). Use this skill whenever the user wants to reverse-engineer or
  document a brand's visual language — even if they just say "what does this site
  look like?", "pull the design from this repo", or "extract our brand from this
  deck".
user-invocable: true
allowed-tools:
  - "Bash"
  - "Read"
  - "Write"
  - "Glob"
  - "Grep"
  - "web_fetch"
  - "stitch*:*"
---

# Extract Design System

> **TL;DR — fastest path to a DESIGN.md:**
> ```bash
> # Web URL
> node .agents/skills/extract-design-system/scripts/extract-web.mjs https://example.com \
>   | node .agents/skills/extract-design-system/scripts/to-design-md.mjs --name "Brand" \
>   --out DESIGN.md
>
> # Local codebase
> node .agents/skills/extract-design-system/scripts/scan-codebase.mjs ./my-project \
>   | node .agents/skills/extract-design-system/scripts/to-design-md.mjs --name "Brand" \
>   --out DESIGN.md
> ```
> The scripts produce a scaffold with YAML frontmatter pre-filled. Your job is then to **enrich the prose sections** and verify inferred values.

Reverse-engineer a complete design system from any input source and produce:

- **DESIGN.md** — structured token file (YAML frontmatter) + editorial prose describing the visual language
- **tokens/** — CSS custom properties, one file per concern *(optional, "full system" mode)*
- **components/** — React UI primitives with props contracts *(optional, "full system" mode)*
- **ui_kits/** — full-screen HTML recreations of key product views *(optional, "full system" mode)*

---

## When to Use

- User provides a website URL and wants to extract its design language
- User has a frontend codebase and wants to document or migrate its design system
- User wants a DESIGN.md for use with Stitch or another design tool
- User wants to audit visual consistency across a project
- User provides a Figma link and wants design tokens extracted
- User provides a PPTX and wants brand tokens extracted
- User says "what does this look like?", "extract the design", "document the brand"

**Quick mode** (default): Produces DESIGN.md only — stops after Phase 3.  
**Full system mode**: Produces DESIGN.md + token files + components + UI kit — run all phases. Activate when user says "full design system", "build a design system", "I want components too."

---

## Scripts Reference

Four scripts live in `scripts/`. Run them via the `Bash` tool. They require **Node.js 18+** and **Python 3.8+** — no `npm install` needed.

| Script | Language | Purpose | Input | Output |
|:---|:---|:---|:---|:---|
| `extract-web.mjs` | Node.js | Fetch a URL, follow linked stylesheets, extract design signals **actually used on the page** | URL arg | JSON |
| `scan-codebase.mjs` | Node.js | Scan a local repo for CSS vars, Tailwind config, token files, fonts | path arg | JSON |
| `dedupe-colors.mjs` | Node.js | Cluster near-duplicate colors by ΔE perceptual distance; suggest names & roles | JSON array of hex strings (stdin) | JSON array of color objects |
| `dedupe-colors.py` | Python | Same as above — richer naming, requires Python 3.8+ | JSON array of hex strings (stdin) | JSON array of color objects |
| `to-design-md.mjs` | Node.js | Convert extraction JSON to DESIGN.md with YAML frontmatter scaffold | JSON (via `--input`) + CLI flags | DESIGN.md text |

> **Python availability:** `dedupe-colors.py` and `dedupe-colors.mjs` produce identical output. Use `.mjs` if Python 3 is unavailable (default on Windows without explicit install).

### Used-only extraction (web source)

`extract-web.mjs` reports only tokens the fetched page **actually uses** — declared-but-unused tokens are dropped:

- **CSS vars** count as used only if referenced from a *live* CSS rule (a rule whose selector classes appear in the page markup; selectors with no class like `:root`/`body` always apply), from an inline `style=""` attribute, or transitively through another used var (`--background: var(--_ivory)` keeps `--_ivory`). This eliminates the entire injected Tailwind v4 default palette (`--color-emerald-300` etc.) unless the page genuinely uses those utilities.
- **Fonts** are kept only if their family appears in a `font-family` declaration in the page or its stylesheets (`@font-face` rules in linked CSS are scanned — covers `next/font`). Preload-only entries are kept.
- **Assets** are deduplicated, resolved to absolute URLs, and exclude `data:` URIs and fragment-only SVG sprite refs.
- The output includes `declaredVarCount` / `usedVarCount` so you can sanity-check the filtering. If **zero** live references are found (stylesheets unreachable, runtime-injected styles), the script falls back to keeping all non-Tailwind-palette vars — treat colors as `[inferred — verify]` in that case.

The liveness analysis is static (single page, no JS execution). Tokens used only on other pages or behind interactions won't appear — extract additional URLs and merge if you need site-wide coverage.

### Pipelines

**Quick extract — web URL:**
```bash
SKILL=".agents/skills/extract-design-system/scripts"
WORK="/tmp/ds-extract"  # or any writable temp dir
mkdir -p $WORK

node $SKILL/extract-web.mjs https://example.com > $WORK/raw.json
node $SKILL/to-design-md.mjs --name "Brand" --input $WORK/raw.json --out DESIGN.md
```

**With color deduplication (recommended for sites with 5+ colors):**
```bash
SKILL=".agents/skills/extract-design-system/scripts"
WORK="/tmp/ds-extract"
mkdir -p $WORK

node $SKILL/extract-web.mjs https://example.com > $WORK/raw.json
node -e "
  const r = JSON.parse(require('fs').readFileSync(process.argv[1]));
  const hexes = [...new Set([
    ...Object.values(r.cssVars).filter(v => typeof v === 'string' && v.startsWith('#')),
    ...(r.hardcodedHex || [])
  ])];
  console.log(JSON.stringify(hexes));
" $WORK/raw.json | python3 $SKILL/dedupe-colors.py > $WORK/colors.json
node $SKILL/to-design-md.mjs --name "Brand" --input $WORK/raw.json --colors $WORK/colors.json --out DESIGN.md
```

**Local codebase:**
```bash
SKILL=".agents/skills/extract-design-system/scripts"
WORK="/tmp/ds-extract"
mkdir -p $WORK

node $SKILL/scan-codebase.mjs ./path/to/project > $WORK/raw.json
node $SKILL/to-design-md.mjs --name "Brand" --input $WORK/raw.json --out DESIGN.md
```

**`to-design-md.mjs` flags:**
| Flag | Default | Description |
|:---|:---|:---|
| `--name "Brand"` | `"Brand"` | Sets the `name:` field in YAML frontmatter |
| `--input raw.json` | stdin | Path to raw extraction JSON (required on Windows; optional on Unix) |
| `--colors file.json` | none | Path to `dedupe-colors.py` output — used instead of raw hex list |
| `--out path/to/DESIGN.md` | stdout | Write output to file instead of stdout |

> **Windows note:** Pipe-based stdin (`|`) is unreliable on Windows. Always use `--input` flag with a temp file path instead of piping directly.

### What the scripts do NOT replace

The scripts produce a **scaffold** — YAML frontmatter with detected tokens and empty prose sections marked `[TODO]`. You must still:
- Fill in the "Brand & Style", "Colors", "Typography" etc. prose sections with editorial language
- Verify all values marked `[inferred — verify]`
- Add domain-specific component documentation
- Replace `[infer from fonts]` placeholders with actual font names from the fonts array

---

## Phase 0: Input Detection

Identify your source type before doing anything else.

| Input signal | Source type | Reference to read |
|:---|:---|:---|
| URL starting with `http` | Live website | [references/web-url.md](references/web-url.md) |
| Local directory path / repo | Codebase | Detect framework → see table below |
| `figma.com/file/...` link | Figma | Use `get_design_context` MCP tool |
| `.pptx` / `.ppt` file | Slide deck | Use repl to parse; extract text + images |
| Mix of the above | Multi-source | Process each; merge tokens; flag conflicts |

**Codebase framework detection:**

| File present | Framework | Reference |
|:---|:---|:---|
| `tailwind.config.*` + React | React/Next.js + Tailwind | [references/react-tailwind.md](references/react-tailwind.md) |
| `package.json` → `vue` | Vue / Nuxt | [references/vue.md](references/vue.md) |
| `package.json` → `svelte` | Svelte / SvelteKit | [references/svelte.md](references/svelte.md) |
| `package.json` → `@angular/core` | Angular | [references/angular.md](references/angular.md) |
| `.css` / `.scss` only | Plain CSS/SASS | [references/plain-css.md](references/plain-css.md) |

**Read the matching reference file before proceeding to Phase 1.**

**Stop conditions** — halt and ask the user before continuing if:
- A URL is provided but `web_fetch` returns an error or empty body
- A codebase path is given but no files are readable via `Read`/`Glob`
- A Figma link is provided but `get_design_context` is unavailable or returns an error
- A PPTX is provided but the repl tool cannot parse it

Do NOT spend time generating a design system from incomplete inputs.

---

## Phase 1: Project Discovery

**First: run the appropriate script to get a raw token dump.** Use its output throughout Phases 1-2 rather than manually grepping files.

```bash
SKILL=".agents/skills/extract-design-system/scripts"
WORK="/tmp/ds-extract" && mkdir -p $WORK

# Web source
node $SKILL/extract-web.mjs <url> > $WORK/raw.json

# Codebase source
node $SKILL/scan-codebase.mjs <path> > $WORK/raw.json
```

Then read `/tmp/raw.json` to answer:

1. **Stack** — check `raw.stack` to confirm framework. This determines which reference file to consult.
2. **Brand & product context** — read `raw.meta.title`, `raw.meta.description`, `raw.meta.ogImage`. Visit the URL or read entry files for product copy, hero text, taglines.
3. **Products represented** — Homepage? Web app? Mobile? Docs? Each product may need its own UI kit later.
4. **Existing design system signals** — check `raw.stack.styleDictionary`, `raw.stack.shadcn`, `raw.stack.chakra`, `raw.stack.mui`, etc. Check `raw.tokenFiles` keys for token library usage.
5. **Visual mood** — describe the overall feel in 1-2 sentences before reading any token values. Revise after Phase 2.

Record your findings — they become the "Visual Theme & Atmosphere" section of DESIGN.md.

---

## Phase 2: Deep Extraction

**Start from the script output in `/tmp/raw.json`.** Use it as the primary data source. Only read individual files when the script output is ambiguous or missing values.

**Run color deduplication before documenting colors:**
```bash
SKILL=".agents/skills/extract-design-system/scripts"
WORK="/tmp/ds-extract"
node -e "
  const r = JSON.parse(require('fs').readFileSync(process.argv[1]));
  const hexes = [...new Set([
    ...Object.values(r.cssVars).filter(v => typeof v === 'string' && v.startsWith('#')),
    ...(r.hardcodedHex || [])
  ])];
  console.log(JSON.stringify(hexes));
" $WORK/raw.json | python3 $SKILL/dedupe-colors.py > $WORK/colors.json
```
The `colors.json` output gives you named, deduplicated colors with suggested roles — use it to populate the Colors section directly.

Work through each dimension systematically. For every token you find, record:
- The raw value (hex, rem, etc.)
- The semantic role (what is it used FOR?)
- The source (CSS var, Tailwind class, inline style, etc.)

### 2.1 Colors

Search across all layers in priority order:

| Priority | Source | What to look for |
|:---|:---|:---|
| 1 (highest) | CSS `:root` block | `--color-*`, `--primary`, `--bg-*`, `--fg-*` |
| 2 | Tailwind config | `theme.extend.colors`, `theme.colors` |
| 3 | Theme / token files | Any file named `theme.*`, `tokens.*`, `colors.*` |
| 4 | Component styles | `background-color`, `color`, `border-color` values |
| 5 | Inline / scoped | `bg-*`, `text-*`, `border-*` utility classes |
| 6 | Figma variables | `get_variable_defs` → expand color variables |

**Group colors by function, not by hue:**
1. **Surface Foundation** — background, card, muted surfaces
2. **Text & Foreground** — primary, secondary, tertiary text
3. **Accent & Interactive** — CTA buttons, active states, links, focus rings
4. **Functional States** — success, error, warning, info

**Name colors descriptively, not by raw value:**
- ❌ `#294056` → "Blue"
- ✅ `#294056` → **"Deep Muted Teal-Navy"** — Primary CTA, active navigation

**Deduplicate.** Near-duplicates (`#333` and `#2C2C2C`) → consolidate under the dominant token.

**Flag inferred values.** If you resolved a semantic token from framework defaults rather than actual source, append `[inferred — verify]`.

### 2.2 Typography

| What to extract | Where to look |
|:---|:---|
| Font families | `font-family` in CSS, `fontFamily` in Tailwind config, `<link href="fonts.google...">`, `@font-face` declarations, preloaded WOFF2 files |
| Type scale | Every heading level (H1–H6) + body + label + caption: `font-size`, `font-weight`, `line-height`, `letter-spacing` |
| Font character | Describe it: geometric/humanist, serif/sans, what mood it evokes |
| Usage mapping | Which font at which size is used for hero, card titles, body, labels, captions? |

For each type style, describe the *intent*:
- Tight tracking on headings → authority, compactness
- Generous line-height on body → readability, breathing room
- ALL CAPS + wide tracking on labels → structure, hierarchy

### 2.3 Spacing

| What to extract | Where to look |
|:---|:---|
| Base unit | CSS `--spacing-*`, Tailwind `spacing` config, or smallest repeated gap value |
| Section rhythm | `padding-top/bottom` on section/page elements; `gap` on layout grids |
| Component padding | `padding` on cards, buttons, inputs |
| Page margins | `padding-left/right` on outer wrapper at different breakpoints |
| Max content width | `max-width` on main container |

### 2.4 Shape & Depth

- **Border radius** — note every `border-radius` value and which components use it; describe the character (pill = playful, square = minimal, slight = professional)
- **Shadow strategy** — flat, hover-only, always elevated, glassmorphism/blur?
- **Border treatment** — hairline, colored accent, opacity-based, none?

### 2.5 Component Stylings

Analyze the 5-6 most important primitives. For each, note: shape, color scheme, states (hover/focus/active/disabled), transitions, padding ratios.

**Always document:**
- Buttons (primary, secondary, ghost variants)
- Cards / Containers (shadow, radius, border, internal padding)
- Navigation (layout, typography treatment, active state)
- Inputs & Forms (border, focus state, corner consistency with buttons)
- Badges / Tags / Chips

**Plus 1-2 domain-specific components** unique to this product.

### 2.6 Layout Principles

- Max content width + grid system (CSS Grid, Flexbox, defined columns)
- Responsive breakpoints (from media queries or Tailwind config)
- Mobile-first vs desktop-first
- Whitespace strategy (section rhythm, edge padding at each breakpoint)
- Text alignment patterns (centered hero, left-aligned body?)
- Touch target sizing (min 44px? 48px for accessibility?)

### 2.7 Motion & Interaction (if present)

- Transition timing on hover states (`transition-colors`, `ease-in-out 150ms`)
- Animation patterns (marquee, fade, slide)
- Scroll behavior
- Glassmorphism / backdrop blur usage

---

## Phase 3: Write DESIGN.md

**Generate the scaffold first, then fill in prose:**

```bash
SKILL=".agents/skills/extract-design-system/scripts"
WORK="/tmp/ds-extract"
node $SKILL/to-design-md.mjs \
  --name "Brand Name" \
  --input $WORK/raw.json \
  --colors $WORK/colors.json \
  --out DESIGN.md
```

This produces `DESIGN.md` with:
- YAML frontmatter pre-populated from detected tokens
- All prose sections stubbed with `[TODO]` markers
- Inferred values flagged with `[inferred — verify]`
- A comment header listing detected stack, fonts, and source URL

**Then enrich the file:** Read `DESIGN.md` and replace every `[TODO]` with editorial prose. This is where the skill's value lives — the script gives structure, you give meaning.

Place the file at `DESIGN.md` (create the directory if needed).

> **REQUIRED:** The file MUST begin with YAML frontmatter containing at minimum `name` and `colors`. See `examples/DESIGN.md` for the full schema. Missing frontmatter = incomplete skill execution.

### YAML Frontmatter Schema

```yaml
---
name: [Brand Name]
colors:
  # Surface & background
  background: '#hex'
  surface: '#hex'
  surface-dim: '#hex'
  surface-container: '#hex'
  # Text / foreground
  on-surface: '#hex'
  on-surface-variant: '#hex'
  # Accent / primary
  primary: '#hex'
  on-primary: '#hex'
  primary-container: '#hex'
  # Secondary
  secondary: '#hex'
  on-secondary: '#hex'
  # Functional states
  error: '#hex'
  on-error: '#hex'
  # Borders / outlines
  outline: '#hex'
  outline-variant: '#hex'
typography:
  display-lg:
    fontFamily: [Family]
    fontSize: [px]
    fontWeight: '[weight]'
    lineHeight: [px]
    letterSpacing: [em or 0]
  # ... repeat for headline-md, body-base, label-caps, etc.
rounded:
  sm: [rem]
  DEFAULT: [rem]
  lg: [rem]
  full: 9999px
spacing:
  unit: [px]
  xs: [px]
  sm: [px]
  md: [px]
  lg: [px]
  xl: [px]
  gutter: [px]
  margin-mobile: [px]
  margin-desktop: [px]
---
```

### Markdown Sections (after frontmatter)

```markdown
## Brand & Style
[2 paragraphs: overall mood, philosophy, key visual characteristics. Editorial voice.]

## Colors
[Group by function. Describe each color's character and role, not just its hex value.]

## Typography
[Font families + their character. Full type hierarchy. Spacing principles.]

## Layout & Spacing
[Grid model, spacing rhythm, whitespace philosophy, responsive behavior.]

## Elevation & Depth
[Shadow/blur/border strategy. How depth is communicated.]

## Shapes
[Corner radius language, what it communicates. Button vs card vs indicator.]

## Components
### Buttons
### Cards & Modals
### Navigation
### Inputs & Forms
### [Domain-Specific Component 1]
### [Domain-Specific Component 2]
```

Use editorial language throughout — write like a design specification, not a CSS dump. The test: could a designer read this and recreate the visual feel without seeing the original?

---

## Phase 4: Write Token Files *(full system mode only)*

Create `tokens/` at the project root (or inside the design system folder):

```
tokens/
├── colors.css
├── typography.css
├── spacing.css
└── effects.css     ← shadows, radii, blur
```

**Each file:** CSS custom properties on `:root`. Base values + semantic aliases.

```css
/* tokens/colors.css */
:root {
  /* Base */
  --color-navy-900: #1a1a2e;
  /* Semantic */
  --color-primary: var(--color-navy-900);
  --color-surface: #ffffff;
}
```

**Root `styles.css`** at project root — `@import` lines only, no inline rules:

```css
@import './tokens/colors.css';
@import './tokens/typography.css';
@import './tokens/spacing.css';
@import './tokens/effects.css';
```

Copy any font files found into `assets/fonts/` and write `@font-face` rules in `tokens/typography.css`.

---

## Phase 5: Write Components *(full system mode only)*

Each component lives in `components/<group>/<Name>/`:

```
components/
├── core/
│   ├── Button/
│   │   ├── Button.jsx        ← named export, PascalCase, React only, uses CSS vars
│   │   ├── Button.d.ts       ← props interface
│   │   ├── Button.prompt.md  ← one-sentence what+when, JSX example, variants
│   │   └── buttons.card.html ← @dsCard tagged preview
```

**Component rules:**
- `export function Name(props) { ... }` — named export required
- Import React only; no npm packages; style via CSS custom properties from tokens
- `Name.d.ts` — props interface (gives bundler the contract)
- `Name.prompt.md` — first line = one sentence "what & when"; then JSX example; then variants

**Card HTML:**
```html
<!-- @dsCard group="Components" viewport="700x200" name="Buttons" -->
<!DOCTYPE html>...
```
Show all variants (primary/secondary/ghost, sizes, disabled, with icon). Dense and scannable.

---

## Phase 6: Write UI Kit *(full system mode only)*

For each product surface (marketing site, web app, docs, etc.):

```
ui_kits/<product>/
├── README.md         ← surface overview, screen list
├── index.html        ← interactive demo (fake navigation, real look)
├── HeroSection.jsx
├── NavBar.jsx
└── ...
```

**Rules:**
- Compose components from Phase 5; don't re-implement Button inside a kit
- Pixel-accurate recreation — use actual source/Figma as reference, not screenshots alone
- `index.html` must look like a real product view with fake interactions
- Tag with `<!-- @dsCard group="[Product]" viewport="[W]x[H]" -->`
- Do NOT invent new designs — replicate what exists

---

## Phase 7: Quality Gate

Before declaring done, verify all that applies to your output mode:

**DESIGN.md (all modes):**
- [ ] YAML frontmatter present with `name` and `colors` (minimum)
- [ ] Every color has: descriptive name, hex value, functional role
- [ ] Typography includes: font family, character description, full hierarchy
- [ ] Component styles describe: shape, color, states, transitions
- [ ] Layout includes: max-width, grid, breakpoints, spacing strategy
- [ ] Atmosphere section reads as editorial copy, not CSS listing
- [ ] Near-duplicate colors are consolidated
- [ ] Inferred/unverified values are flagged with `[inferred — verify]`
- [ ] Document captures design *intent*, not just raw values

**Full system mode (Phases 4-6):**
- [ ] `styles.css` contains only `@import` lines
- [ ] All colors reachable from `styles.css` via token files
- [ ] Every component has `.jsx` + `.d.ts` sibling (otherwise not indexed)
- [ ] Every component directory has a `@dsCard`-tagged card HTML
- [ ] UI kit `index.html` renders a recognizable product view
- [ ] No npm package imports in component `.jsx` files
- [ ] Font files copied to `assets/fonts/` or CDN link documented

---

## Error Handling

| Situation | Action |
|:---|:---|
| URL returns 403/404 | Stop. Ask user to provide a working URL or codebase instead. |
| URL returns content but no CSS classes or style blocks | Warn user. Proceed with what's visible; flag all values as `[inferred]`. |
| Codebase attached but files unreadable | Stop. Ask user to re-attach or provide the path. |
| Figma URL inaccessible | Stop. Ask user to verify access or provide screenshots + codebase. |
| PPTX unreadable by repl | Stop. Ask user to export slides as images and provide them. |
| Font files not in repo / CDN-only | Find nearest Google Fonts match. Flag substitution explicitly. |
| Semantic tokens found but no resolved hex values | Document tokens by name; flag that actual hex values need runtime resolution. Note the framework's default palette if known. |
| Multi-source conflict (e.g. Figma says blue, code says navy) | Document both. Note the discrepancy. Ask user which is authoritative. |

---

## Tips for Better Extraction

- **Read code comments.** `/* hero section — breathable */` is a designer's note about intent.
- **Theme files > component styles.** `theme.ts` tells you intent; scattered inline styles tell you what shipped. Start from the theme.
- **Tailwind config IS the design system.** Customized `tailwind.config.js` → extract it first, then spot-check components.
- **`--css-custom-properties` are intentional.** A developer who defined `--brand-primary` is telling you this is a token.
- **Figma variables > Figma styles > Figma layers.** Always expand variables and child components. Screenshots are lossy.
- **CDN fonts: check the weight list.** `?family=DM+Sans:wght@400;500;700` → only those weights are available.
- **Opacity variants are not new colors.** `bg-foreground/10` → extract `foreground`; note the 10% alpha usage separately.
- **Dark mode doubles the palette.** If dark mode classes exist, document both light and dark values.
