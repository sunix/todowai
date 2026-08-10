#!/usr/bin/env python3
"""
dedupe-colors.py — Deduplicate and name a list of hex colors using perceptual distance.

Usage:
  echo '["#ffffff","#fefefe","#09090b","#0a0a0b"]' | python3 scripts/dedupe-colors.py
  python3 scripts/dedupe-colors.py < colors.json
  python3 scripts/dedupe-colors.py --threshold 8

Input:  JSON array of hex color strings (stdin)
Output: JSON array of deduplicated color objects with suggested names and roles

Algorithm:
  Converts each hex to CIE L*a*b* color space (perceptually uniform).
  Clusters colors within a configurable ΔE threshold (default: 6).
  For each cluster, keeps the most common / representative member.
  Suggests a descriptive name based on hue, lightness, and saturation.
"""

import sys
import json
import math
import argparse
import colorsys
from collections import defaultdict


# ── sRGB → CIE L*a*b* conversion (no external deps) ───────────────────────

def hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert #rrggbb or #rgb to (r, g, b) in [0, 1]."""
    h = hex_color.lstrip('#')
    if len(h) == 3:
        h = h[0]*2 + h[1]*2 + h[2]*2
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r / 255.0, g / 255.0, b / 255.0


def srgb_to_linear(c: float) -> float:
    """Apply inverse sRGB gamma correction."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb_to_xyz(r: float, g: float, b: float) -> tuple[float, float, float]:
    """Convert linear sRGB to CIE XYZ (D65 illuminant)."""
    rl, gl, bl = srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)
    x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
    y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
    z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
    return x, y, z


def xyz_to_lab(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Convert CIE XYZ to L*a*b* (D65 white point)."""
    xn, yn, zn = 0.95047, 1.00000, 1.08883
    def f(t):
        return t ** (1/3) if t > 0.008856 else (7.787 * t + 16 / 116)
    fx, fy, fz = f(x / xn), f(y / yn), f(z / zn)
    L = 116 * fy - 16
    a = 500 * (fx - fy)
    b = 200 * (fy - fz)
    return L, a, b


def hex_to_lab(hex_color: str) -> tuple[float, float, float]:
    return xyz_to_lab(*rgb_to_xyz(*hex_to_rgb(hex_color)))


def delta_e(lab1: tuple, lab2: tuple) -> float:
    """CIE76 ΔE color difference (good enough for dedup; ΔE ≈ 1 = barely perceptible)."""
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(lab1, lab2)))


# ── Color naming ───────────────────────────────────────────────────────────

HUE_NAMES = [
    (0,   15,  'Red'),
    (15,  45,  'Orange'),
    (45,  70,  'Yellow'),
    (70,  150, 'Green'),
    (150, 195, 'Cyan'),
    (195, 255, 'Blue'),
    (255, 285, 'Indigo'),
    (285, 315, 'Violet'),
    (315, 345, 'Pink'),
    (345, 360, 'Red'),
]

def hue_name(h_deg: float) -> str:
    for lo, hi, name in HUE_NAMES:
        if lo <= h_deg < hi:
            return name
    return 'Red'


def suggest_name(hex_color: str) -> str:
    """Generate a human-readable descriptive name for a color."""
    r, g, b = hex_to_rgb(hex_color)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    L, a, chroma = hex_to_lab(hex_color)
    h_deg = h * 360
    chroma_mag = math.sqrt(a**2 + chroma**2)

    # Achromatic / near-neutral
    if s < 0.08 or chroma_mag < 8:
        if L > 95:   return 'Pure White'
        if L > 85:   return 'Off-White'
        if L > 70:   return 'Light Gray'
        if L > 55:   return 'Medium Gray'
        if L > 35:   return 'Dark Gray'
        if L > 15:   return 'Near Black'
        return 'Black'

    hname = hue_name(h_deg)

    # Lightness prefix
    if L > 85:   lightness = 'Pale'
    elif L > 70: lightness = 'Light'
    elif L > 55: lightness = 'Soft'
    elif L > 40: lightness = ''
    elif L > 25: lightness = 'Deep'
    else:        lightness = 'Dark'

    # Saturation modifier
    if s > 0.85:   sat = 'Vivid'
    elif s > 0.60: sat = ''
    elif s > 0.35: sat = 'Muted'
    else:          sat = 'Dusty'

    # Hue refinement for blues/greens
    if 195 <= h_deg < 240 and s > 0.4:
        hname = 'Sky Blue' if L > 50 else 'Navy'
    elif 240 <= h_deg < 280 and s > 0.3:
        hname = 'Indigo' if L < 50 else 'Periwinkle'
    elif 150 <= h_deg < 195 and s > 0.3:
        hname = 'Teal' if L < 60 else 'Cyan'

    parts = [p for p in [lightness, sat, hname] if p]
    return ' '.join(parts)


