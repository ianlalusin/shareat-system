/**
 * T-511 S5b (TESTER, 2026-11-05) - every new export of slice 5b has a production caller, said BEFORE the production-caller ratchet and domain-actions-have-callers say it
 * (those two fail far from the cause: a new name joining the zero-caller set, or an `(tx, actor)` export with no `apps/` caller). docs/tasks/511-settlement-upload-s5-spec.md
 * "Guards that must stay green". A function with a test and no caller passes its test (DEF-082 ... DEF-190): the screens must reach all of them.
 *
 * RED today, for one reason: none of the S5b exports exists yet, so none has a caller.
 *
 * CONTRACT:
 *  P1  `rejectDay`, `reopenDay`, `overrideLoanAllocation`, `listReviewDays`, `getReviewDayDetail` and `dayBlockers` (each takes `(tx, actor, ...)`) are each named in production
 *      code under apps/erp/src (a non-test .ts/.tsx file) - the screens call them, directly or through the review lib.
 *  P2  `readStoredUpload` and `lineToSettlementInput` take no actor, so the spec's "called by the screens/actions" is met by any production caller: a non-test file under
 *      apps/erp/src or packages/domain/src OTHER than the file that defines it (ingest.ts and day-checks.ts / review.ts are those callers).
 *  P3  `loanCheckForDay` is called from review.ts or day-checks.ts (the loan check reaches the screen through them).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appProductionSource, codeOnly, trackedFiles } from './lib/document-facts';

const repoRoot = path.resolve(__dirname, '../..');
const DOMAIN = 'packages/domain/src/';

function productionSource(prefix: string, except?: string): string {
  return trackedFiles()
    .filter((f) => f.startsWith(prefix) && /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\/tests?\//.test(f) && f !== except)
    .filter((f) => existsSync(path.join(repoRoot, f)))
    .map((f) => codeOnly(readFileSync(path.join(repoRoot, f), 'utf8')))
    .join('\n');
}
const named = (src: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(src);

describe('T-511 S5b - the new exports have production callers', () => {
  const app = appProductionSource();

  it('control: the scan sees real app source [kills: a scan of nothing]', () => {
    expect(app.length).toBeGreaterThan(100_000);
    expect(named(app, 'ingestSettlementFile')).toBe(true);
  });

  for (const name of ['rejectDay', 'reopenDay', 'overrideLoanAllocation', 'listReviewDays', 'getReviewDayDetail', 'dayBlockers']) {
    it(`${name} is named in production code under apps/erp/src [kills: a domain function nobody can reach]`, () => {
      expect(named(app, name)).toBe(true);
    });
  }

  it('readStoredUpload has a production caller besides its own file (ingest.ts and the day detail) [kills: a moved function nobody calls]', () => {
    const others = productionSource('apps/erp/src/', undefined) + '\n' + productionSource(DOMAIN, `${DOMAIN}settlement-intake/stored-upload.ts`);
    expect(named(others, 'readStoredUpload')).toBe(true);
    const ingest = codeOnly(readFileSync(path.join(repoRoot, DOMAIN, 'settlement-intake/ingest.ts'), 'utf8'));
    expect(named(ingest, 'readStoredUpload')).toBe(true);
  });

  it('lineToSettlementInput has a production caller besides its own file (dayBlockers builds the preview from it) [kills: a converter nobody uses]', () => {
    const others = productionSource('apps/erp/src/', undefined) + '\n' + productionSource(DOMAIN, `${DOMAIN}settlement-intake/settlement-input.ts`);
    expect(named(others, 'lineToSettlementInput')).toBe(true);
  });

  it('loanCheckForDay is called from day-checks.ts or review.ts [kills: a loan check the screen never shows]', () => {
    const callers = ['day-checks.ts', 'review.ts']
      .map((f) => path.join(repoRoot, DOMAIN, 'settlement-intake', f))
      .filter((p) => existsSync(p))
      .map((p) => codeOnly(readFileSync(p, 'utf8')))
      .join('\n');
    expect(named(callers, 'loanCheckForDay')).toBe(true);
  });
});
