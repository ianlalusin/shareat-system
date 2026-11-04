import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * T-517 guard: every domain writer that changes a fixed asset's depreciation reads the asset with its row lock
 * (`getByIdForUpdate`) so they serialise (T-515, T-516, T-517). An UNLOCKED `fixedAssetsRepo.getById(` in
 * packages/domain/src is allowed only where listed here, with the reason. A new call site fails this test on purpose:
 * lock first (`getByIdForUpdate`) or add it here with why a stale read is safe.
 */
const ROOT = path.resolve(__dirname, '../../packages/domain/src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const ALLOWED_UNLOCKED: Record<string, string> = {
  // depreciateAsset pre-check only; postPeriodsFor re-reads with getByIdForUpdate before judging (depreciate.ts:136).
  'fixed-assets/depreciate.ts': 'pre-check, re-read locked before any write',
};

describe('T-517: fixed-asset writers read the asset with its row lock', () => {
  it('no unlocked fixedAssetsRepo.getById( outside the allowlist', () => {
    const hits = files(ROOT)
      .filter((f) => /fixedAssetsRepo\.getById\(/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).replaceAll(path.sep, '/'))
      .sort();
    expect(hits).toEqual(Object.keys(ALLOWED_UNLOCKED).sort());
  });

  it('bookMissedMonth, dispose, in-service and retire take the lock', () => {
    for (const f of ['missed-months/index.ts', 'fixed-assets/dispose.ts', 'fixed-assets/in-service.ts', 'fixed-assets/capitalize.ts', 'fixed-assets/terms.ts']) {
      expect(readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/getByIdForUpdate\(/);
    }
  });
});
