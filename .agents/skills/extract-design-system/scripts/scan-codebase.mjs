#!/usr/bin/env node
/**
 * scan-codebase.mjs — Extract raw design tokens from a local frontend codebase
 *
 * Usage:
 *   node scripts/scan-codebase.mjs <path/to/project>
 *   node scripts/scan-codebase.mjs . > tokens-raw.json
 *
 * Output: JSON object compatible with extract-web.mjs output shape
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, relative, resolve } from 'path';

const ROOT = resolve(process.argv[2] ?? '.');
const MAX_FILE_SIZE = 512 * 1024; // 512 KB — skip giant files

// ── File system helpers ────────────────────────────────────────────────────

function walk(dir, exts, ignore = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__']) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (ignore.includes(entry)) continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) files.push(...walk(full, exts, ignore));
      else if (exts.includes(extname(entry).toLowerCase()) && stat.size < MAX_FILE_SIZE) files.push(full);
    } catch { /* skip unreadable */ }
  }
  return files;
}

function readSafe(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

// ── CSS custom properties ──────────────────────────────────────────────────

function extractCssVars(files) {
  const vars = {};
  for (const file of files) {
    const src = readSafe(file);
    for (const [, name, value] of src.matchAll(/--([\w-]+)\s*:\s*([^;}\n]+)/g)) {
      // Prefer :root declarations (authoritative) over component overrides
      vars[`--${name}`] ??= value.trim();
    }
  }
  return vars;
}

// ── Tailwind config ────────────────────────────────────────────────────────

function parseTailwindConfig(root) {
  for (const name of ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const src = readSafe(path);

    const colors   = extractObjectLiteral(src, 'colors');
    const fonts    = extractObjectLiteral(src, 'fontFamily');
    const spacing  = extractObjectLiteral(src, 'spacing');
    const screens  = extractObjectLiteral(src, 'screens');
    const rounded  = extractObjectLiteral(src, 'borderRadius');
    const shadows  = extractObjectLiteral(src, 'boxShadow');
    const content  = (src.match(/content\s*:\s*\[([^\]]+)\]/s)?.[1] ?? '').trim();

    return { file: relative(root, path), colors, fonts, spacing, screens, rounded, shadows, content };
  }
  return null;
}

/** Very naive object-literal extractor — works for the common cases without eval */
function extractObjectLiteral(src, key) {
  const re = new RegExp(`['"]?${key}['"]?\\s*:\\s*\\{`, 'g');
  const match = re.exec(src);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  let result = '{';
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    if (depth > 0) result += src[i];
    i++;
  }
  result += '}';
  // Try to extract key-value pairs as plain strings
  const pairs = {};
  for (const [, k, v] of result.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
    pairs[k] = v;
  }
  return Object.keys(pairs).length ? pairs : null;
}

// ── Theme / token files ────────────────────────────────────────────────────

const TOKEN_FILE_PATTERNS = [
  /theme\.(js|ts|jsx|tsx|json)$/i,
  /tokens\.(js|ts|jsx|tsx|json)$/i,
  /colors\.(js|ts|jsx|tsx|json|css|scss)$/i,
  /typography\.(js|ts|jsx|tsx|json|css|scss)$/i,
  /design-system\.(js|ts|json)$/i,
  /variables\.(css|scss|less)$/i,
  /globals?\.(css|scss)$/i,
];

function findTokenFiles(root) {
  const candidates = walk(root, ['.js', '.ts', '.jsx', '.tsx', '.json', '.css', '.scss', '.less']);
  return candidates.filter((f) => TOKEN_FILE_PATTERNS.some((re) => re.test(f)));
}

function extractTokenFileData(files) {
  const out = {};
  for (const file of files) {
    const key = relative(ROOT, file);
    const src = readSafe(file);
    // CSS vars
    const vars = {};
    for (const [, name, value] of src.matchAll(/--([\w-]+)\s*:\s*([^;}\n]+)/g)) {
      vars[`--${name}`] = value.trim();
    }
    // JS/TS exported constants that look like color/token values
    const consts = {};
    for (const [, name, value] of src.matchAll(/(?:export\s+)?const\s+([\w]+)\s*=\s*['"]([^'"]+)['"]/g)) {
      if (/color|bg|fg|primary|secondary|accent|neutral|brand|font|weight|size|radius|shadow/i.test(name)) {
        consts[name] = value;
      }
    }
    out[key] = { vars, consts };
  }
  return out;
}

// ── Font detection ─────────────────────────────────────────────────────────

