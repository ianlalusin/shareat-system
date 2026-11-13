/**
 * T-511 S6a FIXES (audit item 5b) - `dayBlockers` feeds the legs of the loan check to the settlement preview. Before this file the wiring was pinned only by a source
 * regex: a mutant passing `[]` (so the preview sees a payout with no loan, an unexplained difference) was invisible, because `dayBlockers` keeps only three of the
 * preview's sentences. This test watches what the preview is GIVEN, on a real two-loan Lipa day (the S5 world), by wrapping `previewChannelSettlement`.
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const seen = vi.hoisted(() => ({ inputs: [] as { loanLegs?: { loanId: string; amount: string; ownerStoreId?: string | null }[] }[] }));
vi.mock('../../src/channel-settlements', async (original) => {
  const actual = await original<typeof import('../../src/channel-settlements')>();
  return {
    ...actual,
    previewChannelSettlement: (...args: Parameters<typeof actual.previewChannelSettlement>) => {
      seen.inputs.push(args[2] as never);
      return actual.previewChannelSettlement(...args);
    },
  };
});

import { closeDb, settlementIntakeRepo } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { dayBlockers } from '../../src/settlement-intake/day-checks';
import { asOrg, mkLoan, setDestination, stageGrabOctober, world3, type World3 } from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 8 });
beforeEach(() => {
  setStorageDriver(inMemoryDriver());
  seen.inputs.length = 0;
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const TODAY = '2026-11-05';
const cents = (t: string): bigint => BigInt(t.replace('.', ''));

describe('T-511 S6a fixes - dayBlockers hands the legs of the loan check to the preview', () => {
  it('14 Oct (two loans): the preview is given two legs of the two loans, owned by Lipa, adding up to the line loan deduction [kills: a preview given [] or no legs; one lump leg; legs from the wrong store]', async () => {
    const w = await world3(sql, 's6a-fix-day');
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    const l1 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    const l2 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    await setDestination(sql, w, w.grabA);

    const line = await asOrg(w.orgId, async (tx) => {
      const l = (await settlementIntakeRepo.currentLine(tx, w.orgId, w.grabA, '2026-10-14'))!;
      await dayBlockers(tx, w.admin, l, { today: TODAY });
      return l;
    });
    expect(seen.inputs.length, 'the preview ran once for the day').toBe(1);
    const legs = seen.inputs[0]!.loanLegs ?? [];
    expect([...legs.map((l) => l.loanId)].sort()).toEqual([l1, l2].sort());
    expect(legs.every((l) => l.ownerStoreId === w.storeA)).toBe(true);
    expect(legs.reduce((t, l) => t + cents(l.amount), 0n)).toBe(cents(String(line.loanDeduction)));
    expect(legs.reduce((t, l) => t + cents(l.amount), 0n), 'a real deduction, not an empty list').toBeGreaterThan(0n);
  });
});
