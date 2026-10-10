/**
 * Button — T-334 slice 2 component contract (docs/tasks/334-slice-2-component-contract.md §3, §4,
 * §9 R1-R3).
 *
 * ⚠️ `.ts`, not `.tsx`, on purpose: the unit project's include glob (`vitest.config.mts`) is
 * `apps/**\/*.test.ts` — no `.tsx` variant. A `.test.tsx` here would match nothing and pass
 * silently (DEF-081/DEF-221 shape). `createElement` stands in for JSX, copying
 * `filter-row.test.ts`'s proven pattern exactly — no jsdom, no @testing-library, `environment:
 * 'node'`, `renderToStaticMarkup`.
 *
 * Corrected 2026-09-23 (audit finding F7): Button was a STUB (`export function Button(): null`)
 * pre-wired by the orchestrator ONLY for slice 2's own RED, so red then was an assertion failure,
 * not a module-not-found. It has been fully implemented since slice 2 shipped — this file's own
 * assertions are what proves that now, not this header.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/Button';

/** Every `class="..."` attribute in the html, flattened into one token set — §4's own warning:
 *  "an unanchored substring match cannot tell `bg-danger` from `bg-danger-surface` apart; assert
 *  on the class token, not on a substring." */
function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    // Guard, not `!`: noUncheckedIndexedAccess types a capture group as possibly undefined even
    // though this regex always has group 1 on a match; `?? ''` degrades to a no-op split instead.
    for (const t of (m[1] ?? '').split(/\s+/)) if (t) tokens.add(t);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// ADR-013 Amendment 5 — parses globals.css by declaration NAME inside the right selector block,
// never a whole-file substring (#a00606 also appears in this file's own comments). Duplicated
// from ui-input.test.ts's copy rather than shared, matching this test suite's own convention of
// file-local helpers (see classTokens above, and ui-token-discipline.test.ts's stripComments).
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readGlobalsCss(): string {
  return readFileSync(path.join(REPO_ROOT, 'apps/erp/src/app/globals.css'), 'utf8');
}

function extractRootBlock(css: string, dark: boolean): string | null {
  const re = dark ? /:root\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/ : /:root\s*\{([^}]*)\}/;
  return re.exec(css)?.[1] ?? null;
}

