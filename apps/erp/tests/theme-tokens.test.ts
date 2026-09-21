/**
 * T-334 slice 1 — the nine tokens, the dark-mode strategy, and contrast as a GATE rather than a
 * reviewer's eye.
 *
 * ⭐ **Why contrast is computed here rather than trusted from the ADR.** ADR-013 records the
 * figures (5.47 / 8.32 / 1.77) because they were measured once. ⛔ A number measured once and
 * written down is a number that goes stale the first time somebody nudges a hex. This file
 * recomputes them FROM THE DECLARED VALUES, so a future palette edit that breaks accessibility
 * fails a gate instead of passing a review.
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
/** The dark block, which ADR-013 §7 says is deliberately incomplete — asserted, not assumed. */
const darkBlock = globalsCss.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\}/)?.[1] ?? '';

/** The ruled palette — ADR-013 A1.1. ⛔ Ian's ruling; this file asserts it, it does not choose it. */
const RULED = {
  '--brand': '#d40909',
  '--brand-hover': '#b00707',
  '--danger': '#a00606',
  '--danger-surface': '#fde7e7',
  '--warning': '#f4b942',
  '--success': '#059669',
  '--canvas': '#ffffff',
  '--surface': '#ffffff',
  '--surface-border': '#e5e5e5',
  '--ink': '#1a1a1a',
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
 * ⚠️ Scoped on purpose. A bare first-match search over the whole stylesheet would keep reading the
 * light value once ADR-013 §7's dark-mode reds land in `:root[data-theme='dark']`, and these
 * contrast gates would silently stop covering the palette they exist to guard.
 */
function declaredIn(block: string, token: string): string | undefined {
  const m = block.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  return m?.[1]?.toLowerCase();
}

const declared = (token: string): string | undefined => declaredIn(lightBlock, token);

describe('T-334 slice 1 — the ruled tokens are declared', () => {
  for (const [token, value] of Object.entries(RULED)) {
    it(`${token} is declared as ${value}`, () => {
      expect(declared(token)).toBe(value);
    });
  }
});

describe('T-334 slice 1 — the OS no longer decides', () => {
  it('⛔ color-scheme is light, NOT "light dark" — this is the defect being fixed', () => {
    expect(globalsCss).toMatch(/color-scheme:\s*light\s*;/);
    expect(globalsCss).not.toMatch(/color-scheme:\s*light\s+dark/);
  });

  it('⭐ dark is reachable ONLY under the attribute selector — asserted on the RULE, not on prose', () => {
    // ⛔ Against comment-stripped CSS, and matching the selector as actually written. The first
    // version of this assertion matched a comment and survived deleting the whole block.
    expect(globalsCss).toMatch(/:root\[data-theme='dark'\]\s*\{/);
    expect(darkBlock).toMatch(/color-scheme:\s*dark/);
    // ⛔ And there is no media-query route back to OS-following anywhere in the stylesheet.
    expect(globalsCss).not.toMatch(/prefers-color-scheme/);
  });

  it('⚠️ the dark block is DELIBERATELY INCOMPLETE — it must not silently reuse the light reds', () => {
    // ADR-013 §7: #d40909 is 3.84:1 on black and #a00606 is 2.52:1 — both FAIL AA as text there,
    // and dark-mode reds have not been ruled. This pins the gap OPEN: if someone adds --brand to
    // the dark block, they must consciously update this expectation rather than ship a failing
    // contrast silently.
    expect(declaredIn(darkBlock, '--brand')).toBeUndefined();
    expect(declaredIn(darkBlock, '--danger')).toBeUndefined();
  });

  it("the dark block's own ink/canvas pair is AAA — the part that IS ruled must still be legible", () => {
    const ink = declaredIn(darkBlock, '--ink');
    const canvas = declaredIn(darkBlock, '--canvas');
    expect(ink).toBeDefined();
    expect(canvas).toBeDefined();
    expect(contrast(ink!, canvas!)).toBeGreaterThanOrEqual(7);
  });

  it('⛔ every palette colour keeps its /opacity modifier — a bare var() silently emits NOTHING', () => {
    // Measured during review by compiling the real config: with plain `var(--brand)` values,
    // `bg-brand` emits a rule but `text-brand/50` and `bg-warning/20` emit NO RULE AT ALL — no
    // warning, no build error. ⚠️ Slice 4 routes 11 existing amber opacity usages onto --warning;
    // they would lose their background or border with the build still green.
    // ⭐ The real proof is a compile (verified: `/20` → `calc(0.2 * 100%)`). This is the cheap
    // guard against regressing to the bare form, which is the only way it breaks.
    expect(tailwindConfig).toContain('<alpha-value>');
    const colours = tailwindConfig.match(/colors:\s*\{[\s\S]*?\n {6}\},/)?.[0] ?? '';
    expect(colours).not.toBe('');
    expect(colours).not.toMatch(/:\s*'var\(--/);
  });

  it("⭐ tailwind's darkMode is the SELECTOR strategy — what keeps 3,485 dark: classes alive", () => {
    // ⛔ Without this, slice 1 silently neutralises every `dark:` class in the app and every other
    // test still passes. The class stops firing from the OS and starts firing from the attribute;
    // it must not simply stop firing.
    expect(tailwindConfig).toMatch(/darkMode:\s*\[\s*'selector'\s*,\s*'\[data-theme="dark"\]'\s*\]/);
  });
});

describe('T-334 slice 1 — contrast is a gate, computed from the declared values', () => {
  it('--brand on --canvas meets AA for normal text (>= 4.5:1)', () => {
    const ratio = contrast(declared('--brand')!, declared('--canvas')!);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(Number(ratio.toFixed(2))).toBe(5.47); // ADR-013's measured figure, reproduced
  });

  it('--danger on --canvas meets AAA (>= 7:1) — the escape hatch when brand is not enough', () => {
    const ratio = contrast(declared('--danger')!, declared('--canvas')!);
    expect(ratio).toBeGreaterThanOrEqual(7);
    expect(Number(ratio.toFixed(2))).toBe(8.32);
  });

  it('⛔ --warning FAILS as text and is therefore surface-only — asserted so nobody "fixes" it', () => {
    // 1.77:1. This is not an accident to be corrected; it is the reason the ruling says gold is a
    // surface and never a foreground. Asserting the failure keeps the rule and its reason together.
    const ratio = contrast(declared('--warning')!, declared('--canvas')!);
    expect(ratio).toBeLessThan(3);
    expect(Number(ratio.toFixed(2))).toBe(1.77);
  });

  it('--ink on --canvas is comfortably AAA — it carries every word in the app', () => {
    expect(contrast(declared('--ink')!, declared('--canvas')!)).toBeGreaterThanOrEqual(7);
  });

  it('⚠️ the ruled reds FAIL AA as text on black — ADR-013 §7, recorded so dark mode is not called supported', () => {
    // ⛔ This is not a bug to fix here. It is the known blocking gap, pinned so that whoever
    // eventually chooses dark-mode text reds discovers it from a failing expectation they must
    // consciously update, rather than from a user.
    expect(contrast(declared('--brand')!, '#000000')).toBeLessThan(4.5);
    expect(contrast(declared('--danger')!, '#000000')).toBeLessThan(4.5);
  });
});
