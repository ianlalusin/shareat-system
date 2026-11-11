import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S6b (TESTER, 7 Nov 2026) - everything that must learn the new correction source: the void of a sales day, the settlement that clears the receivable
 * (DEF-810), the sales reports, a later POS correction, and the dual-run readers. docs/tasks/511-settlement-upload-s6-spec.md "S6b" "Readers that must learn the source".
 * Real Postgres. The writer itself is `t511-s6b-correct-platform-sales.test.ts`; the fixture is `_fixtures/t511-s6b-world.ts`.
 *
 * RED TODAY: `correctPlatformSales` and migration 0243 do not exist, so every leg that posts a correction fails at its first call; the controls (no correction) pass.
 *
 * PINNED (the spec is silent; builder meets these or asks BOSS to change the tests):
 *  R1  Reports attribute a platform correction to the channel's OWN row (channelId = the channel, never the synthetic null "POS corrections" row) and by the
 *      CORRECTION'S ENTRY DATE, the way the ledger groups it, so a period that holds the correction but not the sales day still reconciles.
 *  R2  A later `postPosCorrection` leaves the platform correction standing: its entry is only the POS delta, and 1220 stays at the file figure. (The spec says to put the
 *      platform entries into `old`; read literally that would make the POS correction undo them unless `new` carries them too, so only the OUTCOME is pinned here.)
 *  R3  Dual-run: a platform correction entry is placed on the SALES DAY'S business date (like a POS correction) in `v2Figures` and `v2Documents`, and `v2Documents`
 *      flags its documents `platformCorrection: true` (the day's own documents carry no such flag).
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, channelSettlementsRepo, dualRunRepo } from '@shareat/db';
import * as D from '@shareat/domain';
import { importTestDay } from './_fixtures/pos-day';
import { R1_FIGURES, asOrgOn, insertSalesRecheck, s6Fixture } from './_fixtures/pos-s6';
import { submitThenVerify } from './_fixtures/sales-day-flow';
import { DATE, NEXT_OPEN, asOrg, correct, corrections, entriesOf, fx, linesOf, lineText, netDebit, rawDayLine } from './_fixtures/t511-s6b-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const outstanding = (f: { orgId: string; channelId: string }) => asOrg(f.orgId, (tx) => channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId));

// =====================================================================================================
describe('S6b void of a sales day reverses its platform corrections, newest first', () => {
  it('a day with two corrections (10,000 then 10,500): the day entry and both correction entries become reversed, each reversal keeps source sale + the correction\'s own source id, the newer correction is reversed first, the rows stay, 1220 and 4150 net to 0.00 [kills: no reversal of a correction (1,000 stuck on 1220); oldest first; a reversal under the wrong source id; a deleted row]', async () => {
    const f = await fx(sql, 'void', { staff: '11000.00', file: '10000.00' });
    await correct(f, f.admin);
    const line2 = await rawDayLine(sql, { orgId: f.orgId, storeId: f.storeA, channelId: f.channelId, platform: 'foodpanda', salesDate: DATE, orderValue: '10500.00', personId: f.admin.personId, version: 2 });
    await correct(f, f.admin, { dayLineId: line2 });
    const rows = await corrections(sql, f.orgId);
    expect(rows, 'control: two corrections').toHaveLength(2);
    const c1 = rows.find((r) => r.day_line_id === f.lineId)!;
    const c2 = rows.find((r) => r.day_line_id === line2)!;
    const dayEntry = (await sql<{ journal_entry_id: string }[]>`select journal_entry_id::text from sales_days where id = ${f.dayId}`)[0]!.journal_entry_id;

    const out = await asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.admin, f.dayId, 'wrong day'));
    expect(out.reversalEntryId, 'the day\'s own reversal').not.toBeNull();

    const entries = await entriesOf(sql, f.orgId);
    for (const id of [dayEntry, c1.journal_entry_id, c2.journal_entry_id]) expect(entries.find((e) => e.id === id)!.status, `entry ${id} reversed`).toBe('reversed');
    const reversalOf = (id: string) => entries.find((e) => e.reversal_of_entry_id === id)!;
    expect(reversalOf(c1.journal_entry_id), 'a reversal of correction 1').toBeDefined();
    expect(reversalOf(c2.journal_entry_id), 'a reversal of correction 2').toBeDefined();
    expect([reversalOf(c1.journal_entry_id).source_type, reversalOf(c1.journal_entry_id).source_id]).toEqual(['sale', c1.id]);
    expect([reversalOf(c2.journal_entry_id).source_type, reversalOf(c2.journal_entry_id).source_id]).toEqual(['sale', c2.id]);
    expect(reversalOf(c2.journal_entry_id).id < reversalOf(c1.journal_entry_id).id, 'the newer correction is reversed first').toBe(true);

    expect(await corrections(sql, f.orgId), 'the rows are history and stay').toHaveLength(2);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(0);
    expect(Number(await netDebit(sql, f.orgId, '4150'))).toBe(0);
    expect((await sql<{ status: string }[]>`select status from sales_days where id = ${f.dayId}`)[0]!.status).toBe('voided');
  });

  it('control: a day with NO correction voids exactly as before (day entry reversed, nothing else) [kills: a void that needs a correction row]', async () => {
    const f = await fx(sql, 'voidplain', { staff: '11000.00', file: '10000.00' });
    await asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.admin, f.dayId, 'wrong day'));
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(0);
    expect((await entriesOf(sql, f.orgId)).filter((e) => e.reversal_of_entry_id !== null)).toHaveLength(1);
  });
});

