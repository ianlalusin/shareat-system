import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S7a (TESTER, 8 Nov 2026) - voiding a booked settlement returns the day it booked to PENDING (Ruling 7), so a plain void is not a dead end.
 * docs/tasks/511-settlement-upload-s7-spec.md Ruling 7 and Ruling 9 (`settlement_day.unbooked`). Real Postgres, real ingest, real posting.
 *
 * RED TODAY, for one reason: `approveDay` does not exist (the day is booked through it in every test) and `voidChannelSettlement` does not touch the staged line.
 * The last test (a manual settlement with no day line) needs no approve and passes today: it is the "unchanged" control the spec asks for.
 *
 * PINNED:
 *  V1  `voidChannelSettlement` (and only it) moves the day line that is CURRENT, `booked` and carries `settlement_id` = the voided settlement back to `pending` in the same
 *      transaction: `decided_by`, `decided_at` and `settlement_id` cleared (the review_shape CHECK), `decision_reason` stays null.
 *  V2  A line that is NOT current (a newer file replaced it after it booked) stays `booked` with its settlement id as history; the newer line is untouched.
 *  V3  One audit row `settlement_day.unbooked` per day returned: entity = the line, the line's store, the voider as actor, source 'web'; the payload names the settlement.
 *  V4  Re-approve is safe: the sales correction is idempotent (one correction row for the day, ever), the charge link of the voided parent no longer counts so the same charge
 *      is netted again by the new settlement, the entries are the same as the first time and 1220 ends at 0.00.
 *  V5  A settlement with no day line (a hand-recorded one, T-150) voids exactly as before: no line is touched, no `settlement_day.unbooked` row.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import {
  D1, D2, D3, aggText, approve, asOrg, auditRows, chargeLinks, correctionCount, corrections, entryCount, fpInvoice, fpWeek, grabWorld, ingest, leaves, lineFull, netDebit,
  postCharge, postedDay, s7World, settlementFull, settlementsOf, setDestination, zip,
} from './_fixtures/t511-s7a-world';

