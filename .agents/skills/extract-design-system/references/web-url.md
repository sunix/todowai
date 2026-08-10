# Web URL Extraction Reference

Use this guide when the input is a live website URL (not a local codebase).

## Step 1: Fetch the Page

```
web_fetch(url)
```

Fetch the root URL. Also fetch secondary pages if available (e.g. `/about`, `/blog`, `/pricing`) to see components in more contexts. 2-3 pages is usually enough.

## Step 2: Detect the Stack from HTML Signals

| Signal in HTML | Stack |
|:---|:---|
| `class="..."` with utility names (`flex`, `bg-*`, `text-*`) | Tailwind CSS |
| `data-slot="..."` attributes | shadcn/ui component system |
| `/_next/static/` in asset paths | Next.js |
| `/__nuxt/` in asset paths | Nuxt |
| `<script src="/static/js/main...">` | Create React App |
| `id="__NEXT_DATA__"` JSON block | Next.js with SSR data |
| CSS class hashes (`sc-aBcDeF`) | styled-components |
| `_css-modules_` or `.module.css` refs | CSS Modules |
| `style` tag with `:root { --*: }` | CSS custom properties design tokens |

## Step 3: Extract Colors

**Strategy A — CSS custom properties (most reliable):**  
Search the page HTML for `<style>` blocks containing `:root {`. Extract all `--*` declarations.

**Strategy B — Tailwind semantic classes:**  
Grep all class attributes for `bg-*`, `text-*`, `border-*` tokens. Map to the semantic system:
- `bg-background` / `bg-foreground` → surface/text pair
- `bg-primary` / `bg-secondary` / `bg-muted` → accent hierarchy
- `bg-destructive` / `bg-warning` / `bg-success` → functional states

**Strategy C — Inline/hardcoded values:**  
Look for `style="color: #..."` or `style="background: #..."` and `fill="#..."` in SVG. These are often brand-critical (logo color, hero illustration).

**Resolving semantic to actual hex:**  
If the page uses a CSS framework with defined defaults (shadcn/ui, DaisyUI), look up the default palette for the theme. Otherwise check the linked stylesheet URL for the token definitions.

## Step 4: Extract Typography

Grep for:
- `<link rel="preload" as="font">` — preloaded font files
- `<link href="fonts.googleapis.com/...">` — Google Fonts
- `font-family:` in `<style>` blocks
- Tailwind `font-*` class names (map to the config defaults or custom fonts)
- `@font-face` rules in linked stylesheets

For the type scale, map Tailwind text classes to rem values:

| Class | rem | px |
|:---|:---|:---|
| text-xs | 0.75 | 12 |
| text-sm | 0.875 | 14 |
| text-base | 1 | 16 |
| text-lg | 1.125 | 18 |
| text-xl | 1.25 | 20 |
| text-2xl | 1.5 | 24 |
| text-3xl | 1.875 | 30 |
| text-4xl | 2.25 | 36 |
| text-5xl | 3 | 48 |
| text-6xl | 3.75 | 60 |
| text-7xl | 4.5 | 72 |

## Step 5: Extract Spacing & Layout

- Grep for `max-w-*` on main container elements → max content width
- Grep for `gap-*` on grid/flex containers → spacing scale in use
- Grep for `py-*` on section elements → section rhythm
- Grep for `px-*` on outer wrappers → page edge padding
- Look for `container` or `container-*` classes → custom container config

## Step 6: Extract Components

For each component, find its wrapping element and note:
1. `data-slot` or component-specific class → component name
2. Class pattern on the element → visual treatment
3. Sibling/child elements → internal structure

Key components to always look for: button, card, badge/chip, nav, header, input, separator/divider.

## Step 7: Extract Assets

- `<img src="*.webp|*.svg|*.png">` with `alt` text containing brand name → logo candidates
- SVG `<use href="#icon-...">` → icon system (note the href pattern for icon names)
- `<link rel="icon">` → favicon
- Background images in style attributes

## Step 8: Infer What You Can't See

For semantic token systems (shadcn/ui, MUI, etc.), some values are not in the HTML. Use the known defaults:

**shadcn/ui default light theme (HSL):**
```
background: 0 0% 100%        → #ffffff
foreground: 222.2 84% 4.9%   → #09090b (near-black)
primary: 222.2 47.4% 11.2%   → #1a1a2e (very dark navy)
muted: 210 40% 96.1%         → #f1f5f9 (light blue-gray)
border: 214.3 31.8% 91.4%    → #e2e8f0 (soft gray)
```
Always flag inferred values in DESIGN.md as `[inferred from framework defaults — verify]`.

## Common Pitfalls

- **Opacity variants don't change the base color.** `bg-foreground/10` is `foreground` at 10% alpha — extract the base color, note the opacity.
- **Dark mode classes hide the actual values.** `dark:bg-slate-900` tells you the dark-mode color — document both.
- **CDN fonts may not be the full family.** `fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700` → only weights 400, 500, 700 are available.
- **Marquee/animation classes are not design tokens.** Skip `[animation:...]`, `[--duration:...]` etc. unless documenting motion design.
