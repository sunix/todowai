---
name: implement-design-system
description: Apply a DESIGN.md design system (colors, typography) to PowerPoint .potx/.pptx files by rewriting the OOXML theme, recoloring every slide/layout/master, swapping fonts, and tuning letter-spacing and line-height. Use when the user wants to rebrand a PowerPoint template or deck, apply brand/design tokens to a .pptx/.potx, convert a deck to match a DESIGN.md, or says "apply design system", "rebrand this template", "theme this deck", "make this pptx match our brand". Do NOT use for authoring slide content (use the pptx skill) or for extracting a design system from code (use extract-design-md).
allowed-tools: Bash, PowerShell, Read, Write, Edit, Glob, Grep
user-invocable: true
---

# Implement Design System into PPTX

Transform any `.potx`/`.pptx` so its theme, colors, fonts, tracking, and line spacing match a `DESIGN.md` token file. The heavy lifting is done by the bundled deterministic script — your job is to validate inputs, run it, audit its color-mapping report, and fix misclassifications.

## When to use / when not to use

| Situation | Action |
|---|---|
| User has a .potx/.pptx + a DESIGN.md (or brand tokens) | **Use this skill** |
| User has a .potx/.pptx + a design source (website, codebase, Figma, branded deck) but no DESIGN.md | **Use this skill** — build DESIGN.md first (Phase 1) |
| User wants slides created, edited, or content extracted | Do not use — use the `pptx` skill |
| User wants a DESIGN.md extracted from frontend code only | Do not use — use `stitch-design:extract-design-md` |

## Workflow

### Phase 1 — Gather and validate inputs