# ── Role inference ─────────────────────────────────────────────────────────

def infer_role(hex_color: str, all_colors_sorted_by_l: list[str]) -> str:
    """Guess the functional role of a color based on its luminosity and position in the palette."""
    r, g, b = hex_to_rgb(hex_color)
    _, s, _ = colorsys.rgb_to_hsv(r, g, b)
    L, *_ = hex_to_lab(hex_color)
    idx = all_colors_sorted_by_l.index(hex_color)
    total = len(all_colors_sorted_by_l)

    if L > 90 and s < 0.05:   return 'background / surface'
    if L < 15:                 return 'foreground / text primary'
    if 15 <= L < 40:           return 'text secondary / dark accent'
    if 40 <= L < 60 and s < 0.15: return 'text muted / border'
    if s > 0.6 and 40 <= L <= 70: return 'accent / CTA'
    if L > 80 and s < 0.15:   return 'surface / container'
    if 60 <= L < 80 and s < 0.2: return 'border / outline'
    if s > 0.7 and (L < 30 or L > 60): return 'functional state (error / success / warning)'
    return 'supporting'


# ── Clustering ─────────────────────────────────────────────────────────────

def cluster_colors(colors: list[str], threshold: float) -> list[list[str]]:
    """Greedy single-linkage clustering by ΔE."""
    labs = {c: hex_to_lab(c) for c in colors}
    clusters: list[list[str]] = []
    assigned = set()

    for color in colors:
        if color in assigned:
            continue
        cluster = [color]
        assigned.add(color)
        for other in colors:
            if other not in assigned and delta_e(labs[color], labs[other]) <= threshold:
                cluster.append(other)
                assigned.add(other)
        clusters.append(cluster)

    return clusters


def pick_representative(cluster: list[str]) -> str:
    """Pick the most 'canonical' color in a cluster: prefer exact multiples of 17 (web-safe), else most common."""
    for c in cluster:
        h = c.lstrip('#')
        if len(h) == 6 and h[0] == h[1] and h[2] == h[3] and h[4] == h[5]:
            return c  # e.g. #333333
    return cluster[0]


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Deduplicate and name hex colors')
    parser.add_argument('--threshold', type=float, default=6.0,
                        help='ΔE threshold for considering two colors identical (default: 6)')
    parser.add_argument('--min-lightness', type=float, default=None,
                        help='Exclude colors with L* below this value (e.g. 5 to drop near-blacks from swatches)')
    args = parser.parse_args()

    raw = sys.stdin.read().strip()
    if not raw:
        print('[]')
        return

    try:
        colors_in = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f'Invalid JSON input: {e}', file=sys.stderr)
        sys.exit(1)

    # Normalise and filter
    valid = []
    for c in colors_in:
        c = c.strip().lower()
        if not c.startswith('#') or len(c.lstrip('#')) not in (3, 6):
            continue
        if args.min_lightness is not None:
            L, *_ = hex_to_lab(c)
            if L < args.min_lightness:
                continue
        valid.append(c)

    valid = list(dict.fromkeys(valid))  # deduplicate exact matches first

    if not valid:
        print('[]')
        return

    clusters = cluster_colors(valid, threshold=args.threshold)
    sorted_by_l = sorted(valid, key=lambda c: hex_to_lab(c)[0])

    output = []
    for cluster in clusters:
        rep = pick_representative(cluster)
        L, a, b_val = hex_to_lab(rep)
        r, g, b = hex_to_rgb(rep)
        _, s, v = colorsys.rgb_to_hsv(r, g, b)
        output.append({
            'hex':        rep,
            'name':       suggest_name(rep),
            'role':       infer_role(rep, sorted_by_l),
            'lightness':  round(L, 1),
            'saturation': round(s * 100, 1),
            'aliases':    [c for c in cluster if c != rep],
            'clusterSize': len(cluster),
        })

    # Sort by lightness descending (light → dark, matches typical palette docs)
    output.sort(key=lambda x: -x['lightness'])

    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