// =====================================================================================================
describe('S6b correction, then the settlement: 1220 clears to exactly zero (DEF-810)', () => {
  it('staff 11,000 / file 10,000: after the correction the settlement of 10,000.00 leaves 0.00 on the channel and books no variance line; WITHOUT the correction 1,000.00 stays stuck (the defect) [kills: a correction that does not move the receivable; a settlement that still leaves the gap]', async () => {
    const stuck = await fx(sql, 'def810-control', { staff: '11000.00', file: '10000.00' });
    await asOrg(stuck.orgId, (tx) =>
      D.recordChannelSettlement(tx, stuck.admin, { storeId: stuck.storeA, channelId: stuck.channelId, salesDayId: stuck.dayId, businessDate: DATE, grossAmount: '10000.00', netDeposited: '10000.00', settledOn: '2026-10-20' }),
    );
    expect(Number(await outstanding(stuck)), 'control: DEF-810, the 1,000 is stuck on 1220').toBe(1000);

    const f = await fx(sql, 'def810', { staff: '11000.00', file: '10000.00' });
    expect(Number(await outstanding(f))).toBe(11000);
    await correct(f, f.admin);
    expect(Number(await outstanding(f)), 'the correction moved the receivable to the file figure').toBe(10000);
    const settled = await asOrg(f.orgId, (tx) =>
      D.recordChannelSettlement(tx, f.admin, { storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '10000.00', netDeposited: '10000.00', settledOn: '2026-10-20' }),
    );
    expect(Number(await outstanding(f)), '1220 cleared to exactly zero').toBe(0);
    expect(await netDebit(sql, f.orgId, '1220')).toBe('0.00');
    const codes = (await linesOf(sql, settled.entryId)).map((l) => l.code).sort();
    expect(codes, 'no 6420 shortfall and no 7100 gain: the difference was corrected, not swept').toEqual(['1140', '1220']);
  });

  it('staff 9,000 / file 10,000: the correction first, then the settlement of 10,000.00 clears to 0.00 with no gain to acknowledge [kills: a gain booked to 7100 for what the correction should have raised as sales]', async () => {
    const f = await fx(sql, 'def810-up', { staff: '9000.00', file: '10000.00' });
    await correct(f, f.admin);
    await asOrg(f.orgId, (tx) =>
      D.recordChannelSettlement(tx, f.admin, { storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '10000.00', netDeposited: '10000.00', settledOn: '2026-10-20' }),
    );
    expect(Number(await outstanding(f))).toBe(0);
    expect(Number(await netDebit(sql, f.orgId, '7100'))).toBe(0);
  });
});

