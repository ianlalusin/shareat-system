import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/lib/constraint-messages';

/**
 * T-326 — DEF-379. `parseMoneyInput` exists precisely to turn a bad money string into a sentence
 * a cashier can act on, but `packages/domain/package.json`'s `exports` map has no `./money-input`
 * entry and the barrel doesn't re-export it — so `apps/erp`, where cashiers' typed amounts
 * actually land, cannot import it at all. The app's only options today are `money()` (a raw
 * `TypeError`) or `Number()` (DEF-272).
 *
 * ⛔ Fixing this needs THREE files, not two — packages/domain/package.json (exports),
 * vitest.config.mts (this test's own resolver), AND apps/erp/tsconfig.json (typecheck's resolver,
 * which has no `@shareat/domain/*` wildcard of its own and overrides the root's on `extends`).
 *
 * ⚠️ Both tests below import dynamically (`await import(...)` inside the test body), never as a
 * static top-level import. A static import of an unresolvable specifier fails the whole MODULE,
 * which would report every test in this file as broken rather than the one that actually
 * exercises the gap — the "import failure read as an assertion failure" trap the spec warns
 * against for T6. This way the two failure shapes stay distinguishable in the RED report.
 */
describe('T6 / Contract §1 — parseMoneyInput resolves from apps/erp by package name', () => {
  it('imports through @shareat/domain/money-input and behaves like the domain function', async () => {
    const { parseMoneyInput } = await import('@shareat/domain/money-input');
    expect(parseMoneyInput('12.50', 'x', 'The amount')).toBe('12.50');
  });

  // ⛔ The test above resolves through VITEST'S OWN alias map (vitest.config.mts), not through
  // packages/domain/package.json's `exports` — the real build's resolution mechanism. Delete the
  // `exports` entry and the test above, plus typecheck (covered by tsconfig's own path), still
  // pass; only `next build` or the running app would notice. This reads the file directly so the
  // one entry nothing else here exercises has a gate that isn't the build or the screen.
  it('packages/domain/package.json exports "./money-input" at src/shared/money-input.ts', () => {
    const pkgPath = path.resolve(__dirname, '../../../packages/domain/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports?: Record<string, string> };
    expect(pkg.exports?.['./money-input']).toBe('./src/shared/money-input.ts');
  });
});

describe('T7 — a bad money string from the app layer produces a cashier-readable sentence', () => {
  it("is not money()'s raw TypeError, once routed through errorMessage", async () => {
    const { parseMoneyInput } = await import('@shareat/domain/money-input');

    let caught: unknown;
    try {
      parseMoneyInput('abc', 'createCashRequest: the amount', 'The amount');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const shown = errorMessage(caught);
    expect(shown).not.toContain('TypeError');
    expect(shown).not.toContain('Invalid money string');
    expect(shown).toContain('is not a valid amount');
  });
});
