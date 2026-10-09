/**
 * T-387 S1 (supersedes the T-334 slice 1 pins) — ADR-013 Amendment 7: "SharEat Warm" for light and
 * "Grill Night" for dark. Every hex and every measured contrast figure is asserted from the CSS.
 *
 * ⭐ **Why contrast is computed here rather than trusted from the ADR.** The ADR records the figures
 * because they were measured once. ⛔ A number measured once and written down goes stale the first
 * time somebody nudges a hex. This file recomputes them FROM THE DECLARED VALUES (read out of the
 * CSS, never typed as hex into a ratio), so a palette edit that breaks accessibility fails a gate
 * instead of passing a review.
 *
 * ⚠️ These read the real files rather than importing a TS constant on purpose: the tokens live in
 * CSS, which is what the browser actually consumes, and a TS mirror of them would be a second
 * source of truth — the exact shape this repo keeps filing defects about.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const globalsCssRaw = readFileSync(`${here}../src/app/globals.css`, 'utf8');
const tailwindConfig = readFileSync(`${here}../tailwind.config.ts`, 'utf8');

/**
 * ⛔ **COMMENTS STRIPPED BEFORE ANY ASSERTION, and this is not tidiness — the first version of
 * this file was VACUOUS because of it.** It asserted the stylesheet contained
 * `[data-theme="dark"]` with DOUBLE quotes; the real rule is `:root[data-theme='dark']` with
 * single ones, so the only match in the whole file was a sentence of prose in a comment. Deleting
 * the entire dark block left the test green. ⭐ *A guard that can be satisfied by the comment
 * describing it is worse than no guard, because it is credited.* Found by `/code-review`.
 */
const globalsCss = globalsCssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/** The `:root { … }` block only — so a later dark-mode override cannot be mistaken for the
 *  light-mode value these contrast gates exist to check. */
const lightBlock = globalsCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
/** The dark block. */
const darkBlock = globalsCss.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\}/)?.[1] ?? '';

/** ADR-013 Amendment 7 token table. Ian's ruling; this file asserts it, it does not choose it. */
const LIGHT = {
  '--canvas': '#fbf4e4',
  '--surface': '#fffdf8',
  '--surface-border': '#eadfc6',
  '--field': '#ffffff',
  '--field-border': '#94866f',
  '--ink': '#2b2620',
  '--muted': '#6b5f4f',
  '--brand': '#d40909',
  '--brand-hover': '#b00707',
  '--brand-ink': '#d40909',
  '--danger': '#a00606',
  '--danger-surface': '#fde7e7',
  '--warning': '#f4b942',
  '--warning-soft': '#fce8b8',
  '--warning-ink': '#7a4f00',
  '--success': '#0e6b45',
  '--success-soft': '#e2f1e8',
  '--info': '#1e4fb8',
  '--info-soft': '#e7eefb',
  '--progress': '#6427c9',
  '--progress-soft': '#eee7fb',
  '--closed': '#55606e',
  '--closed-soft': '#efece4',
} as const;

/** The ADR gives no dark `--warning-soft` and no dark `--brand-hover`: deliberately not asserted. */
const DARK = {
  '--canvas': '#121110',
  '--surface': '#1c1a18',
  '--surface-border': '#34302b',
  '--field': '#151412',
  '--field-border': '#746b5f',
  '--ink': '#f5efe4',
  '--muted': '#a89f92',
  '--brand': '#d40909',
  '--brand-ink': '#ff7a70',
  '--danger': '#f87171',
  '--danger-surface': '#2a0f0f',
  '--warning': '#2b2210',
  '--warning-ink': '#f4b942',
  '--success': '#4ade80',
  '--success-soft': '#0f2a1c',
  '--info': '#93b4ff',
  '--info-soft': '#142038',
  '--progress': '#c4b5fd',
  '--progress-soft': '#241b3d',
  '--closed': '#aab4c2',
  '--closed-soft': '#23262b',
} as const;

/** WCAG 2.1 relative luminance, then the contrast ratio. Pure, so it can be asserted against. */
function luminance(hex: string): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * The value declared for a token **within a given block**, so the assertions test the FILE.
 *
 * ⚠️ Scoped on purpose, and anchored: `--info` must not match inside `--info-soft`, nor `--brand`
 * inside `--brand-ink`, so the name has to be preceded by a non-name character.
 */