// =====================================================================================================
describe('S6b reports show the corrected figure on the channel\'s own row', () => {
  const rollup = (orgId: string, storeId: string, fromDate: string, toDate: string, over: Record<string, unknown> = {}) =>
    asOrg(orgId, (tx) => D.getSalesRollup(tx, { orgId, storeId, fromDate, toDate, groupBy: 'month', ...over } as never));

  it('same month (staff 11,000 / file 10,000): reconciles at 10,000.00, the Foodpanda row says 10,000.00, there is no synthetic channel-less row, a la carte says 10,000.00 [kills: a report that still says 11,000 on the channel; a correction line with no channel id; a ledger that does not reconcile]', async () => {
    const f = await fx(sql, 'rep', { staff: '11000.00', file: '10000.00' });
    const pre = await rollup(f.orgId, f.storeA, '2026-10-01', '2026-10-31');
    expect(Number(pre.channels.find((c) => c.channelId === f.channelId)!.total), 'control: before the correction').toBe(11000);
    await correct(f, f.admin);
    const r = await rollup(f.orgId, f.storeA, '2026-10-01', '2026-10-31');
    expect(r.reconciles).toBe(true);
    expect(Number(r.ledgerTotal)).toBe(10000);
    expect(Number(r.channels.find((c) => c.channelId === f.channelId)!.total)).toBe(10000);
    expect(r.channels.filter((c) => c.channelId === null), 'a platform correction is the channel\'s own row, not a synthetic one').toEqual([]);
    expect(Number(r.modes.find((m) => m.mode === 'ala_carte')!.total)).toBe(10000);
  });

  it('file higher (staff 9,000 / file 10,000): the row says 10,000.00 and the report reconciles [kills: a negative-only adjustment]', async () => {
    const f = await fx(sql, 'rep-up', { staff: '9000.00', file: '10000.00' });
    await correct(f, f.admin);
    const r = await rollup(f.orgId, f.storeA, '2026-10-01', '2026-10-31');
    expect(r.reconciles).toBe(true);
    expect(Number(r.channels.find((c) => c.channelId === f.channelId)!.total)).toBe(10000);
  });

  it('dated in the NEXT month (October closed): October alone reconciles at 11,000.00 with the old row; October to November reconciles at 10,000.00 and the row says 10,000.00; by day, no day is unreconciled and the Foodpanda blocks sum to 10,000.00 [kills: a correction counted in the sales day\'s month while the ledger counts it in the next]', async () => {
    const f = await fx(sql, 'rep-next', { staff: '11000.00', file: '10000.00' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    await correct(f, f.admin);
    expect((await corrections(sql, f.orgId))[0]!.entry_date).toBe(NEXT_OPEN);

    const oct = await rollup(f.orgId, f.storeA, '2026-10-01', '2026-10-31');
    expect(oct.reconciles).toBe(true);
    expect(Number(oct.ledgerTotal)).toBe(11000);
    expect(Number(oct.channels.find((c) => c.channelId === f.channelId)!.total)).toBe(11000);

    const both = await rollup(f.orgId, f.storeA, '2026-10-01', '2026-11-30');
    expect(both.reconciles).toBe(true);
    expect(Number(both.ledgerTotal)).toBe(10000);
    expect(Number(both.channels.find((c) => c.channelId === f.channelId)!.total)).toBe(10000);

    const days = await rollup(f.orgId, f.storeA, '2026-10-01', '2026-11-30', { groupBy: 'day', channelDays: true });
    expect(days.unreconciledDays).toEqual([]);
    const blocks = days.channelDays.flatMap((d) => d.channels);
    expect(blocks.filter((b) => b.channelId === null)).toEqual([]);
    expect(blocks.filter((b) => b.channelId === f.channelId).reduce((t, b) => t + Number(b.total), 0)).toBe(10000);
  });
});

// =====================================================================================================
describe('S6b a later POS correction leaves the platform correction standing (no phantom reversal)', () => {
  it('a POS day with a Foodpanda row of 200.00, file 250.00 (platform correction +50.00), then POS voids a 50.00 cash receipt: the POS correction is exactly Dr 4100 50.00 / Cr 1110 50.00, and 1220 stays 250.00, 4150 stays 750.00 [kills: a POS correction that reverses the platform correction as phantom 1220 / 4150 lines]', async () => {
    const f = await s6Fixture(sql, 'poshaz');
    const DAY = '2027-01-10';
    const { id: dayId } = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: DAY }));
    await asOrgOn(f.orgId, (tx) => D.editSalesDay(tx, f.manager, { salesDayId: dayId, platform: [{ channelId: f.foodpandaId, amount: '200.00', noSales: false }] }));
    await asOrgOn(f.orgId, (tx) => submitThenVerify(tx, f.manager, dayId, f.admin));
    expect(Number(await netDebit(sql, f.orgId, '1220')), 'control: the day raised 200.00 on 1220').toBe(200);

    const lineId = await rawDayLine(sql, { orgId: f.orgId, storeId: f.storeId, channelId: f.foodpandaId, platform: 'foodpanda', salesDate: DAY, orderValue: '250.00', personId: f.adminId });
    await correct({ orgId: f.orgId, lineId }, f.admin, { today: '2027-02-01' });
    expect(Number(await netDebit(sql, f.orgId, '1220')), 'the platform correction raised 1220 to 250.00').toBe(250);

    const feedId = (await asOrgOn(f.orgId, (tx) =>
      insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: DAY, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures: R1_FIGURES }),
    )).ids.sales!;
    await asOrgOn(f.orgId, (tx) => D.postPosCorrection(tx, f.manager, { salesDayId: dayId, feedId, entryDate: '2027-01-20', reason: 'POS voided a cash receipt' }));

    const [pc] = await sql<{ journal_entry_id: string }[]>`select journal_entry_id::text from sales_day_pos_corrections where org_id = ${f.orgId} and sales_day_id = ${dayId}`;
    expect(lineText(await linesOf(sql, pc!.journal_entry_id)), 'only the POS delta, no 1220 / 4150 line').toEqual(['Cr 1110 50.00', 'Dr 4100 50.00']);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(250);
    expect(Number(await netDebit(sql, f.orgId, '4150'))).toBe(-750);
  });
});

