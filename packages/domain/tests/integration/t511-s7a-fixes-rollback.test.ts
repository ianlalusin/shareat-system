import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S7a FIXES (fixer, 8 Nov 2026) - what a failure at each late step of `approveDay` leaves behind: NOTHING. Real Postgres, real ingest, real posting; only the failing step is forced.
 *   - the booking compare-and-set finds 0 rows AFTER the real settlement and the real correction were posted (a mocked `markBooked` returning false);
 *   - the audit write fails (a mocked `auditLogRepo.append` throwing for `settlement_day.approved`);
 *   - the in-transaction preview, run AFTER the correction, finds a blocker the screen's `dayBlockers` could not (ruling 4): a plain DAY_BLOCKED refusal, everything rolled back.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const force = vi.hoisted(() => ({ markBookedFalse: false, auditFails: false, previewBlockerOnCall: 0, previewCalls: 0 }));

vi.mock('@shareat/db', async (original) => {
  const actual = await original<typeof import('@shareat/db')>();
  return {
    ...actual,
    settlementIntakeRepo: {
      ...actual.settlementIntakeRepo,
      markBooked: (...args: Parameters<typeof actual.settlementIntakeRepo.markBooked>) => (force.markBookedFalse ? Promise.resolve(false) : actual.settlementIntakeRepo.markBooked(...args)),
    },
    auditLogRepo: {
      ...actual.auditLogRepo,
      append: (...args: Parameters<typeof actual.auditLogRepo.append>) => {
        if (force.auditFails && (args[2] as { action?: string }).action === 'settlement_day.approved') throw new Error('forced audit failure');
        return actual.auditLogRepo.append(...args);
      },
    },
  };
});
vi.mock('../../src/channel-settlements', async (original) => {
  const actual = await original<typeof import('../../src/channel-settlements')>();
  return {
    ...actual,
    previewChannelSettlement: async (...args: Parameters<typeof actual.previewChannelSettlement>) => {
      const real = await actual.previewChannelSettlement(...args);
      force.previewCalls += 1;
      if (force.previewBlockerOnCall !== 0 && force.previewCalls === force.previewBlockerOnCall) {
        return { ...real, blockers: ['The charges named for this payout were already taken by another payout.'], needsAcknowledgement: false };
      }
      return real;
    },
  };
});

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { approve, auditRows, correctionCount, entryCount, grabWorld, lineFull, sentenceOf, settlementsOf } from './_fixtures/t511-s7a-world';

const sql = postgres(url, { max: 10 });
beforeEach(() => {
  setStorageDriver(inMemoryDriver());
  force.markBookedFalse = false;
  force.auditFails = false;
  force.previewBlockerOnCall = 0;
  force.previewCalls = 0;
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function snapshot(orgId: string, lineId: string) {
  return { entries: await entryCount(sql, orgId), corrections: await correctionCount(sql, orgId), settlements: (await settlementsOf(sql, orgId)).length, state: (await lineFull(sql, lineId)).review_state };
}

describe('S7a - a late failure rolls the whole approve back', () => {
  it('markBooked finds 0 rows after the settlement and the correction were really posted: the refusal is plain, and no settlement, no correction, no entry, no audit row persists; the same day then books [kills: a posted settlement left behind a day that is still pending]', async () => {
    const g = await grabWorld(sql, 'rb-book');
    const w = g.w;
    const before = await snapshot(w.orgId, g.lineId);
    force.markBookedFalse = true;
    const err = await approve(w, w.managerA2, g.lineId).then(() => null, (e: unknown) => e as D.SettlementIntakeRefusal);
    expect(err, 'the approve refuses').toBeInstanceOf(D.SettlementIntakeRefusal);
    expect(err!.code).toBe('LINE_ALREADY_DECIDED');
    expect(await snapshot(w.orgId, g.lineId), 'nothing at all persisted').toEqual(before);
    expect((await auditRows(sql, w.orgId, 'settlement_day.approved')).length).toBe(0);
    expect((await auditRows(sql, w.orgId, 'platform_sales.corrected')).length).toBe(0);
    force.markBookedFalse = false;
    const r = await approve(w, w.managerA2, g.lineId);
    expect(r.settlementId, 'control: the day books once the forced failure is gone').toBeTruthy();
  });

  it('the audit write fails after the booking: everything rolls back, the day stays pending [kills: a booked day with no audit trail]', async () => {
    const g = await grabWorld(sql, 'rb-audit');
    const w = g.w;
    const before = await snapshot(w.orgId, g.lineId);
    force.auditFails = true;
    const err = await approve(w, w.managerA2, g.lineId).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe('forced audit failure');
    expect(await snapshot(w.orgId, g.lineId)).toEqual(before);
    expect((await auditRows(sql, w.orgId, 'platform_sales.corrected')).length).toBe(0);
    force.auditFails = false;
    expect((await approve(w, w.managerA2, g.lineId)).settlementId).toBeTruthy();
  });

  it('ruling 4: a blocker found only by the in-transaction preview AFTER the correction is a plain DAY_BLOCKED refusal and rolls the correction back [kills: a raw error, or a correction left behind]', async () => {
    const g = await grabWorld(sql, 'rb-preview');
    const w = g.w;
    const before = await snapshot(w.orgId, g.lineId);
    force.previewBlockerOnCall = 2; // call 1 is the screen's dayBlockers inside approve, call 2 is the post-correction preview
    const err = await approve(w, w.managerA2, g.lineId).then(() => null, (e: unknown) => e as D.SettlementIntakeRefusal);
    expect(err).toBeInstanceOf(D.SettlementIntakeRefusal);
    expect(err!.code).toBe('DAY_BLOCKED');
    expect(await sentenceOf(Promise.reject(err))).toContain('already taken by another payout');
    expect(await snapshot(w.orgId, g.lineId), 'the correction that ran first is gone').toEqual(before);
  });
});
