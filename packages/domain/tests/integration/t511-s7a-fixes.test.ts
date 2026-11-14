import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S7a FIXES (fixer, 8 Nov 2026) - the Opus rulings on the S7a adversarial audit, as real tests on a real Postgres through real ingest. Each test names its ruling.
 *   1  a Foodpanda invoice re-uploaded after a charge was booked: the carrier and the "unbooked charge" count follow channel + invoice number, never the upload id
 *   2  every period up to today closed: a blocker in plain words (no_open_period), never a raw error with a period id
 *   3  two voids of one settlement: the second is refused in words, the first reason and voider are never overwritten
 *   5  the typed reason is bound to the difference the approver saw (confirmedDifference)
 *   7  recordChannelSettlement takes the channel lock itself: two settlements of one channel queue
 *   +  approve racing reject: one wins, no stuck state
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { advisoryLocksRepo, closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import {
  D1, D2, D3, approve, asOrg, auditRows, blockersOf, chargeLinks, entryCount, fpInvoice, fpWeek, ingest, lineFull, lineOn, netDebit, postCharge, postedDay, s7World, sentenceOf,
  settlementFull, settlementsOf, setDestination, zip,
} from './_fixtures/t511-s7a-world';

const sql = postgres(url, { max: 10 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('S7a fix 1 - a re-uploaded invoice never strands the carrier or the booked charge', () => {
  it('auditor R1: the charge is booked, then the invoice is uploaded again with D1 changed; D1 (new line), D2 and D3 all approve, D3 nets the 112.00 once, and nothing is swept to 6420 [kills: the carrier and the unbooked count keyed per upload]', async () => {
    const f = await fpWeek(sql, 'fx1', { charge: true });
    const w = f.w;
    const c = await postCharge(w, w.admin, f.chargeLineId!);
    expect(c.posted, 'control: the charge is booked before the re-upload').toBe(true);
    await ingest(w, w.managerA, zip(fpInvoice([{ date: D1, gross: 9500, fees: 1900 }, { date: D2, gross: 8000, fees: 1600 }, { date: D3, gross: 10000, fees: 2000 }], { periodChargeNet: 100 })));
    const l1 = await lineOn(sql, w.orgId, w.fpA, D1);
    expect(l1.id, 'control: D1 got a new line; D2 and D3 are unchanged, still on the first upload').not.toBe(f.lines[D1]);
    expect((await lineOn(sql, w.orgId, w.fpA, D3)).id).toBe(f.lines[D3]);

    const codes = async (id: string) => (await blockersOf(w, w.managerA2, id)).blockers.map((b) => b.code);
    expect(await codes(l1.id), 'the new D1 is not held by a charge already booked from the first upload').toEqual([]);
    expect(await codes(f.lines[D3]!), 'nor is the carrier: only the order of days holds it').toEqual(['earlier_day_open']);

    const r1 = await approve(w, w.managerA2, l1.id);
    const r2 = await approve(w, w.managerA2, f.lines[D2]!);
    expect(r1.chargeIds, 'D1 is not the carrier even though it is the only day of the new upload').toEqual([]);
    expect(r2.chargeIds).toEqual([]);
    const r3 = await approve(w, w.managerA2, f.lines[D3]!);
    expect(r3.chargeIds, 'the BOOKED charge, once').toEqual([c.chargeId]);
    expect(await chargeLinks(sql, w.orgId)).toEqual([{ settlement_id: r3.settlementId, charge_id: c.chargeId }]);
    expect(await netDebit(sql, w.orgId, '6420')).toBe('0.00');
    expect(await netDebit(sql, w.orgId, '1220')).toBe('0.00');
    expect((await settlementFull(sql, r3.settlementId)).net_deposited).toBe('7888.00');
  });

  it('the staged copy of an already booked charge is not an unbooked charge: a same-figure re-upload leaves the carrier free [kills: a carrier held forever by a copy that can never be booked]', async () => {
    const f = await fpWeek(sql, 'fx1b', { charge: true });
    const w = f.w;
    await postCharge(w, w.admin, f.chargeLineId!);
    await ingest(w, w.managerA, zip(fpInvoice([{ date: D1, gross: 9000, fees: 1800 }, { date: D2, gross: 8000, fees: 1600 }, { date: D3, gross: 10000, fees: 2000 }], { periodChargeNet: 100 })));
    const staged = await sql<{ id: string }[]>`
      select ol.id::text from settlement_other_lines ol join settlement_uploads u on u.id = ol.upload_id
       where u.org_id = ${w.orgId} and ol.kind = 'period_charge' and ol.day_line_id is null order by ol.id`;
    expect(staged.length, 'control: the charge is staged under both uploads').toBe(2);
    for (const l of [f.lines[D1]!, f.lines[D2]!]) await approve(w, w.managerA2, l);
    expect((await blockersOf(w, w.managerA2, f.lines[D3]!)).blockers.map((b) => b.code)).toEqual([]);
  });
});

describe('S7a fix 2 - every period up to today closed is a blocker in plain words', () => {
  it('no open period: dayBlockers says so (no_open_period) and approve refuses with that sentence, no period id, nothing written [kills: a raw posting error naming a period]', async () => {
    const f = await fpWeek(sql, 'fx2', { loanPeriods: false });
    const w = f.w;
    await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on >= '2026-10-01'`;
    const b = (await blockersOf(w, w.managerA2, f.lines[D1]!)).blockers;
    expect(b.map((x) => x.code)).toContain('no_open_period');
    const sentence = await sentenceOf(approve(w, w.managerA2, f.lines[D1]!));
    expect(sentence).toContain(b[0]!.sentence);
    expect(sentence).not.toMatch(UUID_ANY);
    expect((await settlementsOf(sql, w.orgId)).length).toBe(0);
    expect((await lineFull(sql, f.lines[D1]!)).review_state).toBe('pending');
  });
});

describe('S7a fix 3 - two voids of one settlement', () => {
  it('queued behind the channel lock, the second voider is refused in words ("already voided") and the first reason and voider stand; one reversal, one unbooked audit row [kills: status read before the lock; an unguarded markVoided]', async () => {
    const f = await fpWeek(sql, 'fx3');
    const w = f.w;
    const r1 = await approve(w, w.managerA2, f.lines[D1]!);
    const before = await entryCount(sql, w.orgId);
    const [chan] = await sql<{ channel_id: string }[]>`select channel_id::text from channel_settlements where id = ${r1.settlementId}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = asOrg(w.orgId, async (tx) => {
      await advisoryLocksRepo.lockSettlementChannel(tx, chan!.channel_id);
      await gate;
    });
    await wait(500);
    setTimeout(release, 2500);
    const res = await Promise.allSettled([
      asOrg(w.orgId, (tx) => D.voidChannelSettlement(tx, w.admin, { settlementId: r1.settlementId, reason: 'void by the first' })),
      asOrg(w.orgId, (tx) => D.voidChannelSettlement(tx, w.managerA2, { settlementId: r1.settlementId, reason: 'void by the second' })),
    ]);
    await holder;
    expect(res.filter((r) => r.status === 'fulfilled'), 'exactly one void wins').toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String((lost.reason as { userMessage?: string }).userMessage ?? (lost.reason as Error).message)).toMatch(/already voided/i);
    const winnerIdx = res.findIndex((r) => r.status === 'fulfilled');
    const [row] = await sql<{ void_reason: string; voided_by: string }[]>`select void_reason, voided_by::text from channel_settlements where id = ${r1.settlementId}`;
    expect([row!.void_reason, row!.voided_by]).toEqual(winnerIdx === 0 ? ['void by the first', w.admin.personId] : ['void by the second', w.managerA2.personId]);
    expect(await entryCount(sql, w.orgId), 'one reversal entry').toBe(before + 1);
    expect(await auditRows(sql, w.orgId, 'settlement_day.unbooked')).toHaveLength(1);
  });
});

describe('S7a fix 5 - the typed reason belongs to the difference the approver saw', () => {
  async function reasonWorld(hint: string) {
    const f = await fpWeek(sql, hint, { staff: ['8000.00', '', ''] });
    const w = f.w;
    const receive = (amount: string) =>
      asOrg(w.orgId, (tx) =>
        postEntry(tx, {
          orgId: w.orgId, entryDate: '2026-10-13', sourceType: 'manual_journal', sourceId: crypto.randomUUID(), idempotencyKey: `s7a-fx5:${crypto.randomUUID()}`, memo: 'Paid by hand', postedBy: w.admin.personId,
          lines: [
            { accountCode: '1130', storeId: w.storeA, debit: amount },
            { accountCode: '1220', storeId: w.storeA, credit: amount, partyType: 'channel', partyId: w.fpA },
          ],
        }),
      );
    await receive('3000.00');
    return { w, lineId: f.lines[D1]!, receive };
  }

  it('a reason with no confirmed figure, or with a figure that is no longer the difference, is refused with NEEDS_REASON carrying the CURRENT difference and rolls everything back; the same figure books [kills: a reason that carries over to a different amount]', async () => {
    const { w, lineId, receive } = await reasonWorld('fx5');
    const asErr = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as D.SettlementIntakeRefusal & { difference?: string; sign?: string });

    const missing = await asErr(approve(w, w.managerA2, lineId, 'Customer paid us directly'));
    expect(missing?.code, 'no confirmed figure').toBe('NEEDS_REASON');
    expect(missing?.difference).toBe('3000.00');

    await receive('2000.00');
    const changed = await asErr(approve(w, w.managerA2, lineId, 'Customer paid us directly', '3000.00'));
    expect(changed?.code, 'the amount changed after the approver saw 3,000.00').toBe('NEEDS_REASON');
    expect([changed?.difference, changed?.sign]).toEqual(['5000.00', 'over']);
    expect((await settlementsOf(sql, w.orgId)).length, 'nothing booked').toBe(0);
    expect((await lineFull(sql, lineId)).review_state).toBe('pending');
    expect((await sql`select 1 from sales_day_platform_corrections where org_id = ${w.orgId}`).length, 'the correction was rolled back too').toBe(0);

    const r = await approve(w, w.managerA2, lineId, 'Customer paid us directly', '5000.00');
    const s = await settlementFull(sql, r.settlementId);
    expect([s.difference_reason, s.settlement_gain]).toEqual(['Customer paid us directly', '5000.00']);
  });

  it('when no acknowledgement is needed both the reason and the figure are ignored [kills: a clean day refused for a missing figure]', async () => {
    const f = await fpWeek(sql, 'fx5-clean');
    const r = await approve(f.w, f.w.managerA2, f.lines[D1]!, 'not needed', '123.00');
    expect((await settlementFull(sql, r.settlementId)).difference_reason).toBeNull();
  });
});

describe('S7a fix 7 - recordChannelSettlement takes the channel lock itself', () => {
  it('two settlements of one channel balance, both queued behind the channel lock: the second sees the first balance and is refused; 1220 never goes below zero [kills: a manual settlement racing an approve on the same balance]', async () => {
    const w = await s7World(sql, 'fx7');
    await setDestination(sql, w, w.fpA);
    const day1 = await postedDay(w, w.fpA, D1, '5000.00');
    const day2 = await postedDay(w, w.fpA, D2, '5000.00');
    const settle = (dayId: string, date: string) =>
      asOrg(w.orgId, (tx) =>
        D.recordChannelSettlement(tx, w.admin, {
          storeId: w.storeA, channelId: w.fpA, salesDayId: dayId, businessDate: date, grossAmount: '10000.00', netDeposited: '9000.00', settledOn: D3, deductions: { commission: '1000.00' },
        }),
      );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = asOrg(w.orgId, async (tx) => {
      await advisoryLocksRepo.lockSettlementChannel(tx, w.fpA);
      await gate;
    });
    await wait(500);
    setTimeout(release, 2500);
    const res = await Promise.allSettled([settle(day1, D1), settle(day2, D2)]);
    await holder;
    expect(res.filter((r) => r.status === 'fulfilled'), 'one clears the balance, the other sees it gone').toHaveLength(1);
    expect(await netDebit(sql, w.orgId, '1220')).toBe('0.00');
    expect((await settlementsOf(sql, w.orgId)).length).toBe(1);
  });
});

describe('S7a - approve racing reject', () => {
  it('one wins and the day is never stuck: booked with its settlement, or rejected with none [kills: a reject that lands between the read and the booking]', async () => {
    const f = await fpWeek(sql, 'fx-race');
    const w = f.w;
    const lineId = f.lines[D1]!;
    const res = await Promise.allSettled([
      approve(w, w.managerA2, lineId),
      asOrg(w.orgId, (tx) => D.rejectDay(tx, w.managerA3, { lineId, reason: 'Platform will reissue this day' })),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const line = await lineFull(sql, lineId);
    const settlements = (await settlementsOf(sql, w.orgId)).length;
    if (res[0]!.status === 'fulfilled') expect([line.review_state, settlements]).toEqual(['booked', 1]);
    else expect([line.review_state, settlements, line.settlement_id]).toEqual(['rejected', 0, null]);
  });
});