const sql = postgres(url, { max: 10 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const voidIt = (orgId: string, who: { personId: string; orgId: string }, settlementId: string) =>
  asOrg(orgId, (tx) => D.voidChannelSettlement(tx, who, { settlementId, reason: 'The payout file was wrong' }));
const sorted = (xs: string[]): string[] => [...xs].sort();

describe('S7a void returns the day to pending', () => {
  it('a Grab day approved with its correction, then the settlement voided: the line is pending again (decided_by, decided_at, settlement_id all cleared), and one settlement_day.unbooked audit row names the line, the store and the voider [kills: a void that leaves the line booked (a dead end); a half-cleared line (the review_shape CHECK); no audit row]', async () => {
    const g = await grabWorld(sql, 'void-basic');
    const w = g.w;
    const r = await approve(w, w.managerA2, g.lineId);
    expect((await lineFull(sql, g.lineId)).review_state, 'control: booked').toBe('booked');
    await voidIt(w.orgId, w.admin, r.settlementId);

    const l = await lineFull(sql, g.lineId);
    expect([l.review_state, l.decided_by, l.decided_at, l.settlement_id, l.is_current]).toEqual(['pending', null, null, null, true]);
    expect((await settlementFull(sql, r.settlementId)).status).toBe('voided');
    const rows = await auditRows(sql, w.orgId, 'settlement_day.unbooked');
    expect(rows).toHaveLength(1);
    expect([rows[0]!.entity_id, rows[0]!.store_id, rows[0]!.actor_person_id, rows[0]!.source]).toEqual([g.lineId, w.storeA, w.admin.personId, 'web']);
    expect(leaves({ b: rows[0]!.before, a: rows[0]!.after }), 'the payload names the settlement that was voided').toContain(r.settlementId);
    expect(await netDebit(sql, w.orgId, '1220'), 'the settlement is reversed; the correction (a fact about the sales figure) is not').toBe('11000.00');
  });

  it('re-approve after the void works end to end: the correction is NOT posted a second time, a new settlement books the same lines, 1220 ends at 0.00 and 4150 holds the file figure once [kills: a second correction (4150 double); a re-approve refused because the line stayed booked; a unique settlement_id clash]', async () => {
    const g = await grabWorld(sql, 'void-reapprove');
    const w = g.w;
    const first = await approve(w, w.managerA2, g.lineId);
    await voidIt(w.orgId, w.admin, first.settlementId);
    const second = await approve(w, w.managerA3, g.lineId);
    expect(second.settlementId).not.toBe(first.settlementId);
    expect([null, first.correctionId], 'the correction of the first approve stands; this one posts none').toContain(second.correctionId);
    expect(await correctionCount(sql, w.orgId)).toBe(1);
    expect(await aggText(sql, (await settlementFull(sql, second.settlementId)).journal_entry_id!)).toEqual(sorted(['Dr 1140 8200.00', 'Dr 6400 2300.00', 'Dr 2400 500.00', 'Cr 1220 11000.00']));
    expect(await netDebit(sql, w.orgId, '1220')).toBe('0.00');
    expect(await netDebit(sql, w.orgId, '4150'), 'the file figure, once').toBe('-11000.00');
    const l = await lineFull(sql, g.lineId);
    expect([l.review_state, l.settlement_id, l.decided_by]).toEqual(['booked', second.settlementId, w.managerA3.personId]);
    expect((await corrections(sql, w.orgId)).length).toBe(1);
  });

  it('the carrier day of a Foodpanda week: void, then re-approve nets the same 112.00 charge again through the NEW settlement; 6400 holds the charge once and the bank is 21,488.00 again [kills: the charge link still counting through the voided parent (the re-approve refused as already netted); the charge expensed twice]', async () => {
    const f = await fpWeek(sql, 'void-carrier', { charge: true });
    const w = f.w;
    const c = await postCharge(w, w.admin, f.chargeLineId!);
    await approve(w, w.managerA2, f.lines[D1]!);
    await approve(w, w.managerA2, f.lines[D2]!);
    const r3 = await approve(w, w.managerA2, f.lines[D3]!);
    expect(r3.chargeIds).toEqual([c.chargeId]);
    await voidIt(w.orgId, w.admin, r3.settlementId);
    expect((await lineFull(sql, f.lines[D3]!)).review_state).toBe('pending');
    expect(await netDebit(sql, w.orgId, '1220'), 'D3 owed again: 10,000 less the 112 credit').toBe('9888.00');

    const again = await approve(w, w.managerA3, f.lines[D3]!);
    expect(again.chargeIds, 'the charge is netted again').toEqual([c.chargeId]);
    expect(await aggText(sql, (await settlementFull(sql, again.settlementId)).journal_entry_id!)).toEqual(sorted(['Dr 1140 7888.00', 'Dr 6400 2000.00', 'Cr 1220 9888.00']));
    expect(await netDebit(sql, w.orgId, '1140')).toBe('21488.00');
    expect(await netDebit(sql, w.orgId, '6400')).toBe('5512.00');
    expect(await netDebit(sql, w.orgId, '1220')).toBe('0.00');
    expect(await netDebit(sql, w.orgId, '6420')).toBe('0.00');
    expect((await chargeLinks(sql, w.orgId)).map((l) => l.settlement_id), 'history kept: one link per settlement').toEqual(sorted([r3.settlementId, again.settlementId]));
  });

  it('a line that was REPLACED by a newer file after it booked stays booked as history when its settlement is voided; the newer line is untouched [kills: every line of the day returned to pending; the non-current line cleared]', async () => {
    const f = await fpWeek(sql, 'void-history');
    const w = f.w;
    const r1 = await approve(w, w.managerA2, f.lines[D1]!);
    // a corrected invoice: D1's figure changed, so D1 gets a new current version (the booked one is retired and the new one flagged)
    await ingest(w, w.managerA, zip(fpInvoice([{ date: D1, gross: 9100, fees: 1800 }, { date: D2, gross: 8000, fees: 1600 }, { date: D3, gross: 10000, fees: 2000 }], { tag: 'v2' })));
    const old = await lineFull(sql, f.lines[D1]!);
    expect([old.is_current, old.review_state], 'control: the booked line is history now').toEqual([false, 'booked']);
    const [cur] = await sql<{ id: string; review_state: string }[]>`select id::text, review_state from settlement_day_lines where org_id = ${w.orgId} and channel_id = ${w.fpA} and sales_date = ${D1} and is_current`;
    expect(cur!.review_state).toBe('pending');

    await voidIt(w.orgId, w.admin, r1.settlementId);
    const after = await lineFull(sql, f.lines[D1]!);
    expect([after.review_state, after.settlement_id, after.is_current], 'history is left alone').toEqual(['booked', r1.settlementId, false]);
    expect((await lineFull(sql, cur!.id)).review_state).toBe('pending');
    expect(await auditRows(sql, w.orgId, 'settlement_day.unbooked'), 'nothing was returned to pending').toHaveLength(0);
  });

  it('a hand-recorded settlement (no staged line) voids exactly as before: the entry reverses, no line is touched, no settlement_day.unbooked row [kills: a void that now needs a day line; an audit row for nothing]', async () => {
    const w = await s7World(sql, 'void-manual');
    await setDestination(sql, w, w.fpA);
    const dayId = await postedDay(w, w.fpA, D1, '5000.00');
    const rec = await asOrg(w.orgId, (tx) =>
      D.recordChannelSettlement(tx, w.admin, {
        storeId: w.storeA, channelId: w.fpA, salesDayId: dayId, businessDate: D1, grossAmount: '5000.00', netDeposited: '4000.00', settledOn: D3, deductions: { commission: '1000.00' },
      }),
    );
    const before = await entryCount(sql, w.orgId);
    const v = await voidIt(w.orgId, w.admin, rec.settlementId);
    expect(v.reversedEntryId).toBeTruthy();
    expect(await entryCount(sql, w.orgId), 'one reversal entry').toBe(before + 1);
    expect((await settlementFull(sql, rec.settlementId)).status).toBe('voided');
    expect(await auditRows(sql, w.orgId, 'settlement_day.unbooked')).toHaveLength(0);
    expect(await netDebit(sql, w.orgId, '1220')).toBe('5000.00');
    expect((await settlementsOf(sql, w.orgId)).length).toBe(1);
  });
});
