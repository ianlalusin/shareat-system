/**
 * T-387 S1 addendum: the stock `neutral` ramp, re-valued warm.
 *
 * ⭐ Why a ramp and not a sweep. 154 of 171 .tsx files carry 4,946 `neutral-*` utilities. On the
 * cream canvas they read as cold grey islands, and one of them is worse than a look: stock
 * `text-neutral-500` (575 lines, the caption colour) is 4.34:1 on `--canvas #fbf4e4`, under AA.
 * Re-valuing the palette fixes every file at once, and S8 still moves the screens onto the kit.
 *
 * The rules this file holds the ramp to:
 *   1. Where a step's job in the app IS a ruled token, it carries that token's hex exactly, read from
 *      globals.css (never copied): 200 light borders, 400 dark captions, 500 light captions,
 *      800 dark borders, 900 dark surface, 950 dark canvas.
 *   2. Every other step keeps stock neutral's lightness (contrast against white within 3%), so no
 *      existing text pair silently loses contrast.
 *   3. The ramp gets darker at every step.
 *   4. Captions clear AA where they are used: 500 on the light canvas, 400 on the dark surface.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WARM_NEUTRAL } from '../warm-neutral';

const here = fileURLToPath(new URL('.', import.meta.url));
const css = readFileSync(`${here}../src/app/globals.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tailwindConfig = readFileSync(`${here}../tailwind.config.ts`, 'utf8');
const lightBlock = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
const darkBlock = css.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\}/)?.[1] ?? '';

function declaredIn(block: string, token: string): string | undefined {
  return block.match(new RegExp(`(?<![\\w-])${token}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1]?.toLowerCase();
}

function luminance(hex: string): number {
  const ch = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const n = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
  return 0.2126 * ch(n(1)) + 0.7152 * ch(n(3)) + 0.0722 * ch(n(5));
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** Tailwind 3's stock neutral, the lightness reference for the steps that are not anchored. */
const STOCK: Record<string, string> = {
  50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373',
  600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a',
};
const STEPS = Object.keys(STOCK);
/** A step by its string key; `WARM_NEUTRAL` is keyed by number literals. */
const at = (step: string): string => (WARM_NEUTRAL as Record<string, string>)[step] ?? '';

const ANCHORS: Record<string, [block: string, token: string]> = {
  200: [lightBlock, '--surface-border'],
  400: [darkBlock, '--muted'],
  500: [lightBlock, '--muted'],
  800: [darkBlock, '--surface-border'],
  900: [darkBlock, '--surface'],
  950: [darkBlock, '--canvas'],
};

describe('T-387 S1 — the warm neutral ramp', () => {
  it('has all eleven steps, each a 6-digit hex', () => {
    expect(Object.keys(WARM_NEUTRAL).sort()).toEqual([...STEPS].sort());
    for (const v of Object.values(WARM_NEUTRAL)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });

  for (const [step, [block, token]] of Object.entries(ANCHORS)) {
    it(`${step} IS the ruled ${token} (${block === darkBlock ? 'dark' : 'light'}), read from globals.css`, () => {
      const ruled = declaredIn(block, token);
      expect(ruled).toBeDefined();
      expect(at(step)).toBe(ruled);
    });
  }

  for (const step of STEPS.filter((s) => !(s in ANCHORS))) {
    it(`${step} keeps stock lightness (contrast on white within 3%)`, () => {
      const warm = contrast(at(step), '#ffffff');
      const stock = contrast(STOCK[step]!, '#ffffff');
      expect(Math.abs(warm - stock) / stock).toBeLessThan(0.03);
    });
    it(`${step} is warm, not grey (red channel above blue)`, () => {
      const v = at(step);
      expect(Number.parseInt(v.slice(1, 3), 16)).toBeGreaterThan(Number.parseInt(v.slice(5, 7), 16));
    });
  }

  it('gets darker at every step', () => {
    const lums = STEPS.map((s) => luminance(at(s)));
    for (let i = 1; i < lums.length; i++) expect(lums[i]!).toBeLessThan(lums[i - 1]!);
  });

  it('⭐ captions clear AA where they sit: 500 on the cream canvas, 400 on the dark surface', () => {
    expect(contrast(WARM_NEUTRAL[500], declaredIn(lightBlock, '--canvas')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WARM_NEUTRAL[400], declaredIn(darkBlock, '--surface')!)).toBeGreaterThanOrEqual(4.5);
    // NEGATIVE: the stock caption grey this replaces fails on cream. That is why the ramp exists.
    expect(contrast(STOCK[500]!, declaredIn(lightBlock, '--canvas')!)).toBeLessThan(4.5);
  });

  it('tailwind.config re-values `neutral` with this ramp', () => {
    expect(tailwindConfig).toMatch(/import \{ WARM_NEUTRAL \} from '\.\/warm-neutral'/);
    expect(tailwindConfig).toMatch(/\bneutral:\s*WARM_NEUTRAL\b/);
  });
});
