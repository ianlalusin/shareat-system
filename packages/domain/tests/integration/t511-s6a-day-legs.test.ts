import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S6a (TESTER, 7 Nov 2026) - the staged path on a REAL two-loan Grab day (the Lipa October files of the S5 world: loans of 591.24 and 1,771.88, the
 * second Lipa row of 14 Oct split 82.12 / 126.38 across them). docs/tasks/511-settlement-upload-s6-spec.md "S6a": "`day-checks.ts` SPLIT_NOTE ... is removed and
 * replaced by the real allocation result". Needs the S6a migration only through the staged-line reads, not the legs table: nothing is posted here.
 *
 * RED TODAY: `dayBlockers` still puts "This payout covers two loans. It cannot be approved yet." in `postNote` for such a day, and `loanLegsForLine` does not exist.
 *
 * PINS (see t511-s6a-settlement-input.test.ts for the function contract):
 *  D1  for a Lipa day whose rows split across two loans, `postNote` says nothing about two loans or "cannot be approved yet", and the day is not held by the loan check.
 *  D2  `loanLegsForLine({ storeId, loanDeduction }, loanCheckForDay(...).result)` gives two legs (one per loan) that add up to the line's own loan deduction, no blocker.
 *  D3  `previewChannelSettlement` of the staged input built WITH those legs reports that deduction as its loan deduction (the preview and the later posting read legs).
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, settlementIntakeRepo } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { inMemoryDriver, previewChannelSettlement, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { dayBlockers } from '../../src/settlement-intake/day-checks';
import { loanCheckForDay } from '../../src/settlement-intake/loan-check';
import * as settlementInput from '../../src/settlement-intake/settlement-input';
import { asOrg, mkLoan, setDestination, stageGrabOctober, world3, type World3 } from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 8 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const TODAY = '2026-11-05';
const cents = (t: string): bigint => BigInt(t.replace('.', ''));

async function twoLoanWorld(hint: string) {
  const w = await world3(sql, hint);
  for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
  const l1 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
  const l2 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
  await setDestination(sql, w, w.grabA);
  return { w, l1, l2 };
}

describe('T-511 S6a - a two-loan Lipa day reads as legs, not as a held day', () => {
  it('14 Oct: no "two loans, cannot be approved yet" note, and no loan_check blocker [kills: the split note kept (the day looks unapprovable although its allocation resolves)]', async () => {
    const { w } = await twoLoanWorld('s6a-note');
    const r = await asOrg(w.orgId, async (tx) => {
      const line = await settlementIntakeRepo.currentLine(tx, w.orgId, w.grabA, '2026-10-14');
      return dayBlockers(tx, w.admin, line!, { today: TODAY });
    });
    expect(r.postNote ?? '').not.toMatch(/two loans|cannot be approved yet/i);
    expect(r.blockers.map((b) => b.code)).not.toContain('loan_check');
  });

  it('14 Oct: the legs of Lipa\'s own rows are one per loan, add up to its loan deduction, and the preview reads them as its loan deduction [kills: legs taken from every store; one lump leg; a preview still fed no loan]', async () => {
    const { w, l1, l2 } = await twoLoanWorld('s6a-legs');
    const { legs, blocker, deduction, previewDeduction } = await asOrg(w.orgId, async (tx) => {
      const line = (await settlementIntakeRepo.currentLine(tx, w.orgId, w.grabA, '2026-10-14'))!;
      const checked = await loanCheckForDay(tx, w.admin, '2026-10-14');
      const fn = (settlementInput as unknown as { loanLegsForLine: (l: unknown, c: unknown) => { legs: { loanId: string; amount: string; ownerStoreId: string }[]; blocker: string | null } }).loanLegsForLine;
      const got = fn({ storeId: line.storeId, loanDeduction: String(line.loanDeduction) }, checked.result);
      const staged = settlementInput.lineToSettlementInput(line as never, got.legs as never);
      const preview = await previewChannelSettlement(tx, w.admin, staged as never);
      return { legs: got.legs, blocker: got.blocker, deduction: String(line.loanDeduction), previewDeduction: preview.loanDeduction };
    });
    expect(blocker).toBeNull();
    expect([...legs.map((l) => l.loanId)].sort()).toEqual([l1, l2].sort());
    expect(legs.every((l) => l.ownerStoreId === w.storeA)).toBe(true);
    expect(legs.reduce((t, l) => t + cents(l.amount), 0n)).toBe(cents(deduction));
    expect(previewDeduction).toBe(deduction);
  });
});
