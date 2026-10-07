/**
 * `safeNext` — the sign-in page's open-redirect guard. T-232 slice 1, review item 1.
 *
 * ## ⭐ Why this test exists at all
 *
 * `next` comes from the URL, and whatever it says is where a successful sign-in lands. So an open
 * redirect here is not a cosmetic bug: it produces a link that shows the **real** sign-in form on the
 * **real** domain, takes a real password, and then hands the visitor to somebody else's page. The
 * two shapes below both did that.
 *
 * | Was accepted by | `next` | Because |
 * |---|---|---|
 * | `page.tsx`'s inline check | `//evil.com` | `startsWith('/')` is true of a protocol-relative URL |
 * | `actions.ts`' old `safeNext` | `/\evil.com` | it rejected `//` and nothing looked for a backslash — **which a URL parser reads as a slash** |
 *
 * ⚠️ **The good cases are half the test.** A guard that refuses everything passes every negative
 * assertion and silently sends every sign-in to the same page — so `/sales-days` would still be
 * "green" while `?next=/expenses` had quietly stopped working. Both halves, or neither is evidence.
 *
 * ⚠️ Statically imported on purpose: `apps/erp/src/app/sign-in/lib.ts` reaches `@shareat/db` and
 * `@shareat/auth`, whose cold import was measured at ~4.6 s — inside a test with
 * `vi.resetModules()` that alone blows the unit project's 5 s default timeout, which is how T-232's
 * first test failed for a reason that had nothing to do with the code under test.
 */
import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/app/sign-in/lib';

const DEFAULT_NEXT = '/sales-days';

describe('safeNext — only ever a path on this app', () => {
  it('⛔ refuses every shape a browser would read as another origin', () => {
    // Each of these is `https://evil.com` (or a script) once a browser parses it.
    expect(safeNext('//evil.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\\evil.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('//evil.com/sales-days')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\\\\evil.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('javascript:alert(1)')).toBe(DEFAULT_NEXT);
    expect(safeNext('https://evil.com')).toBe(DEFAULT_NEXT);
  });

  it('⛔ refuses anything that is not a path at all', () => {
    expect(safeNext('')).toBe(DEFAULT_NEXT);
    expect(safeNext('sales-days')).toBe(DEFAULT_NEXT);
    expect(safeNext('   ')).toBe(DEFAULT_NEXT);
  });

  it('✅ passes a real in-app path through unchanged — the half that keeps the feature working', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/sales-days')).toBe('/sales-days');
    expect(safeNext('/expenses?month=2026-09')).toBe('/expenses?month=2026-09');
    expect(safeNext('/inventory/deliveries#latest')).toBe('/inventory/deliveries#latest');
  });
});

describe('safeNext - control characters (audit: browsers strip tab/CR/LF, so "/\t/evil.example" is "//evil.example")', () => {
  it.each(['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '\t//evil.example', '/\u0000/evil.example', '/a\u007fb', '/a\u001fb'])(
    '⛔ %j falls back to the default',
    (bad) => {
      expect(safeNext(bad)).toBe(DEFAULT_NEXT);
      // Mutant: safeNext without a control-character test (/[\x00-\x1f\x7f]/) -> red.
    },
  );

  it('✅ a good path with a query still passes (the guard does not over-refuse)', () => {
    expect(safeNext('/expenses?month=2026-09')).toBe('/expenses?month=2026-09');
  });
});
