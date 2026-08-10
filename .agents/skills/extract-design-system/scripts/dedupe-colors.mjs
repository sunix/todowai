#!/usr/bin/env node
/**
 * dedupe-colors.mjs — Node.js port of dedupe-colors.py (no Python required)
 *
 * Usage:  echo '["#fff","#fefefe","#09090b"]' | node scripts/dedupe-colors.mjs
 *         node -e "..." | node scripts/dedupe-colors.mjs [--threshold 6]
 *
 * Identical output shape to dedupe-colors.py.
 */

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const thresholdArg = args.indexOf('--threshold');
const THRESHOLD = thresholdArg !== -1 ? parseFloat(args[thresholdArg + 1]) : 6.0;

// ── sRGB → CIE L*a*b* ─────────────────────────────────────────────────────

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  return [parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLab(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  // sRGB → XYZ (D65)
  const X = r*0.4124564 + g*0.3575761 + b*0.1804375;
  const Y = r*0.2126729 + g*0.7151522 + b*0.0721750;
  const Z = r*0.0193339 + g*0.1191920 + b*0.9503041;
  // XYZ → Lab
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787*t + 16/116;
  const [fx, fy, fz] = [f(X/0.95047), f(Y/1.0), f(Z/1.08883)];
  return [116*fy - 16, 500*(fx - fy), 200*(fy - fz)];
}

function deltaE([L1,a1,b1], [L2,a2,b2]) {
  return Math.sqrt((L1-L2)**2 + (a1-a2)**2 + (b1-b2)**2);
}

// ── Color naming ───────────────────────────────────────────────────────────

function rgbToHsv(r, g, b) {
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if      (max === r) h = 60 * (((g-b)/d) % 6);
    else if (max === g) h = 60 * ((b-r)/d + 2);
    else                h = 60 * ((r-g)/d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d/max, max];
}

function hueName(h) {
  if (h < 15)  return 'Red';
  if (h < 45)  return 'Orange';
  if (h < 70)  return 'Yellow';
  if (h < 150) return 'Green';
  if (h < 195) return 'Cyan';
  if (h < 255) return 'Blue';
  if (h < 285) return 'Indigo';
  if (h < 315) return 'Violet';
  if (h < 345) return 'Pink';
  return 'Red';
}

function suggestName(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s] = rgbToHsv(r, g, b);
  const [L, a, bLab] = hexToLab(hex);
  const chroma = Math.sqrt(a**2 + bLab**2);

  if (s < 0.08 || chroma < 8) {
    if (L > 95) return 'Pure White';
    if (L > 85) return 'Off-White';
    if (L > 70) return 'Light Gray';
    if (L > 55) return 'Medium Gray';
    if (L > 35) return 'Dark Gray';
    if (L > 15) return 'Near Black';
    return 'Black';
  }

  let hname = hueName(h);
  if (195 <= h && h < 240 && s > 0.4) hname = L > 50 ? 'Sky Blue' : 'Navy';
  else if (240 <= h && h < 280 && s > 0.3) hname = L < 50 ? 'Indigo' : 'Periwinkle';
  else if (150 <= h && h < 195 && s > 0.3) hname = L < 60 ? 'Teal' : 'Cyan';

  const lightness = L > 85 ? 'Pale' : L > 70 ? 'Light' : L > 55 ? 'Soft' : L > 40 ? '' : L > 25 ? 'Deep' : 'Dark';
  const sat = s > 0.85 ? 'Vivid' : s > 0.60 ? '' : s > 0.35 ? 'Muted' : 'Dusty';

  return [lightness, sat, hname].filter(Boolean).join(' ');
}

function inferRole(hex, sortedByL) {
  const [r, g, b] = hexToRgb(hex);
  const [, s] = rgbToHsv(r, g, b);
  const [L] = hexToLab(hex);

  if (L > 90 && s < 0.05) return 'background / surface';
  if (L < 15)              return 'foreground / text primary';
  if (L < 40)              return 'text secondary / dark accent';
  if (L < 60 && s < 0.15) return 'text muted / border';
  if (s > 0.6 && L >= 40 && L <= 70) return 'accent / CTA';
  if (L > 80 && s < 0.15) return 'surface / container';
  if (L >= 60 && L < 80 && s < 0.2) return 'border / outline';
  if (s > 0.7) return 'functional state (error / success / warning)';
  return 'supporting';
}

// ── Clustering ─────────────────────────────────────────────────────────────

function cluster(colors, threshold) {
  const labs = Object.fromEntries(colors.map(c => [c, hexToLab(c)]));
  const clusters = [];
  const assigned = new Set();

  for (const color of colors) {
    if (assigned.has(color)) continue;
    const group = [color];
    assigned.add(color);
    for (const other of colors) {
      if (!assigned.has(other) && deltaE(labs[color], labs[other]) <= threshold) {
        group.push(other);
        assigned.add(other);
      }
    }
    clusters.push(group);
  }
  return clusters;
}

function pickRepresentative(group) {
  // Prefer "double digit" hex (web-safe-ish) like #333333
  for (const c of group) {
    const h = c.slice(1);
    if (h[0]===h[1] && h[2]===h[3] && h[4]===h[5]) return c;
  }
  return group[0];
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  let raw;
  try {
    raw = readFileSync(process.platform === 'win32' ? 0 : '/dev/stdin', 'utf-8').trim();
  } catch {
    process.stderr.write('Provide a JSON array of hex strings via stdin\n');
    process.exit(1);
  }

  let colors;
  try { colors = JSON.parse(raw); } catch {
    process.stderr.write('Invalid JSON input\n');
    process.exit(1);
  }

  // Normalise & deduplicate exact matches
  const valid = [...new Set(
    colors
      .map(c => typeof c === 'string' ? c.trim().toLowerCase() : '')
      .filter(c => /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c))
  )];

  if (!valid.length) { process.stdout.write('[]\n'); return; }

  const clusters = cluster(valid, THRESHOLD);
  const sortedByL = [...valid].sort((a, b) => hexToLab(a)[0] - hexToLab(b)[0]);

  const output = clusters.map(group => {
    const rep = pickRepresentative(group);
    const [L] = hexToLab(rep);
    const [, s] = rgbToHsv(...hexToRgb(rep));
    return {
      hex:         rep,
      name:        suggestName(rep),
      role:        inferRole(rep, sortedByL),
      lightness:   Math.round(L * 10) / 10,
      saturation:  Math.round(s * 1000) / 10,
      aliases:     group.filter(c => c !== rep),
      clusterSize: group.length,
    };
  }).sort((a, b) => b.lightness - a.lightness);

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
