# Examples — implement-design-system

## Minimal DESIGN.md

The smallest file that drives colors AND fonts. Define `background` before any `rgba()` token (rgba is composited over it).

```markdown
---
name: Acme
colors:
  background: '#FFFFFF'
  on-surface: '#1A1A1A'
  on-surface-variant: '#5C5C5C'
  surface-dim: '#F2F2F2'
  primary: '#0B5FFF'
  on-primary: '#FFFFFF'
  error: '#C62828'
  outline: 'rgba(26,26,26,0.15)'
typography:
  display-lg:
    fontFamily: Fraunces
    fontSize: 3.75rem
    lineHeight: 1.0
    letterSpacing: -0.05em
  body-base:
    fontFamily: Inter
    fontSize: 1rem
    lineHeight: 1.5
    letterSpacing: 0
---
# Acme design system
(prose below the frontmatter is ignored by the script)
```

A full real-world example is the SCIAM DESIGN.md: ~19 color tokens (Material-style `on-*`/`surface-*` names), 11 typography styles from `display-xl` (4.5rem, DM Serif Text, −0.06em) down to `mono` (0.875rem, Geist Mono). Extra sections like `rounded:` and `spacing:` are ignored — no need to strip them.

## Command recipes

```bash
# 1. Standard run (inferred mapping) — start here
python "$SKILL_DIR/scripts/apply_design.py" deck.pptx -d DESIGN.md -o deck_branded.pptx

# 2. Fix misclassifications found in the audit (token names or raw hex targets)
python "$SKILL_DIR/scripts/apply_design.py" deck.pptx -d DESIGN.md -o deck_branded.pptx \
  --color-map FF6B35=primary 324B75=primary D0CFCB=outline \
  --font-map "Calibri=DM Sans" "Calibri Light=DM Serif Text"

# 3. Strict mode for repeatable brand conversions — nothing inferred
python "$SKILL_DIR/scripts/apply_design.py" deck.pptx -d DESIGN.md -o out.pptx \
  --no-infer-colors --color-map 324B75=primary FFFFFF=background 000000=on-surface

# 4. Dark template → light theme, also repaint near-black logo pixels
python "$SKILL_DIR/scripts/apply_design.py" dark.potx -d DESIGN.md -o light.potx --recolor-dark-images

# 5. Keep extracted XML for inspection / leftover-color verification
python "$SKILL_DIR/scripts/apply_design.py" deck.pptx -d DESIGN.md -o out.pptx \
  --work-dir _check --keep-work-dir
grep -ril "324B75" _check/ppt/slides _check/ppt/slideLayouts _check/ppt/slideMasters   # expect: nothing
```

On Windows/PowerShell, quote paths and use backtick or single-line forms; `python` may be `py`.

## Reading the audit output

```
  14 of 21 XML file(s) updated

  Color mapping:
    142x  #FFFFFF -> #FBF9F6  (background)
     61x  #324B75 -> #314163  (primary)
     23x  #ED7D31 -> #B32322  (error)        <-- SUSPICIOUS
      9x  #D9D9D9 -> #F8F6F3  (surface-dim)
      4x  #16100E -> #16100E  (black)

  Final font usage:
     88x  DM Sans
     19x  DM Serif Text
     12x  +mn-lt

  Output: C:\...\deck_branded.pptx
```

How to read it, line by line:

| Observation | Verdict |
|---|---|
| `#FFFFFF -> background`, `#D9D9D9 -> surface-dim` | Expected — light neutrals to surfaces |
| `#324B75 -> primary` | Expected — saturated brand mid-tone |
| `#ED7D31 -> error` with 23 uses | **Misfire** — orange (hue ~24° can fall in the red band) used as a chart/accent color, not an error state. Re-run with `--color-map ED7D31=primary` (or a dedicated token). |
| `#16100E -> #16100E (black)` | Already a design token value — kept as-is |
| `+mn-lt` in font usage | Fine — theme reference, resolves to the new minor font |
| A font like `Calibri` still listed | Not fine — add `--font-map "Calibri=DM Sans"` and re-run |

Decision rule: a high-count color mapped to `error` is almost always wrong unless the source deck genuinely used red for warnings. When unsure which role a source color plays, open one slide that uses it (`grep -l <HEX> work/ppt/slides/*.xml`, read the surrounding shape) or ask the user.