// =====================================================================================================
describe('S6b dual-run readers place a platform correction on the sales day', () => {
  const WEEK_OF_SALE = { weekStart: '2026-10-12', through: '2026-10-18' };
  const WEEK_OF_ENTRY = { weekStart: '2026-10-26', through: '2026-11-01' };
  const tender = (lines: { kind: string; glCode: string; partyId: string | null; amount?: string; byDay: { date: string; amount: string }[] }[], channelId: string) =>
    lines.find((l) => l.kind === 'sales_tender' && l.glCode === '1220' && l.partyId === channelId);

  it('correction posted 1 Nov (October closed) for the 12 Oct sale: v2Figures puts the -1,000.00 on 12 Oct (10,000.00 that day) and nothing on the week of 1 Nov [kills: the entry date used for sales_tender, which splits the sale from its correction across weeks]', async () => {
    const f = await fx(sql, 'dr-figs', { staff: '11000.00', file: '10000.00' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    await correct(f, f.admin);
    expect((await corrections(sql, f.orgId))[0]!.entry_date).toBe(NEXT_OPEN);

    const sale = await asOrg(f.orgId, (tx) => dualRunRepo.v2Figures(tx, f.orgId, { storeId: f.storeA, ...WEEK_OF_SALE }));
    expect(tender(sale.lines, f.channelId)?.byDay, 'the correction lands on the sales day').toEqual([{ date: DATE, amount: '10000.00' }]);
    const entryWeek = await asOrg(f.orgId, (tx) => dualRunRepo.v2Figures(tx, f.orgId, { storeId: f.storeA, ...WEEK_OF_ENTRY }));
    expect(tender(entryWeek.lines, f.channelId)?.amount ?? '0.00', 'nothing on the week the entry was posted').toBe('0.00');
  });

  it('v2Documents: the correction is its own sales_tender document on 12 Oct, amount -1,000.00, flagged platformCorrection; the day\'s own document is not flagged [kills: no flag (the comparator cannot assign the class); a flag on every sale document]', async () => {
    const f = await fx(sql, 'dr-docs', { staff: '11000.00', file: '10000.00' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    await correct(f, f.admin);
    const c = (await corrections(sql, f.orgId))[0]!;
    const docs = (await asOrg(f.orgId, (tx) => dualRunRepo.v2Documents(tx, f.orgId, { storeId: f.storeA, ...WEEK_OF_SALE }))) as unknown as { id: string; kind: string; glCode: string; partyId: string | null; date: string; amount: string; platformCorrection?: boolean }[];
    const corr = docs.find((d) => d.id.startsWith(`v2:sale:${c.id}:sales_tender:`) && d.glCode === '1220');
    expect(corr, 'the correction\'s own 1220 document').toBeDefined();
    expect(corr).toMatchObject({ kind: 'sales_tender', partyId: f.channelId, date: DATE, amount: '-1000.00', platformCorrection: true });
    const own = docs.find((d) => d.glCode === '1220' && d.amount === '11000.00');
    expect(own, 'the day\'s own 1220 document').toBeDefined();
    expect(own!.platformCorrection ?? false).toBe(false);
  });
});
