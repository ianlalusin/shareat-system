/**
 * Input — T-334 slice 2 component contract (docs/tasks/334-slice-2-component-contract.md §3, §4).
 *
 * ⚠️ `.ts`, not `.tsx` — see `ui-button.test.ts`'s header for the full reason (DEF-081/DEF-221
 * shape: the unit project's include glob has no `.tsx` variant). Same pattern as
 * `filter-row.test.ts`: `createElement` + `renderToStaticMarkup`, `environment: 'node'`.
 *
 * Corrected 2026-09-23 (audit finding F7): Input was a STUB (`export function Input(): null`)
 * pre-wired by the orchestrator ONLY for slice 2's own RED, so red then was an assertion failure,
 * not a module-not-found. It has been fully implemented since slice 2 shipped, and R2 (T-334
 * slice 3) since landed on top of it — this file's own assertions prove the current state, not
 * this header.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input } from '../src/components/ui/Input';

function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    // Guard, not `!`: noUncheckedIndexedAccess types a capture group as possibly undefined even
    // though this regex always has group 1 on a match; `?? ''` degrades to a no-op split instead.
    for (const t of (m[1] ?? '').split(/\s+/)) if (t) tokens.add(t);
  }
  return tokens;
}

describe('Input — T-334 slice 2 contract', () => {
  // -------------------------------------------------------------------------------------------
  // ADR-013 Amendment 6, RULED FINAL 2026-09-24 — see ui-button.test.ts's header comment for the
  // full ruling. Same fix, same shared focus idiom as Button (Input.tsx's own header note).
  // -------------------------------------------------------------------------------------------
  it('emits focus-visible:ring-ink and NOT focus-visible:ring-brand — token-level, both halves; nothing else in the class string changes (ADR-013 Amendment 6, FINAL)', () => {
    const html = renderToStaticMarkup(createElement(Input, { name: 'x' })); // valid (default) state
    const tokens = classTokens(html);

    expect(tokens.has('focus-visible:ring-ink')).toBe(true);
    expect(tokens.has('focus-visible:ring-brand')).toBe(false);

    // "Nothing else changes" — a literal snapshot of Input's PRE-Amendment-6, valid-state class
    // string (R2 base + border-surface-border, captured 2026-09-23), with only the one ring
    // token swapped.
    const preAmendment6Valid =
      'rounded-md border bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface border-surface-border';
    const expectedOthers = new Set(preAmendment6Valid.split(/\s+/).filter(Boolean));
    expectedOthers.delete('focus-visible:ring-brand');

    const actualOthers = new Set(tokens);
    actualOthers.delete('focus-visible:ring-ink');

    expect([...actualOthers].sort()).toEqual([...expectedOthers].sort());
  });

  it('invalid emits both border-danger and aria-invalid="true" — positive/negative control pair (§4.5)', () => {
    const invalidHtml = renderToStaticMarkup(createElement(Input, { invalid: true, name: 'email' }));
    const validHtml = renderToStaticMarkup(createElement(Input, { name: 'email' }));

    // Positive half — ⭐ the spec's own warning: "assert both; the ARIA half is the half that gets
    // dropped."
    expect(classTokens(invalidHtml).has('border-danger')).toBe(true);
    expect(invalidHtml).toMatch(/aria-invalid="true"/);

    // Negative half — same control-pair reasoning §9 R3 states for Button's icon: an assertion
    // that border-danger/aria-invalid appear when invalid, with no case proving they can ever be
    // absent, is satisfied by an Input that always renders them.
    expect(classTokens(validHtml).has('border-danger')).toBe(false);
    expect(validHtml).not.toMatch(/aria-invalid="true"/);
  });

  it('a caller-supplied aria-invalid cannot override the component\'s own when invalid is true (audit finding, §3/§4.5)', () => {
    // Colour is never the sole channel (§4.5): if a caller's own aria-invalid can win over the
    // component's, invalid renders a red border with nothing for a screen reader. Only
    // aria-invalid is at risk here — className is already destructured out of ...rest in Input,
    // and Button/Card don't accept an aria-invalid prop at all, so this case does not generalise.
    const html = renderToStaticMarkup(
      createElement(Input, { invalid: true, 'aria-invalid': 'false', name: 'email' }),
    );
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).not.toMatch(/aria-invalid="false"/);
  });

  it('appends a passed className to its own classes rather than replacing them (§4.6)', () => {
    // Combined with invalid=true so a REPLACE implementation (which would drop border-danger) is
    // caught — the contract never states Input's own base/layout classes literally.
    const html = renderToStaticMarkup(
      createElement(Input, { invalid: true, className: 'mt-2', name: 'email' }),
    );
    const tokens = classTokens(html);
    expect(tokens.has('mt-2')).toBe(true);
    expect(tokens.has('border-danger')).toBe(true);
  });

  it('forwards name, required and placeholder through {...rest} (§11.2)', () => {
    // §4 enumerated what to assert on classes/attributes and never required native attributes to
    // actually reach the DOM: the audit's mutant (no {...rest}) rendered without name, required or
    // placeholder and still passed every prior assertion. Input has no `children` prop (a native
    // void `<input>` cannot take one, and §3 lists none), so §11.1's children requirement does not
    // apply here — only §11.2's rest-forwarding does.
    const html = renderToStaticMarkup(
      createElement(Input, { name: 'email', required: true, placeholder: 'you@example.com' }),
    );
    expect(html).toContain('name="email"');
    // Literal `required=""`, not a `\brequired\b` word-boundary regex: the Button disabled-check
    // in this same round turned out to match Tailwind's `disabled:` variant-class prefix as well
    // as the real attribute — the literal serialised form is what a static-HTML render actually
    // produces and cannot collide with a class-name prefix.
    expect(html).toContain('required=""');
    expect(html).toContain('placeholder="you@example.com"');

    // Negative half (round 3 finding): the block above alone is satisfied by an Input that
    // hardcodes these three regardless of props — a reviewer planted exactly a bare `required`
    // today and the suite stayed green. Confirm each is absent when not passed.
    const omittedHtml = renderToStaticMarkup(createElement(Input, {}));
    expect(omittedHtml).not.toContain('name="email"');
    expect(omittedHtml).not.toContain('required=""');
    expect(omittedHtml).not.toContain('placeholder="you@example.com"');
  });
});

// ---------------------------------------------------------------------------------------------
// R2 (task §6, auditor's D2 + the orchestrator's correction): Input's base carried `block w-full`,
// and Tailwind resolves the conflict with a caller's own width by STYLESHEET ORDER (`.w-full` is
// emitted after `.w-40`), so a caller's width always lost. Fixed by removing `block w-full` from
// Input's own base — the component owns geometry, the caller owns layout (T-334 slice 3 §2).
// ⚠️ Cascade order cannot be observed by rendering static HTML (no stylesheet is loaded here), so
// (g) is what actually pins the fix: proving Input stops EMITTING the conflicting utility itself.
// (h) is the companion negative — the fix must not start dropping a caller's layout classes while
// removing its own.
// ---------------------------------------------------------------------------------------------

describe('(g)/(h) Input owns geometry only; the caller owns layout — R2', () => {
  it('(g) Input\'s own render carries no width or display token of its own', () => {
    const html = renderToStaticMarkup(createElement(Input, { name: 'x' }));
    const tokens = classTokens(html);
    const ownWidthOrDisplay = [...tokens].filter((t) => /^(w-[\w.]+|block|inline(-\w+)?|flex)$/.test(t));
    expect(ownWidthOrDisplay, `Input's own render should carry no width/display token; got [${ownWidthOrDisplay.join(', ')}]`).toEqual([]);
  });

  it('mutation check: the (g) filter catches Input\'s PRE-R2 base string, which carried block w-full', () => {
    // Audit finding F9: this was named "CURRENT base" — stale the moment R2 landed and removed
    // `block w-full` from Input's real, live base. This string is the OLD (pre-fix) base, kept only
    // as a mutation fixture proving the (g) filter would have caught it.
    const tokens = new Set('block w-full rounded-md border bg-surface px-3 py-2 text-sm text-ink'.split(' '));
    const flagged = [...tokens].filter((t) => /^(w-[\w.]+|block|inline(-\w+)?|flex)$/.test(t));
    expect(flagged.sort()).toEqual(['block', 'w-full']);
  });

  it('(h) a caller-supplied layout class (width, alignment) arrives as a token, unopposed — alone and combined with invalid', () => {
    const alone = classTokens(renderToStaticMarkup(createElement(Input, { name: 'x', className: 'w-32 text-right' })));
    expect(alone.has('w-32')).toBe(true);
    expect(alone.has('text-right')).toBe(true);

    const withInvalid = classTokens(
      renderToStaticMarkup(createElement(Input, { name: 'x', invalid: true, className: 'w-32 text-right' })),
    );
    expect(withInvalid.has('w-32')).toBe(true);
    expect(withInvalid.has('text-right')).toBe(true);
    expect(withInvalid.has('border-danger')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// (i) The invalid border's dark contrast — ADR-013 Amendment 5, `--danger` under
// `:root[data-theme='dark']` must clear 3:1 (WCAG 1.4.11, non-text — this is a border, not text)
// against dark `--surface`. Parsed by declaration NAME inside the correct selector block, never a
// whole-file substring: `#a00606` also appears in this file's own comments (family (a)).
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readGlobalsCss(): string {
  return readFileSync(path.join(REPO_ROOT, 'apps/erp/src/app/globals.css'), 'utf8');
}

/** The declarations text inside `:root { ... }` (light) or `:root[data-theme='dark'] { ... }`
 *  (dark) — never a whole-file scan, so a token can only be read from the block it actually
 *  belongs to. */
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