function extractFonts(root, cssFiles) {
  const fonts = [];
  // Google Fonts in HTML entry / layout files
  const htmlFiles = walk(root, ['.html', '.htm', '.njk', '.ejs']);
  for (const file of [...htmlFiles]) {
    const src = readSafe(file);
    for (const [, family] of src.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&\s>]+)/gi))
      fonts.push({ type: 'google', family: decodeURIComponent(family).replace(/\+/g, ' '), source: relative(ROOT, file) });
  }
  // @font-face in CSS
  for (const file of cssFiles) {
    const src = readSafe(file);
    for (const [, block] of src.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const family = block.match(/font-family:\s*['"]?([^;'"]+)/i)?.[1]?.trim();
      const weight = block.match(/font-weight:\s*([^;]+)/i)?.[1]?.trim();
      const style  = block.match(/font-style:\s*([^;]+)/i)?.[1]?.trim();
      const path   = block.match(/url\(['"]?([^'")\s]+)/i)?.[1]?.trim();
      if (family) fonts.push({ type: 'face', family, weight, style, path, source: relative(ROOT, file) });
    }
  }
  // next/font / Google Fonts imports in JS
  const jsFiles = walk(root, ['.js', '.ts', '.jsx', '.tsx']);
  for (const file of jsFiles) {
    const src = readSafe(file);
    for (const [, family] of src.matchAll(/(?:from\s+['"]next\/font\/google['"][\s\S]*?|import\s+\{[^}]*\}\s+from\s+['"]next\/font\/google['"][\s\S]*?)([\w_]+)\s*\(/g))
      fonts.push({ type: 'next-font', family: family.replace(/_/g, ' '), source: relative(ROOT, file) });
    // Direct font name strings near font-related imports
    if (src.includes("next/font")) {
      for (const [, fn] of src.matchAll(/(?:DM_Sans|DM_Serif_Text|Inter|Roboto|Open_Sans|Lato|Poppins|Montserrat|Playfair_Display|Source_Sans_3)\b/g))
        fonts.push({ type: 'next-font', family: fn.replace(/_/g, ' '), source: relative(ROOT, file) });
    }
  }
  return fonts;
}

// ── Component inventory ────────────────────────────────────────────────────

function scanComponents(root) {
  const jsFiles = walk(root, ['.jsx', '.tsx']);
  const components = [];
  for (const file of jsFiles) {
    const name = file.split(/[\\/]/).pop().replace(/\.(jsx|tsx)$/, '');
    if (!/^[A-Z]/.test(name)) continue; // PascalCase only
    const src = readSafe(file);
    const props = [];
    for (const [, prop] of src.matchAll(/(?:interface|type)\s+\w+Props[^{]*\{([\s\S]*?)\}/g)) {
      for (const [, p] of prop.matchAll(/([\w]+)\s*[?]?\s*:/g)) props.push(p);
    }
    components.push({ name, path: relative(ROOT, file), propCount: props.length });
  }
  return components;
}

// ── Stack detection ────────────────────────────────────────────────────────

function detectStack(root) {
  const pkgPath = join(root, 'package.json');
  let deps = {};
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch { /* ignore */ }
  }
  const hasDep = (...names) => names.some((n) => deps[n]);
  return {
    react:            hasDep('react', 'next', 'gatsby'),
    next:             hasDep('next'),
    vue:              hasDep('vue', 'nuxt'),
    svelte:           hasDep('svelte', '@sveltejs/kit'),
    angular:          hasDep('@angular/core'),
    tailwind:         hasDep('tailwindcss') || existsSync(join(root, 'tailwind.config.js')) || existsSync(join(root, 'tailwind.config.ts')),
    cssInJs:          hasDep('styled-components', '@emotion/react', '@emotion/styled'),
    shadcn:           existsSync(join(root, 'components.json')),
    storybook:        hasDep('@storybook/react', '@storybook/vue', '@storybook/svelte'),
    styleDictionary:  hasDep('style-dictionary'),
    tokenStudio:      hasDep('@tokens-studio/sd-transforms'),
    chakra:           hasDep('@chakra-ui/react'),
    mui:              hasDep('@mui/material'),
    antd:             hasDep('antd'),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(ROOT)) {
    console.error(`Path not found: ${ROOT}`);
    process.exit(1);
  }

  process.stderr.write(`Scanning ${ROOT}…\n`);

  const cssFiles = walk(ROOT, ['.css', '.scss', '.less', '.sass']);
  process.stderr.write(`  CSS files: ${cssFiles.length}\n`);

  const tokenFiles = findTokenFiles(ROOT);
  process.stderr.write(`  Token files: ${tokenFiles.length}\n`);

  const tailwind = parseTailwindConfig(ROOT);
  process.stderr.write(`  Tailwind config: ${tailwind ? tailwind.file : 'not found'}\n`);

  const stack = detectStack(ROOT);
  const fonts = extractFonts(ROOT, cssFiles);
  const cssVars = extractCssVars(cssFiles);
  const tokenData = extractTokenFileData(tokenFiles);
  const components = scanComponents(ROOT);

  const result = {
    root: ROOT,
    stack,
    tailwind,
    cssVars,
    tokenFiles: tokenData,
    fonts,
    components,
    summary: {
      cssFileCount:   cssFiles.length,
      tokenFileCount: tokenFiles.length,
      componentCount: components.length,
      cssVarCount:    Object.keys(cssVars).length,
      fontCount:      fonts.length,
    },
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