// Audit round 2, item 4: the previous escape regex was malformed (a misplaced `\\` shifted the
// character class boundary, so it matched `\\]` as two literal backslashes rather than escaping
// `.`/`*`/etc.) — harmless today since every real token name (`--danger`, `--surface`, …) is
// hyphen-only, but latent. This is the standard escape-regexp-metacharacters pattern.
function extractToken(blockText: string | null, tokenName: string): string | null {
  if (!blockText) return null;
  const escaped = tokenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}:\\s*([^;]+);`);
  return re.exec(blockText)?.[1]?.trim() ?? null;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = Number.parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function srgbChannelToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('Button — T-334 slice 2 contract', () => {
  // -------------------------------------------------------------------------------------------
  // ADR-013 Amendment 6, RULED FINAL 2026-09-24: the focus ring goes neutral (ring-ink), not
  // brand — "focused" and "invalid" both being red made a focused field look like an error in
  // dark mode. Two SEPARATE figures, corrected here (audit round 2) after being conflated:
  // ring #d40909 vs dark invalid border #f87171 = 1.98:1 — FAILS the 3:1 floor, meaning the two
  // states read as barely distinguishable, which is the actual problem being fixed; separately,
  // the ring's own visibility against dark --surface #171717 is 3.28:1, which DOES clear 3:1
  // (barely). Verified on screen first (RENDER-E4, 2026-09-23): light ring-ink = #1a1a1a, dark
  // ring-ink = #fafafa, both distinguishable from the invalid border in both themes.
  // -------------------------------------------------------------------------------------------
  // T-387 S2 (docs/tasks/387-...md "### S2", L2): the exact class-token snapshots are REWRITTEN, on
  // purpose — rounded-[12px] (t387-q3 = b), font-semibold, one 44px height (t387-q4 = a, `min-h-11`:
  // the census reads `min-h-N` as N*4 px, touch-target-geometry.ts:439), secondary hover:bg-canvas,
  // and the new `ghost` variant. The focus idiom is Amendment 6 (`ring-ink`) and is unchanged.
  const BASE_SNAPSHOT =
    'inline-flex items-center gap-2 min-h-11 rounded-[12px] px-4 py-2.5 text-sm font-semibold disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface';
  const VARIANT_SNAPSHOT = {
    primary: 'border border-transparent bg-brand text-white hover:bg-brand-hover',
    secondary: 'border border-surface-border bg-surface text-ink hover:bg-canvas',
    ghost: 'border border-transparent bg-transparent text-ink hover:bg-canvas',
    danger: 'border border-danger text-danger',
  } as const;
  const sorted = (s: string | Set<string>) => [...(typeof s === 'string' ? s.split(/\s+/).filter(Boolean) : s)].sort();

  for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
    it(`${variant}: the rendered class-token set equals the BASE + variant snapshot exactly (T-387 S2)`, () => {
      const html = renderToStaticMarkup(createElement(Button, { variant, children: 'X' }));
      expect(sorted(classTokens(html))).toEqual(sorted(`${BASE_SNAPSHOT} ${VARIANT_SNAPSHOT[variant]}`));
    });
  }

  it('emits focus-visible:ring-ink and NOT focus-visible:ring-brand on every variant (ADR-013 Amendment 6, kept)', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const tokens = classTokens(renderToStaticMarkup(createElement(Button, { variant, children: 'X' })));
      expect(tokens.has('focus-visible:ring-ink'), variant).toBe(true);
      expect(tokens.has('focus-visible:ring-brand'), variant).toBe(false);
    }
  });

  const FORBIDDEN_SHAPE = /^rounded-(full|md|lg|xl|2xl|3xl)$/;
  it('shape and weight: rounded-[12px] + font-semibold + min-h-11, and NEVER rounded-full / rounded-md / font-medium (t387-q3, t387-q4)', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const tokens = classTokens(renderToStaticMarkup(createElement(Button, { variant, children: 'X' })));
      expect(tokens.has('rounded-[12px]'), variant).toBe(true);
      expect(tokens.has('font-semibold'), variant).toBe(true);
      expect(tokens.has('min-h-11'), variant).toBe(true);
      expect([...tokens].filter((t) => FORBIDDEN_SHAPE.test(t)), variant).toEqual([]);
      expect(tokens.has('font-medium'), variant).toBe(false);
    }
  });

  // NEGATIVE: the same absence predicate the test above uses, applied to a mutated class string.
  it('mutation check: a rounded-full (or rounded-md) Button class string is caught by the shape predicate', () => {
    const hasForbiddenShape = (cls: string) => cls.split(/\s+/).some((t) => FORBIDDEN_SHAPE.test(t));
    expect(hasForbiddenShape(`${BASE_SNAPSHOT} ${VARIANT_SNAPSHOT.primary}`)).toBe(false);
    expect(hasForbiddenShape(BASE_SNAPSHOT.replace('rounded-[12px]', 'rounded-full'))).toBe(true);
    expect(hasForbiddenShape(BASE_SNAPSHOT.replace('rounded-[12px]', 'rounded-md'))).toBe(true);
  });

  it('secondary has hover:bg-canvas; primary keeps hover:bg-brand-hover and has no hover:bg-canvas', () => {
    const sec = classTokens(renderToStaticMarkup(createElement(Button, { variant: 'secondary', children: 'X' })));
    const pri = classTokens(renderToStaticMarkup(createElement(Button, { variant: 'primary', children: 'X' })));
    expect(sec.has('hover:bg-canvas')).toBe(true);
    expect(pri.has('hover:bg-canvas')).toBe(false);
  });

  it('ghost (Cancel): transparent fill and border, text-ink, hover:bg-canvas; no bg-brand, no border-danger, no icon', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'ghost', children: 'Cancel' }));
    const t = classTokens(html);
    for (const need of ['border-transparent', 'bg-transparent', 'text-ink', 'hover:bg-canvas']) expect(t.has(need), need).toBe(true);
    expect(t.has('bg-brand')).toBe(false);
    expect(t.has('border-danger')).toBe(false);
    expect(t.has('text-danger')).toBe(false);
    expect(html).not.toContain('<svg');
  });

  it('danger stays OUTLINED with its icon: border-danger text-danger, no solid bg-danger, keeps <svg> (ADR-013 §1)', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'danger', children: 'Delete' }));
    const t = classTokens(html);
    expect(t.has('border-danger') && t.has('text-danger')).toBe(true);
    expect(t.has('bg-danger')).toBe(false);
    expect(html).toContain('<svg');
  });

  it('primary emits a solid brand fill and a hover class (§4.1)', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'primary', children: 'Save' }));
    const tokens = classTokens(html);
    expect(tokens.has('bg-brand')).toBe(true);
    expect(tokens.has('hover:bg-brand-hover')).toBe(true);
    // §9 R1: text-white is the named, permitted exception to token discipline for this one position.
    expect(tokens.has('text-white')).toBe(true);
  });

  it('secondary is the default when no variant is passed, asserted as a literal (§4.2)', () => {
    const defaultHtml = renderToStaticMarkup(createElement(Button, { children: 'Cancel' }));
    const secondaryHtml = renderToStaticMarkup(
      createElement(Button, { variant: 'secondary', children: 'Cancel' }),
    );
    // The positive literal: §3's own prose names `text-ink` for secondary. Absence-only assertions
    // (no bg-brand, no border-danger) would be satisfied by the null stub, which is why this line —
    // not the equality below — is what must fail first at RED.
    expect(classTokens(defaultHtml).has('text-ink')).toBe(true);
    // The literal: default output must be byte-identical to explicit variant="secondary" output.
    expect(defaultHtml).toBe(secondaryHtml);
    expect(classTokens(defaultHtml).has('bg-brand')).toBe(false);
    expect(classTokens(defaultHtml).has('border-danger')).toBe(false);
  });

  it('danger emits no solid brand/danger fill and does emit an outline (§4.3)', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'danger', children: 'Delete' }));
    const tokens = classTokens(html);
    expect(tokens.has('bg-brand')).toBe(false);
    // Token, not substring: bg-danger-surface must not make this assertion vacuous either way —
    // Button's danger treatment (§3) never uses a surface fill at all.
    expect(tokens.has('bg-danger')).toBe(false);
    expect(tokens.has('bg-danger-surface')).toBe(false);
    expect(tokens.has('border-danger')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // ADR-013 Amendment 5 — Ian ruled the dark-mode red 2026-09-23, replacing the test that pinned
  // the gap open (which asserted Button never carries a `dark:text-*` override). It still doesn't,
  // but that's no longer the interesting fact: the fix lives in `globals.css`'s CSS-variable
  // tokens, not in a Tailwind `dark:` utility on the component — Button and Input keep using
  // `text-danger`/`border-danger`, and the theme swaps the value underneath them. So this is now a
  // globals.css contrast test, not a Button-render test; it stays in this file because it pins
  // Button's own danger contract, same as the rest of this describe block.
  // ---------------------------------------------------------------------------------------------

  it('dark --danger clears 4.5:1 against dark --surface, dark --danger-surface is defined and clears 4.5:1 too, and light --danger is unchanged (ADR-013 Amendment 5)', () => {
    const css = readGlobalsCss();
    const lightBlock = extractRootBlock(css, false);
    const darkBlock = extractRootBlock(css, true);

    const darkDanger = extractToken(darkBlock, '--danger');
    const darkSurface = extractToken(darkBlock, '--surface');
    const darkDangerSurface = extractToken(darkBlock, '--danger-surface');
    const lightDanger = extractToken(lightBlock, '--danger');

    // (1) dark --danger clears 4.5:1 (text) against dark --surface.
    expect(darkDanger, 'dark --danger is not yet defined in globals.css\'s :root[data-theme="dark"] block').toBeTruthy();
    expect(darkSurface, 'dark --surface is not defined').toBeTruthy();
    const dangerOnSurface = contrastRatio(darkDanger as string, darkSurface as string);
    expect(dangerOnSurface, `dark --danger vs dark --surface measured ${dangerOnSurface.toFixed(2)}:1, need >= 4.5:1`).toBeGreaterThanOrEqual(4.5);

    // (2) dark --danger-surface is defined, and --danger clears 4.5:1 on it.
    expect(darkDangerSurface, 'dark --danger-surface is not yet defined').toBeTruthy();
    const dangerOnDangerSurface = contrastRatio(darkDanger as string, darkDangerSurface as string);
    expect(dangerOnDangerSurface, `dark --danger vs dark --danger-surface measured ${dangerOnDangerSurface.toFixed(2)}:1, need >= 4.5:1`).toBeGreaterThanOrEqual(4.5);

    // (3) NEGATIVE — a "fix" that changes the light red instead must fail this.
    expect(lightDanger).toBe('#a00606');
  });

  it('mutation check (audit round 2, item 4): extractToken actually escapes regex metacharacters in the token name', () => {
    // No real CSS custom property name contains a regex metacharacter, so this can't be proven
    // against real tokens — proven against a synthetic one instead. A `.` in an UNESCAPED position
    // would match ANY character, so `weirdXtoken` would wrongly match too; escaped, only the
    // literal dot does.
    const block = 'weird.token: #123456;';
    expect(extractToken(block, 'weird.token')).toBe('#123456');
    expect(extractToken(block, 'weirdXtoken')).toBeNull();
  });

  it('mutation check: contrastRatio reproduces ADR-013\'s own published, independently-measured figures', () => {
    expect(contrastRatio('#a00606', '#171717')).toBeCloseTo(2.15, 1); // Amendment 4
    expect(contrastRatio('#f87171', '#171717')).toBeCloseTo(6.48, 1); // Amendment 5, on --surface
    expect(contrastRatio('#f87171', '#0a0a0a')).toBeCloseTo(7.16, 1); // Amendment 5, on --canvas
    expect(contrastRatio('#a00606', '#ffffff')).toBeCloseTo(8.32, 1); // §1, light on white
  });

  it('mutation check: a "fix" that changes the light --danger instead of adding a dark one is caught by the negative half', () => {
    // Audit finding F8: `.not.toBe('#a00606')` alone would pass just as well if extraction were
    // broken and returned null/undefined — a negative with no positive to anchor it. Asserting the
    // literal mutated value proves extraction actually read '#ff0000', not merely "read something
    // that isn't #a00606".
    const css = ":root { --danger: #ff0000; }\n:root[data-theme='dark'] { --danger: #f87171; --danger-surface: #2a0f0f; --surface: #171717; }";
    const lightDanger = extractToken(extractRootBlock(css, false), '--danger');
    expect(lightDanger).toBe('#ff0000');
    expect(lightDanger).not.toBe('#a00606');
  });

  it('renders no dark:text-* override of its own — the fix lives in globals.css\'s tokens, not a component utility (Amendment 5: "do not copy #f87171 into a component or a dark: utility")', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'danger', children: 'Delete' }));
    const tokens = classTokens(html);
    const hasDarkTextOverride = [...tokens].some((t) => /^dark:text-/.test(t));
    expect(hasDarkTextOverride).toBe(false);
  });

  it('renders a hand-drawn icon only for the danger variant — positive/negative control pair (§9 R3)', () => {
    const danger = renderToStaticMarkup(createElement(Button, { variant: 'danger', children: 'Delete' }));
    const primary = renderToStaticMarkup(createElement(Button, { variant: 'primary', children: 'Save' }));
    const secondary = renderToStaticMarkup(createElement(Button, { variant: 'secondary', children: 'Cancel' }));

    // Positive half.
    expect(danger).toContain('<svg');
    expect(danger).toMatch(/aria-hidden="true"/);

    // Negative half — R3: "the negative half is what gives the positive half meaning. An
    // assertion that an icon is present, with no case proving it can ever be absent, is satisfied
    // by a component that always renders one."
    expect(primary).not.toContain('<svg');
    expect(secondary).not.toContain('<svg');
  });

  it('defaults type to "button", and an explicit type="submit" survives (§4.4)', () => {
    const defaultHtml = renderToStaticMarkup(createElement(Button, { children: 'Save' }));
    expect(defaultHtml).toMatch(/type="button"/);

    const submitHtml = renderToStaticMarkup(createElement(Button, { type: 'submit', children: 'Save' }));
    expect(submitHtml).toMatch(/type="submit"/);
    expect(submitHtml).not.toMatch(/type="button"/);
  });

  it('appends a passed className to its own classes rather than replacing them (§4.6)', () => {
    // Combined with variant="primary" so a REPLACE implementation (which would drop bg-brand) is
    // caught — the contract never states Button's own base/layout classes literally, so token
    // co-presence is the assertion available without inventing an unstated literal.
    const html = renderToStaticMarkup(
      createElement(Button, { variant: 'primary', className: 'mt-2', children: 'Save' }),
    );
    const tokens = classTokens(html);
    expect(tokens.has('mt-2')).toBe(true);
    expect(tokens.has('bg-brand')).toBe(true);
  });

  it('renders its children — asserted on real content, not emptiness (§11.1)', () => {
    // §4 enumerated what to assert on classes/attributes and never required the component to BE a
    // component: the audit's mutant (no {children}, no {...rest}) passed all 11 prior assertions.
    // This is the check the enumeration left out.
    const html = renderToStaticMarkup(createElement(Button, { children: 'Save changes' }));
    expect(html).toContain('Save changes');

    // Negative half (round 3 finding): the line above alone is satisfied by a Button that
    // hardcodes "Save changes" regardless of props — same control-pair shape §9 R3 requires for
    // the danger icon. Different children must produce different output.
    const otherHtml = renderToStaticMarkup(createElement(Button, { children: 'Cancel' }));
    expect(otherHtml).toContain('Cancel');
    expect(otherHtml).not.toContain('Save changes');
  });

  it('forwards disabled through {...rest} (§11.2)', () => {
    // ⚠️ Caught by my own mutant-dies check: `\bdisabled\b` also matches the static Tailwind
    // variant classes `disabled:pointer-events-none`/`disabled:opacity-50`, which are present on
    // every render whether or not the element is actually disabled — a vacuous assertion, same
    // shape as matching a substring instead of a token. `disabled=""` is the literal, unambiguous
    // serialisation of the real boolean attribute (verified against the real component's output);
    // the CSS variant prefix is followed by `:`, never `=""`, so this cannot collide with it.
    const html = renderToStaticMarkup(createElement(Button, { disabled: true, children: 'Save' }));
    expect(html).toContain('disabled=""');

    // Negative half (round 3 finding): the line above alone is satisfied by a Button that is
    // unconditionally disabled — exactly the real defect a reviewer planted and reverted today.
    const notDisabledHtml = renderToStaticMarkup(createElement(Button, { children: 'Save' }));
    expect(notDisabledHtml).not.toContain('disabled=""');
  });

  it('forwards onClick through {...rest} (§11.2)', () => {
    // onClick cannot appear in static HTML — React never serialises event handlers into markup —
    // so this is the one case in this file that does not use renderToStaticMarkup. Button is a
    // plain function component (guard 10: no hooks), so calling it directly and reading the
    // React element it returns is the only way to observe prop forwarding that never reaches the
    // DOM. `any` here is deliberate: asserting Button's exact prop type would mean engaging with
    // its implementation, which is the auditor's lane, not this file's.
    const handleClick = () => {};
    const element: any = Button({ onClick: handleClick, children: 'Save' } as any);
    expect(element.props.onClick).toBe(handleClick);
  });
});
