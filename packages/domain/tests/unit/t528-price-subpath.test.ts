import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-528 R1/R5 (TESTER) - the browser-safe pricing leaf. `@shareat/domain/pos/price` must resolve where workspace subpaths resolve: the package's `exports`
 * and the root vitest alias (the client-bundle-boundary guard then walks the leaf's imports).
 * ASSUMED API: package subpath "@shareat/domain/pos/price" -> packages/domain/src/pos/price.ts (exports priceSession).
 * RED NOW FOR THE RIGHT REASON: the subpath is not declared anywhere yet.
 */
const root = resolve(__dirname, '..', '..', '..', '..');

describe('@shareat/domain/pos/price subpath (T-528 R1)', () => {
  it('is declared in packages/domain/package.json exports, pointing at the pure leaf', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'packages/domain/package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./pos/price']).toBe('./src/pos/price.ts');
  });

  it('has an exact vitest alias entry (before the bare @shareat/domain name)', () => {
    const cfg = readFileSync(resolve(root, 'vitest.config.mts'), 'utf8');
    const sub = cfg.indexOf("'@shareat/domain/pos/price'");
    const bare = cfg.indexOf("'@shareat/domain':");
    expect(sub, 'alias entry exists').toBeGreaterThan(-1);
    expect(sub).toBeLessThan(bare);
  });

  it('resolves and exports priceSession', async () => {
    const mod = (await import(/* @vite-ignore */ '@shareat/domain/pos/price' as string)) as { priceSession?: unknown };
    expect(typeof mod.priceSession).toBe('function');
  });
});
