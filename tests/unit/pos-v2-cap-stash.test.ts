import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const POS = path.resolve(__dirname, '..', '..', 'apps', 'pos');
describe('T-424 audit - the build:cap stash', () => {
  it('.cap-stash/ is gitignored (a crashed run must not leave server files to be committed)', () => {
    expect(readFileSync(path.join(POS, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim())).toContain('.cap-stash/');
  });
  it('a stash left by a crashed run is restored first, with a printed warning', () => {
    const s = readFileSync(path.join(POS, 'scripts', 'build-cap.mjs'), 'utf8');
    expect(s).toMatch(/console\.warn\([^)]*\.cap-stash[^)]*crashed/);
    expect(s.indexOf('crashed earlier run')).toBeLessThan(s.indexOf('stash();\n  const r'));
  });
});

describe('T-424 audit - no client writer of money without a PIN', () => {
  it('the dead client writers createRefundReceipt and voidSession are gone from components/cashier/firestore.ts', () => {
    const s = readFileSync(path.join(POS, 'src', 'components', 'cashier', 'firestore.ts'), 'utf8');
    expect(s).not.toMatch(/function\s+createRefundReceipt\b/);
    expect(s).not.toMatch(/function\s+voidSession\b/);
  });
});