function declaredIn(block: string, token: string): string | undefined {
  const m = block.match(new RegExp(`(?<![\\w-])${token}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  return m?.[1]?.toLowerCase();
}

const declared = (token: string): string | undefined => declaredIn(lightBlock, token);
const darkDeclared = (token: string): string | undefined => declaredIn(darkBlock, token);

/** One row of the ADR's "Measured 2026-10-09" table: fg on bg, the printed figure, the WCAG floor. */
type Pair = { fg: string; bg: string; figure: number; floor: number };
const LIGHT_PAIRS: Pair[] = [
  { fg: '--ink', bg: '--canvas', figure: 13.68, floor: 7 },
  { fg: '--ink', bg: '--surface', figure: 14.75, floor: 7 },
  { fg: '--muted', bg: '--canvas', figure: 5.68, floor: 4.5 },
  { fg: '--brand', bg: '--canvas', figure: 4.99, floor: 4.5 },
  { fg: '--danger', bg: '--canvas', figure: 7.59, floor: 7 },
  { fg: '--warning-ink', bg: '--warning-soft', figure: 5.9, floor: 4.5 },
  { fg: '--success', bg: '--success-soft', figure: 5.61, floor: 4.5 },
  { fg: '--info', bg: '--info-soft', figure: 6.29, floor: 4.5 },
  { fg: '--progress', bg: '--progress-soft', figure: 6.53, floor: 4.5 },
  { fg: '--closed', bg: '--closed-soft', figure: 5.42, floor: 4.5 },
  { fg: '--field-border', bg: '--field', figure: 3.56, floor: 3 },
];
const DARK_PAIRS: Pair[] = [
  { fg: '--ink', bg: '--canvas', figure: 16.48, floor: 7 },
  { fg: '--ink', bg: '--surface', figure: 15.16, floor: 7 }, // also the dark ring-ink figure
  { fg: '--muted', bg: '--surface', figure: 6.64, floor: 4.5 },
  { fg: '--brand-ink', bg: '--surface', figure: 6.83, floor: 4.5 },
  { fg: '--danger', bg: '--surface', figure: 6.27, floor: 4.5 },
  { fg: '--warning-ink', bg: '--warning', figure: 8.86, floor: 4.5 },
  { fg: '--success', bg: '--success-soft', figure: 8.81, floor: 4.5 },
  { fg: '--info', bg: '--info-soft', figure: 7.9, floor: 4.5 },
  { fg: '--progress', bg: '--progress-soft', figure: 8.76, floor: 4.5 },
  { fg: '--closed', bg: '--closed-soft', figure: 7.24, floor: 4.5 },
  { fg: '--field-border', bg: '--field', figure: 3.52, floor: 3 },
];

describe('T-387 S1 — Amendment 7 light tokens are declared', () => {
  for (const [token, value] of Object.entries(LIGHT)) {
    it(`light ${token} is ${value}`, () => {
      expect(declared(token)).toBe(value);
    });
  }
});

describe('T-387 S1 — Amendment 7 dark tokens are declared', () => {
  for (const [token, value] of Object.entries(DARK)) {
    it(`dark ${token} is ${value}`, () => {
      expect(darkDeclared(token)).toBe(value);
    });
  }
});

describe('T-387 S1 — the OS no longer decides', () => {
  it('color-scheme is light in the light block and dark in the dark block', () => {
    expect(lightBlock).toMatch(/color-scheme:\s*light\s*;/);
    expect(lightBlock).not.toMatch(/color-scheme:\s*light\s+dark/);
    expect(darkBlock).toMatch(/color-scheme:\s*dark\s*;/);
  });

  it('dark is reachable only under the attribute selector, and no media query follows the OS', () => {
    // ⛔ Asserted on comment-stripped CSS, against the selector as actually written.
    expect(globalsCss).toMatch(/:root\[data-theme='dark'\]\s*\{/);
    expect(globalsCss).not.toMatch(/prefers-color-scheme/);
  });
});

describe('T-387 S1 — contrast is a gate, recomputed from the declared values', () => {
  const run = (label: string, block: string, pairs: Pair[]): void => {
    for (const p of pairs) {
      it(`${label} ${p.fg} on ${p.bg} reproduces the ADR figure ${p.figure} and clears ${p.floor}:1`, () => {
        const fg = declaredIn(block, p.fg);
        const bg = declaredIn(block, p.bg);
        expect(fg).toBeDefined();
        expect(bg).toBeDefined();
        const ratio = contrast(fg!, bg!);
        expect(Number(ratio.toFixed(2))).toBe(p.figure);
        expect(ratio).toBeGreaterThanOrEqual(p.floor);
      });
    }
  };
  run('light', lightBlock, LIGHT_PAIRS);
  run('dark', darkBlock, DARK_PAIRS);

  it('⛔ --warning stays surface-only: light warning on canvas is under 3:1', () => {
    expect(contrast(declared('--warning')!, declared('--canvas')!)).toBeLessThan(3);
  });
});

describe('T-387 S1 — negatives: the rejected values really fail the helper', () => {
  it("#eadfc6 as field-border on a #ffffff field is under 3:1 (the sheet's mistake)", () => {
    expect(contrast('#eadfc6', '#ffffff')).toBeLessThan(3);
  });

  it('#d40909 as dark brand-ink on the dark surface is under 4.5:1', () => {
    expect(contrast('#d40909', '#1c1a18')).toBeLessThan(4.5);
  });

  it('the declared dark brand-ink is not the failing #d40909', () => {
    expect(darkDeclared('--brand-ink')).toBeDefined();
    expect(darkDeclared('--brand-ink')).not.toBe('#d40909');
  });

  it('the declared field-border is not the decorative surface-border, in either theme', () => {
    expect(declared('--field-border')).toBeDefined();
    expect(declared('--field-border')).not.toBe(declared('--surface-border'));
    expect(darkDeclared('--field-border')).toBeDefined();
    expect(darkDeclared('--field-border')).not.toBe(darkDeclared('--surface-border'));
  });
});

describe('T-387 S1 — base layer (comment-stripped CSS)', () => {
  /** Every `selector { body }` rule, including ones nested in `@layer base { … }`. */
  const rules = [...globalsCss.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((x) => x.trim()),
    body: m[2]!,
  }));
  const bodyOf = (sel: string): string =>
    rules
      .filter((r) => r.selectors.includes(sel))
      .map((r) => r.body)
      .join(';');

  it('body uses var(--canvas), var(--ink) and var(--font-body)', () => {
    const body = bodyOf('body');
    expect(body).toMatch(/background(-color)?:\s*var\(--canvas\)/);
    expect(body).toMatch(/(^|[;\s])color:\s*var\(--ink\)/);
    expect(body).toMatch(/font-family:\s*var\(--font-body\)/);
  });

  for (const tag of ['h1', 'h2', 'h3']) {
    it(`${tag} uses var(--font-display)`, () => {
      expect(bodyOf(tag)).toMatch(/font-family:\s*var\(--font-display\)/);
    });
  }
});

describe('T-387 S1 — tailwind config', () => {
  const colours = tailwindConfig.match(/colors:\s*\{[\s\S]*?\n {6}\},/)?.[0] ?? '';

  it('the colors block is found, never uses a bare var(), and keeps <alpha-value>', () => {
    expect(colours).not.toBe('');
    expect(colours).not.toMatch(/:\s*'var\(--/);
    expect(tailwindConfig).toContain('<alpha-value>');
  });

  for (const token of [
    '--field',
    '--field-border',
    '--muted',
    '--brand-ink',
    '--warning-ink',
    '--warning-soft',
    '--success-soft',
    '--info',
    '--info-soft',
    '--progress',
    '--progress-soft',
    '--closed',
    '--closed-soft',
  ]) {
    it(`has a colour key for ${token} in the alpha() shape`, () => {
      expect(colours).toContain(`alpha('${token}')`);
    });
  }

  it('fontFamily.sans starts with var(--font-body) and display with var(--font-display)', () => {
    expect(tailwindConfig).toMatch(/fontFamily:\s*\{[\s\S]*?sans:\s*\[\s*'var\(--font-body\)'/);
    expect(tailwindConfig).toMatch(/fontFamily:\s*\{[\s\S]*?display:\s*\[\s*'var\(--font-display\)'/);
  });

  it('darkMode is the SELECTOR strategy — what keeps the existing dark: classes alive', () => {
    expect(tailwindConfig).toMatch(/darkMode:\s*\[\s*'selector'\s*,\s*'\[data-theme="dark"\]'\s*\]/);
  });
});
