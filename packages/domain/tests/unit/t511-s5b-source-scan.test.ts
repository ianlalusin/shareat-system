/**
 * T-511 S5b (TESTER, 2026-11-05) - the shape of the S5b domain modules, read from source (no database). Several repo guards judge source and each fails far
 * from the cause (throw ratchet, tx non-nullable, no-ungated-read-surface, client-bundle-boundary), so the shape is pinned here where the cause is named.
 *
 * RED today, for one reason: none of the S5b modules exists yet (the first read below fails with ENOENT).
 *
 * CONTRACT (modules and exports; the builder must meet these or ask BOSS to change the tests):
 *  M1  stored-upload.ts  exports readStoredUpload(tx, orgId, uploadId). ingest.ts imports it and no longer defines its own readFile (it MOVED, was not copied).
 *  M2  settlement-input.ts exports lineToSettlementInput; loan-check.ts exports checkLoanDay, loanCheckForViewer and the async loanCheckForDay(tx, actor, salesDate);
 *      day-checks.ts exports dayBlockers(tx, actor, target, opts?); review.ts exports listReviewDays, getReviewDayDetail, rejectDay, reopenDay,
 *      overrideLoanAllocation. All of them are reachable from `@shareat/domain` (the screens import from there).
 *  M3  No raw `throw new Error(` in any S5b module (T-343 ratchet: refusals use `refuse(...)` or the intake refusal helper). `tx` is a plain `Tx`, never `Tx | null`.
 *  M4  SQL is written only in packages/db/src/repo/settlement-intake.ts (and the other repos): no `sql\`` template and no drizzle-orm import in any S5b domain module.
 *  M5  The three audit actions are written by review.ts: 'settlement_day.rejected', 'settlement_day.reopened', 'settlement_loan.allocation_overridden'.
 *  M6  Nothing in S5b books anything: no S5b module calls recordChannelSettlement, postEntry or a journal repo. The only preview it may call is
 *      previewChannelSettlement.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', '..', 'src', 'settlement-intake');
const INDEX = join(__dirname, '..', '..', 'src', 'index.ts');
const read = (f: string): string => {
  const p = join(DIR, f);
  expect(existsSync(p), `${f} must exist`).toBe(true);
  return readFileSync(p, 'utf8');
};
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const NEW_MODULES = ['stored-upload.ts', 'settlement-input.ts', 'loan-check.ts', 'day-checks.ts', 'review.ts'];

describe('T-511 S5b - the new modules exist and export what the screens need', () => {
  const exportsOf: Record<string, string[]> = {
    'stored-upload.ts': ['readStoredUpload'],
    'settlement-input.ts': ['lineToSettlementInput'],
    'loan-check.ts': ['checkLoanDay', 'loanCheckForViewer', 'loanCheckForDay'],
    'day-checks.ts': ['dayBlockers'],
    'review.ts': ['listReviewDays', 'getReviewDayDetail', 'rejectDay', 'reopenDay', 'overrideLoanAllocation'],
  };
  for (const [file, names] of Object.entries(exportsOf)) {
    it(`${file} exports ${names.join(', ')} [kills: a missing or differently named export]`, () => {
      const src = codeOnly(read(file));
      for (const n of names) expect(src, n).toMatch(new RegExp(`export (async )?function ${n}\\b`));
    });
  }

  it('@shareat/domain reaches every one of them (the screens import from there) [kills: an export the app cannot import]', () => {
    const src = codeOnly(readFileSync(INDEX, 'utf8'));
    for (const file of ['stored-upload', 'settlement-input', 'loan-check', 'day-checks', 'review']) {
      expect(src, file).toMatch(new RegExp(`from '\\./settlement-intake/${file}'`));
    }
  });
});

describe('T-511 S5b - readStoredUpload MOVED out of ingest.ts', () => {
  it('ingest.ts imports readStoredUpload from ./stored-upload and defines no readFile of its own [kills: a second copy of the re-reader]', () => {
    const ingest = codeOnly(readFileSync(join(DIR, 'ingest.ts'), 'utf8'));
    expect(ingest).toMatch(/readStoredUpload[\s\S]{0,80}from '\.\/stored-upload'|from '\.\/stored-upload'/);
    expect(ingest).not.toMatch(/async function readFile\(/);
  });
});

describe('T-511 S5b - house rules every domain module must keep', () => {
  for (const file of NEW_MODULES) {
    it(`${file}: no raw throw new Error, no SQL, no drizzle, a non-null Tx [kills: the throw ratchet, SQL outside the repo, a nullable tx]`, () => {
      const src = codeOnly(read(file));
      expect(src).not.toMatch(/throw new Error\(/);
      expect(src).not.toMatch(/\bsql`/);
      expect(src).not.toMatch(/from 'drizzle-orm/);
      expect(src).not.toMatch(/tx:\s*Tx\s*\|\s*null/);
      expect(src).not.toMatch(/recordChannelSettlement|postEntry\b|journalRepo/);
    });
  }

  it('review.ts writes the three audit actions and calls the decision writes through the repo only [kills: a missing audit row; a hand-rolled UPDATE]', () => {
    const src = codeOnly(read('review.ts'));
    for (const a of ['settlement_day.rejected', 'settlement_day.reopened', 'settlement_loan.allocation_overridden']) expect(src, a).toContain(`'${a}'`);
    expect(src).toMatch(/auditLogRepo\.append\(/);
    expect(src).toMatch(/settlementIntakeRepo\./);
  });

  it('day-checks.ts takes its settlement blockers from previewChannelSettlement and never posts [kills: a second copy of the destination / negative / posted rules]', () => {
    const src = codeOnly(read('day-checks.ts'));
    expect(src).toMatch(/previewChannelSettlement\(/);
    expect(src).toMatch(/lineToSettlementInput\(/);
    expect(src).toMatch(/firstOpenDateOnOrAfter\(/);
  });

  it('review.ts calls readStoredUpload for the order list and the VAT figure, never the file driver directly [kills: a second storage read path]', () => {
    const src = codeOnly(read('review.ts'));
    expect(src).toMatch(/readStoredUpload\(/);
    expect(src).not.toMatch(/resolveStorageDriver/);
  });
});