describe('(i) dark invalid-border contrast — ADR-013 Amendment 5', () => {
  it('the dark --danger token clears 3:1 (non-text floor) against dark --surface', () => {
    const css = readGlobalsCss();
    const darkBlock = extractRootBlock(css, true);
    const dangerHex = extractToken(darkBlock, '--danger');
    const surfaceHex = extractToken(darkBlock, '--surface');
    expect(dangerHex, 'dark --danger is not yet defined in globals.css\'s :root[data-theme="dark"] block').toBeTruthy();
    expect(surfaceHex, 'dark --surface is not defined').toBeTruthy();
    const ratio = contrastRatio(dangerHex as string, surfaceHex as string);
    expect(ratio, `dark --danger vs dark --surface measured ${ratio.toFixed(2)}:1, need >= 3:1`).toBeGreaterThanOrEqual(3);
  });

  it('mutation check: contrastRatio reproduces ADR-013\'s own published, independently-measured figures', () => {
    // Amendment 4: #a00606 on the dark surface #171717 measures 2.15:1.
    expect(contrastRatio('#a00606', '#171717')).toBeCloseTo(2.15, 1);
    // Amendment 5: the ruled dark red #f87171 on #171717 measures 6.48:1.
    expect(contrastRatio('#f87171', '#171717')).toBeCloseTo(6.48, 1);
    // §1: light --danger #a00606 on white is 8.32:1.
    expect(contrastRatio('#a00606', '#ffffff')).toBeCloseTo(8.32, 1);
  });

  it('mutation check: extractToken reads by name inside the right block, not a whole-file substring — #a00606 also appears in comments', () => {
    const css = "/* #a00606 mentioned in a comment, wrong block */\n:root { --danger: #a00606; }\n:root[data-theme='dark'] { --danger: #f87171; }";
    expect(extractToken(extractRootBlock(css, false), '--danger')).toBe('#a00606');
    expect(extractToken(extractRootBlock(css, true), '--danger')).toBe('#f87171');
  });

  it('mutation check: a missing dark token returns null (a usable red), not a throw', () => {
    const css = ":root { --danger: #a00606; }\n:root[data-theme='dark'] { color-scheme: dark; }";
    expect(extractToken(extractRootBlock(css, true), '--danger')).toBeNull();
    expect(() => extractToken(extractRootBlock(css, true), '--danger')).not.toThrow();
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
});
