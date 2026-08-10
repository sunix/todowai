#!/usr/bin/env node
/**
 * extract-web.mjs — Extract raw design tokens from a live website
 *
 * Usage:
 *   node scripts/extract-web.mjs <url>
 *   node scripts/extract-web.mjs https://example.com > tokens-raw.json
 *
 * Output: JSON object with cssVars, tailwind classes, fonts, assets, stack signals
 */

import { readFileSync } from 'fs';
import https from 'https';
import http from 'http';

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  // Use global fetch (Node 18+) if available, else fall back to http/https
  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (design-token-extractor/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── CSS custom properties ──────────────────────────────────────────────────

function parseCssVarsFromText(text, vars = {}) {
  for (const [, name, value] of text.matchAll(/--([\w-]+)\s*:\s*([^;}\n]+)/g)) {
    vars[`--${name}`] = value.trim();
  }
  return vars;
}

function extractCssVars(html) {
  const vars = {};
  // From inline <style> blocks
  for (const [, block] of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
    parseCssVarsFromText(block, vars);
  // From inline style attributes (e.g. style="--color: #fff")
  for (const [, block] of html.matchAll(/style=["']([^"']*--[\w-][^"']*)["']/gi))
    parseCssVarsFromText(block, vars);
  // From embedded cssText strings (Next.js runtime injection)
  for (const [, block] of html.matchAll(/cssText\s*=\s*["'`]([\s\S]*?)["'`]/g))
    parseCssVarsFromText(block, vars);
  return vars;
}

// ── Linked stylesheet fetching ────────────────────────────────────────────

function extractStylesheetUrls(html, baseUrl) {
  const urls = [];
  const base = new URL(baseUrl);
  for (const [, href] of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi)) {
    try { urls.push(new URL(href, base).href); } catch { /* skip malformed */ }
  }
  // Also look for Next.js style data tags
  for (const [, href] of html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["'][^>]+rel=["']stylesheet["']/gi)) {
    try { urls.push(new URL(href, base).href); } catch { /* skip */ }
  }
  return [...new Set(urls)];
}

async function fetchLinkedCss(html, baseUrl) {
  const urls = extractStylesheetUrls(html, baseUrl);
  const texts = [];
  // Fetch up to 3 stylesheets — the first one usually has the token definitions
  for (const url of urls.slice(0, 3)) {
    try {
      process.stderr.write(`  Fetching stylesheet: ${url.split('?')[0].split('/').slice(-1)[0]}…\n`);
      texts.push(await fetchHtml(url));
    } catch { /* skip unreachable stylesheets */ }
  }
  return texts;
}

// ── Class extraction & categorisation ─────────────────────────────────────

function extractClasses(html) {
  const seen = new Set();
  for (const [, raw] of html.matchAll(/class(?:Name)?=["']([^"']+)["']/g)) {
    for (const cls of raw.split(/\s+/)) {
      if (cls) seen.add(cls);
    }
  }
  return [...seen].sort();
}

const TAILWIND_TEXT_SIZES = new Set([
  'text-xs','text-sm','text-base','text-lg','text-xl',
  'text-2xl','text-3xl','text-4xl','text-5xl','text-6xl','text-7xl','text-8xl','text-9xl',
]);

function stripModifiers(cls) {
  // Remove responsive (sm:, md:, lg:, xl:) and state (hover:, focus:, dark:, etc.) prefixes
  return cls.replace(/^[a-z0-9-]+(?:\[.*?\])?:/g, (m) => {
    const prefix = m.slice(0, -1);
    const knownMods = /^(sm|md|lg|xl|2xl|hover|focus|focus-visible|active|dark|group|group-hover|peer|aria-\w+|data-\w+|supports-\[.*?\]|not-\[.*?\])$/;
    return knownMods.test(prefix) ? '' : m;
  });
}

function categorize(classes) {
  const out = {
    colors:     { bg: new Set(), text: new Set(), border: new Set(), ring: new Set() },
    typography: { size: new Set(), font: new Set(), leading: new Set(), tracking: new Set(), italic: new Set() },
    spacing:    { padding: new Set(), margin: new Set(), gap: new Set(), space: new Set() },
    layout:     { width: new Set(), maxWidth: new Set(), grid: new Set(), flex: new Set() },
    effects:    { rounded: new Set(), shadow: new Set(), opacity: new Set(), backdrop: new Set(), transition: new Set() },
  };

  for (const cls of classes) {
    const base = stripModifiers(cls);
    if (!base) continue;

    if (/^bg-/.test(base))               out.colors.bg.add(cls);
    else if (TAILWIND_TEXT_SIZES.has(base)) out.typography.size.add(cls);
    else if (/^text-/.test(base))        out.colors.text.add(cls);
    else if (/^border-/.test(base))      out.colors.border.add(cls);
    else if (/^ring-/.test(base))        out.colors.ring.add(cls);
    else if (/^font-/.test(base))        out.typography.font.add(cls);
    else if (/^leading-/.test(base))     out.typography.leading.add(cls);
    else if (/^tracking-/.test(base))    out.typography.tracking.add(cls);
    else if (base === 'italic' || base === 'not-italic') out.typography.italic.add(cls);
    else if (/^p[xytblr]?-/.test(base)) out.spacing.padding.add(cls);
    else if (/^m[xytblr]?-/.test(base)) out.spacing.margin.add(cls);
    else if (/^gap-/.test(base))         out.spacing.gap.add(cls);
    else if (/^space-/.test(base))       out.spacing.space.add(cls);
    else if (/^(w|h|min-[wh]|max-[wh])-/.test(base)) out.layout.width.add(cls);
    else if (/^max-w-/.test(base))       out.layout.maxWidth.add(cls);
    else if (/^grid/.test(base))         out.layout.grid.add(cls);
    else if (/^flex/.test(base))         out.layout.flex.add(cls);
    else if (/^rounded/.test(base))      out.effects.rounded.add(cls);
    else if (/^shadow/.test(base))       out.effects.shadow.add(cls);
    else if (/^opacity-/.test(base))     out.effects.opacity.add(cls);
    else if (/^backdrop-/.test(base))    out.effects.backdrop.add(cls);
    else if (/^transition/.test(base))   out.effects.transition.add(cls);
  }

  // Convert Sets to sorted arrays for JSON serialisation
  const serialise = (obj) =>
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, [...v].sort()]));
  return {
    colors:     serialise(out.colors),
    typography: serialise(out.typography),
    spacing:    serialise(out.spacing),
    layout:     serialise(out.layout),
    effects:    serialise(out.effects),
  };
}

// ── Fonts ──────────────────────────────────────────────────────────────────

function extractFonts(html, cssTexts = []) {
  const fonts = [];
  for (const [, url] of html.matchAll(/<link[^>]+rel=["']preload["'][^>]+as=["']font["'][^>]+href=["']([^"']+)["']/gi))
    fonts.push({ type: 'preload', url });
  for (const [, url] of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']preload["'][^>]+as=["']font["']/gi))
    fonts.push({ type: 'preload', url });
  for (const [, family] of html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&\s>]+)/gi))
    fonts.push({ type: 'google', family: decodeURIComponent(family).replace(/\+/g, ' ') });
  // @font-face rules live in the HTML for inline styles, but with next/font
  // and bundled CSS they live in the linked stylesheets — scan both.
  for (const text of [html, ...cssTexts]) {
    for (const [, block] of text.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const family = block.match(/font-family:\s*['"]?([^;'"]+)/i)?.[1]?.trim();
      const weight = block.match(/font-weight:\s*([^;]+)/i)?.[1]?.trim();
      const src    = block.match(/src:\s*url\(['"]?([^'")\s]+)/i)?.[1]?.trim();
      if (family) fonts.push({ type: 'face', family, weight, src });
    }
  }
  return fonts;
}

/** Keep only fonts whose family actually appears in a font-family declaration
 *  in the page or its stylesheets. Preload entries (URL only) are kept — the
 *  browser was told to load them, that IS a usage signal. */
function filterUsedFonts(fonts, usageTexts) {
  const declared = new Set();
  for (const t of usageTexts)
    for (const [, fam] of t.matchAll(/font-family\s*:\s*([^;}'"]+(?:['"][^'"]*['"][^;}]*)?)/gi))
      for (const f of fam.split(','))
        declared.add(f.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
  if (!declared.size) return fonts;
  return fonts.filter((f) => {
    if (!f.family) return true; // preload URL — no family to check
    const name = f.family.split(':')[0].trim().toLowerCase();
    return declared.has(name);
  });
}

// ── Assets ─────────────────────────────────────────────────────────────────

function extractAssets(html, baseUrl) {
  const assets = [];
  const seen = new Set();
  const push = (entry, url) => {
    if (!url || url.startsWith('data:')) return; // skip inline data URIs
    let resolved = url.replace(/&amp;/g, '&'); // undo HTML entity escaping
    try { resolved = new URL(resolved, baseUrl).href; } catch { /* keep as-is */ }
    const key = `${entry.type}|${resolved}`;
    if (seen.has(key)) return;
    seen.add(key);
    assets.push({ ...entry, url: resolved });
  };
  for (const [, src, alt] of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi))
    push({ type: 'img', alt: alt ?? '' }, src);
  for (const [, href] of html.matchAll(/<use[^>]+(?:href|xlink:href)=["']([^"']+)["']/gi)) {
    const file = href.split('#')[0];
    if (file) push({ type: 'svg-use' }, file); // fragment-only = inline sprite, not an asset
  }
  for (const [, href] of html.matchAll(/<link[^>]+rel=["'](?:icon|apple-touch-icon)["'][^>]+href=["']([^"']+)["']/gi))
    push({ type: 'favicon' }, href);
  return assets;
}

// ── Tailwind v4 default palette filter ────────────────────────────────────
// Tailwind v4 exposes its entire built-in color scale as CSS vars like
// --color-emerald-300, --color-slate-50, etc. These are NOT brand tokens.
// Filter them out before extracting hex values or reporting colorTokens.

const TW_PALETTE_NAMES = new Set([
  'slate','gray','zinc','neutral','stone',
  'red','orange','amber','yellow','lime',
  'green','emerald','teal','cyan','sky',
  'blue','indigo','violet','purple','fuchsia',
  'pink','rose',
]);

function isTailwindPaletteVar(name) {
  const m = name.match(/^--color-([a-z]+)-(\d+)$/);
  return m != null && TW_PALETTE_NAMES.has(m[1]);
}

// ── Usage detection ────────────────────────────────────────────────────────
// A declared token is not a used token. Tailwind v4 (and many theme files)
// declare hundreds of vars the page never touches, and the CSS bundle contains
// rules for the whole site, not just this page. A var counts as USED only if:
//   1. it is referenced in an inline style attribute on the page, or
//   2. it is referenced in a CSS declaration whose rule selector is live —
//      i.e. the selector's classes appear in the page markup (selectors with
//      no class, like :root/body/*, always apply), or
//   3. it is reachable from a used var through var-to-var references
//      (--background: var(--_ivory) marks --_ivory used).

function extractInlineStyleBlocks(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

/** var() refs in style="" attributes — always live, they're on the page. */
function collectStyleAttrRefs(html) {
  const used = new Set();
  for (const [, attr] of html.matchAll(/style=["']([^"']*var\([^"']*)["']/gi))
    for (const [, name] of attr.matchAll(/var\(\s*--([\w-]+)/g))
      used.add(`--${name}`);
  return used;
}

/** Walk back from a declaration to its rule's selector; the rule is live if
 *  the selector has no class at all, or any of its classes is on the page. */
function ruleSelectorIsLive(css, declIndex, classSet) {
  const open = css.lastIndexOf('{', declIndex);
  if (open === -1) return true;
  const prevClose = css.lastIndexOf('}', open);
  const selector = css.slice(prevClose + 1, open);
  const classMatches = [...selector.matchAll(/\.((?:[\w-]|\\.)+)/g)];
  if (!classMatches.length) return true; // :root, body, *, @keyframes steps…
  return classMatches.some(([, cls]) => classSet.has(cls.replace(/\\(.)/g, '$1')));
}

/** var() refs in CSS declarations (custom-property declarations excluded —
 *  those are var-to-var edges, handled by the closure), gated on rule liveness. */
function collectLiveCssRefs(cssTexts, classSet) {
  const used = new Set();
  for (const css of cssTexts) {
    for (const decl of css.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
      const [, prop, value] = decl;
      if (prop.startsWith('--') || !value.includes('var(')) continue;
      for (const [, ref] of value.matchAll(/var\(\s*--([\w-]+)/g)) {
        const name = `--${ref}`;
        if (!used.has(name) && ruleSelectorIsLive(css, decl.index, classSet))
          used.add(name);
      }
    }
  }
  return used;
}

/** Expand the used set through var-to-var references in declarations
 *  (e.g. --background: var(--_ivory) marks --_ivory used once --background is). */
function closeOverVarValues(used, vars) {
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of Object.entries(vars)) {
      if (!used.has(name) || typeof value !== 'string') continue;
      for (const [, ref] of value.matchAll(/var\(\s*--([\w-]+)/g)) {
        const refName = `--${ref}`;
        if (!used.has(refName)) { used.add(refName); grew = true; }
      }
    }
  }
  return used;
}

function filterUsedCssVars(cssVars, html, cssTexts, classes) {
  const classSet = new Set(classes);
  const used = collectStyleAttrRefs(html);
  for (const name of collectLiveCssRefs(cssTexts, classSet)) used.add(name);
  closeOverVarValues(used, cssVars);

  // No live references found at all → usage data is unreliable (stylesheets
  // unreachable, styles injected at runtime). Fall back to dropping only the
  // standard Tailwind palette rather than dropping everything.
  if (used.size === 0) {
    return Object.fromEntries(
      Object.entries(cssVars).filter(([k]) => !isTailwindPaletteVar(k))
    );
  }

  return Object.fromEntries(
    Object.entries(cssVars).filter(([k]) => used.has(k))
  );
}

// ── Color format converters ────────────────────────────────────────────────

function clamp(v, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1/2.4) - 0.055;
}

function rgbToHex(r, g, b) {
  const toHex = x => Math.round(clamp(x) * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

/** CIE Lab → sRGB hex */
function labToHex(L, a, b) {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const f3 = t => t**3 > 0.008856 ? t**3 : (t - 16/116) / 7.787;
  // D65 white point
  const X = f3(fx) * 0.95047, Y = f3(fy), Z = f3(fz) * 1.08883;
  const r = linearToSrgb( 3.2404542*X - 1.5371385*Y - 0.4985314*Z);
  const g = linearToSrgb(-0.9692660*X + 1.8760108*Y + 0.0415560*Z);
  const bv= linearToSrgb( 0.0556434*X - 0.2040259*Y + 1.0572252*Z);
  return rgbToHex(r, g, bv);
}

/** OKLab → sRGB hex */
function oklabToHex(L, a, b) {
  const l = (L + 0.3963377774*a + 0.2158037573*b)**3;
  const m = (L - 0.1055613458*a - 0.0638541728*b)**3;
  const s = (L - 0.0894841775*a - 1.2914855480*b)**3;
  const R = linearToSrgb( 4.0767416621*l - 3.3077115913*m + 0.2309699292*s);
  const G = linearToSrgb(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s);
  const Bv= linearToSrgb(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s);
  return rgbToHex(R, G, Bv);
}

/** OKLCH(L% C H) → sRGB hex */
function oklchToHex(L, C, H) {
  const hRad = H * Math.PI / 180;
  return oklabToHex(L / 100, C * Math.cos(hRad), C * Math.sin(hRad));
}

/** HSL(h s% l%) → sRGB hex */
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h/30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0), f(8), f(4));
}

/** Try to convert any CSS color value to hex. Returns null if not parseable. */
function cssColorToHex(value) {
  const v = value.trim();
  // Already hex
  if (/^#[0-9a-f]{3,6}$/i.test(v)) return v.toLowerCase();
  // lab(L% a b) — Tailwind v4
  let m = v.match(/^lab\(\s*([\d.]+)%?\s+([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (m) return labToHex(+m[1], +m[2], +m[3]);
  // oklch(L% C H) — Tailwind v4
  m = v.match(/^oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*\)/i);
  if (m) return oklchToHex(+m[1], +m[2], +m[3]);
  // oklab(L a b)
  m = v.match(/^oklab\(\s*([\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (m) return oklabToHex(+m[1], +m[2], +m[3]);
  // rgb(r, g, b) or rgb(r g b)
  m = v.match(/^rgb\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*\)/i);
  if (m) return rgbToHex(+m[1]/255, +m[2]/255, +m[3]/255);
  // hsl(h, s%, l%) or hsl(h s% l%)
  m = v.match(/^hsl\(\s*([\d.]+(?:deg)?)[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)/i);
  if (m) return hslToHex(+m[1], +m[2], +m[3]);
  return null;
}

/** Extract hex colors from CSS var values (handles lab, oklch, hsl, rgb, hex) */
function extractHexFromCssVars(vars) {
  const seen = new Set();
  for (const value of Object.values(vars)) {
    if (typeof value !== 'string') continue;
    const hex = cssColorToHex(value);
    if (hex) seen.add(hex);
  }
  return [...seen];
}

// ── Hex colors in inline styles / SVGs ────────────────────────────────────

function extractHardcodedHex(html) {
  const seen = new Set();
  for (const [, hex] of html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g))
    seen.add('#' + hex.toLowerCase());
  return [...seen];
}

// ── Stack detection ────────────────────────────────────────────────────────

function detectStack(html, classes) {
  return {
    nextJs:          html.includes('/_next/') || html.includes('__NEXT_DATA__'),
    nuxt:            html.includes('/__nuxt/') || html.includes('__NUXT'),
    remix:           html.includes('/__remix') || html.includes('data-remix-'),
    astro:           html.includes('/_astro/'),
    tailwind:        classes.some((c) => /^(flex|grid|bg-|text-|p-|m-|gap-)/.test(c)),
    shadcn:          html.includes('data-slot='),
    styledComponents:/sc-[a-zA-Z]{6}/.test(html),
    cssModules:      /module__/.test(html) || /___[A-Z]/.test(html),
    hasCssVars:      html.includes('--'),
    hasIconFont:     /lucide|heroicons|feather|fa-|material-icons/.test(html),
  };
}

// ── Page meta ─────────────────────────────────────────────────────────────

function extractMeta(html) {
  return {
    title:       html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? '',
    description: html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim() ?? '',
    ogImage:     html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim() ?? '',
    lang:        html.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1]?.trim() ?? '',
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const url = process.argv[2];
  if (!url || !url.startsWith('http')) {
    console.error('Usage: node extract-web.mjs <https://...>');
    process.exit(1);
  }

  process.stderr.write(`Fetching ${url}…\n`);
  const html = await fetchHtml(url);
  process.stderr.write(`Fetched ${(html.length / 1024).toFixed(0)} KB\n`);

  const classes = extractClasses(html);

  // Always fetch linked stylesheets — we need their text to know which
  // tokens the page actually uses, not just which ones are declared.
  const linkedCss = await fetchLinkedCss(html, url);
  const cssTexts = [...extractInlineStyleBlocks(html), ...linkedCss];
  const usageTexts = [html, ...linkedCss];

  const allCssVars = extractCssVars(html);
  for (const css of linkedCss) parseCssVarsFromText(css, allCssVars);

  // Keep only vars the page consumes (live CSS rules, inline styles,
  // transitive var-to-var references)
  const cssVars = filterUsedCssVars(allCssVars, html, cssTexts, classes);
  const dropped = Object.keys(allCssVars).length - Object.keys(cssVars).length;
  process.stderr.write(
    `CSS vars: ${Object.keys(allCssVars).length} declared, ${Object.keys(cssVars).length} used (${dropped} unused dropped)\n`
  );

  // Convert used CSS var color values (hex, lab, oklch, hsl, rgb) to hex
  const cssHex = extractHexFromCssVars(cssVars);

  // Extract structured tokens from CSS vars (type scale, spacing, font families)
  const typographyTokens = {};
  const spacingTokens = {};
  const fontTokens = {};
  for (const [k, v] of Object.entries(cssVars)) {
    if (/^--text-[a-z0-9-]+$/.test(k) && !k.includes('line-height') && !k.includes('tracking') && !k.includes('weight')) {
      typographyTokens[k] = v;
    }
    if (/^--text-[a-z0-9-]+--line-height$/.test(k)) {
      typographyTokens[k] = v;
    }
    if (/^--spacing$/.test(k) || /^--container-/.test(k)) {
      spacingTokens[k] = v;
    }
    if (/^--font-/.test(k)) {
      fontTokens[k] = v;
    }
  }

  const result = {
    url,
    meta:         extractMeta(html),
    stack:        detectStack(html, classes),
    cssVars,
    colorTokens:  Object.fromEntries(
      Object.entries(cssVars).filter(([k]) => /^--color-/.test(k))
    ),
    typographyTokens,
    spacingTokens,
    fontTokens,
    tailwind:     categorize(classes),
    hardcodedHex: [...new Set([...extractHardcodedHex(html), ...cssHex])],
    fonts:        filterUsedFonts(extractFonts(html, linkedCss), usageTexts),
    assets:       extractAssets(html, url),
    classCount:   classes.length,
    declaredVarCount: Object.keys(allCssVars).length,
    usedVarCount:     Object.keys(cssVars).length,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