1. Locate the input file. Must end in `.potx` or `.pptx`. If multiple candidates exist, ask which one (or pick the obvious template and say so).
2. Locate `DESIGN.md`. It MUST have YAML frontmatter with a `colors:` block (6-digit hex or `rgba()`) and ideally a `typography:` block. Full schema: [REFERENCE.md](REFERENCE.md#designmd-schema).
3. If no DESIGN.md exists, build one from whatever source the user has:

| Source | How to produce DESIGN.md |
|---|---|
| Frontend codebase | Invoke `stitch-design:extract-design-md` skill, then verify the frontmatter parses (hex colors, `fontFamily`/`fontSize`/`lineHeight`/`letterSpacing` per style) |
| Website URL | Fetch the page + linked CSS; extract background, text, accent, border colors and font stacks; author DESIGN.md per [EXAMPLES.md](EXAMPLES.md#minimal-designmd) |
| Figma | Ask user to export variables/styles (or use Figma MCP if connected); map color styles → tokens, text styles → typography entries |
| Existing branded PPTX | Unzip it; read `ppt/theme/theme1.xml` `<a:clrScheme>` and `<a:fontScheme>`; map dk1→on-surface, lt1→background, accent1→primary, etc. |

4. Validate before running: every color is 6-digit hex or rgba; token names use the recognized vocabulary (`background`, `on-surface`, `primary`, `on-primary`, `error`, `outline`, `surface-dim`, `muted-foreground`…). Unrecognized names silently fall back — see fallback chains in [REFERENCE.md](REFERENCE.md#color-token-fallback-chains).

### Phase 2 — First pass (inferred mapping)

Run the bundled script (use the absolute path to this skill's `scripts/` dir):

```bash
python "<skill_dir>/scripts/apply_design.py" "input.potx" -d "DESIGN.md" -o "output.potx"
```

The script extracts the OOXML package, rewrites `theme1.xml` from the tokens, replaces every literal color in slides/layouts/masters/notes using brightness/chroma classification, swaps fonts (display font ≥ 28 pt, body font below), applies letter-spacing and line-height derived from the typography scale, repacks, and prints an audit.

### Phase 3 — Audit the color mapping

Read the printed `Color mapping:` table (`Nx #OLD -> #NEW (token)`). Check every line, highest counts first, for misclassification:

- A brand/accent color mapped to `error` (red-hue heuristic misfire).
- Two semantically different source colors collapsed onto the same token.
- A logo/brand color that should have been preserved, remapped.

Fix with explicit overrides and re-run (explicit always wins over inference):

```bash
python "<skill_dir>/scripts/apply_design.py" "input.potx" -d "DESIGN.md" -o "output.potx" \
  --color-map 324B75=primary E8413C=error --font-map "Old Font=DM Sans"
```

Repeat until the mapping table is fully intentional. Use `--no-infer-colors` for strictly explicit conversions. All flags: [REFERENCE.md](REFERENCE.md#cli-reference).

### Phase 4 — Verify the output

Run each check; all must pass:

```bash
python -c "import zipfile; zipfile.ZipFile(r'output.potx').testzip() and exit(1); print('zip OK')"
```

1. **Zip integrity** — command above prints `zip OK`.
2. **No leftover source colors** — unzip output (or re-run with `--work-dir out_check --keep-work-dir`) and grep `ppt/slides ppt/slideLayouts ppt/slideMasters` for each old hex that was supposed to change: expect 0 matches.
3. **Fonts converged** — audit's `Final font usage:` lists only DESIGN.md fonts and `+mj-lt`/`+mn-lt` theme references.
4. **Theme correct** — `ppt/theme/theme1.xml` in the output contains dk1=on-surface, lt1=background, accent1=primary hex values.
5. If you cannot open PowerPoint to eyeball it, tell the user to open the file and check title slides + one content slide; flag that dark embedded images can be recolored with `--recolor-dark-images` (requires Pillow).

## Output specification

Deliverables, exactly:

1. **The themed file** — same extension as input; default name `<input-stem>_DESIGN.<ext>` unless the user named one. Never overwrite the input.
2. **A conversion report** (in your reply) containing: input → output paths; the final color mapping as a table `#OLD → #NEW (token, count)`; final font usage; any explicit `--color-map`/`--font-map` used (so the run is reproducible); verification results (zip OK, leftover-color grep count, theme check).

## Error handling

| Failure | Response |
|---|---|
| `No YAML frontmatter found` | DESIGN.md lacks `--- … ---` block. Show user the expected schema ([EXAMPLES.md](EXAMPLES.md)); offer to convert their file. |
| `Expected a 6-digit hex color` | A `--color-map` key or DESIGN.md value is malformed (3-digit hex, named color). Fix the value; rgba() is only valid inside DESIGN.md. |
| `Unknown DESIGN.md color token 'x'` | The `--color-map` target token isn't in DESIGN.md `colors:`. List available tokens and retry. |
| Input is `.ppt`/`.odp`/other | **Stop.** Script only handles `.potx`/`.pptx`. Ask user to convert (PowerPoint or LibreOffice `soffice --convert-to pptx`) first. |
| `PermissionError` writing output | File is open in PowerPoint. Ask user to close it, then re-run. |
| `Pillow not installed; skipped image recoloring` | Non-fatal. Offer `pip install Pillow` only if user wants `--recolor-dark-images`. |
| Audit shows 0 files updated | Palette/fonts already match, or the deck uses only `schemeClr` references (theme rewrite still applied — verify check 4). Report it; don't loop. |
| DESIGN.md missing `typography:` | Colors still apply; fonts fall back to Georgia/Arial. Warn the user and ask for font families before delivering. |

**Stop conditions** — stop and ask the user rather than guessing: ambiguous input file among several candidates; a brand color whose intent you can't classify (decorative vs error vs primary); DESIGN.md without typography when the deck's fonts matter.

## Quality checklist (all must pass before "done")

- [ ] DESIGN.md frontmatter parsed without error (script ran past the parse step)
- [ ] Every row of the color-mapping audit reviewed; no unintended `error`/collapse mappings remain
- [ ] Output zip passes integrity test
- [ ] Grep for replaced source hexes in output slides/layouts/masters returns 0
- [ ] `Final font usage` contains only DESIGN.md fonts + `+mj-lt`/`+mn-lt`
- [ ] Output `theme1.xml` clrScheme matches tokens (dk1/lt1/accent1 spot-check)
- [ ] Input file untouched; output uses agreed name
- [ ] Conversion report delivered with reproducible flags

## Supporting files

- [REFERENCE.md](REFERENCE.md) — DESIGN.md schema, token fallback chains, full CLI reference, color-classification and theme-slot tables, font/tracking/line-height rules
- [EXAMPLES.md](EXAMPLES.md) — minimal and full DESIGN.md examples, command recipes, annotated audit output
- `scripts/apply_design.py` — the conversion engine (stdlib-only; Pillow optional)
