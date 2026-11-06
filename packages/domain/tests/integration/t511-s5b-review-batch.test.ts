import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S5b, BOSS fixes (builder 3, 5 Nov 2026), on a REAL Postgres (a `_test` database via TEST_DATABASE_URL).
 *   FIX 1  `listReviewDays` issues a FIXED number of queries however many days it lists (it ran about 15 per pending day), and its answers are exactly the single-day
 *          paths' (`getReviewDayDetail` / `dayBlockers`): same blockers, same loan check, same figures.
 *   FIX 2  "Waiting for other stores' files" waits only for a store that staff recorded Grab sales for that day (the rule of the "no file yet" list: a VERIFIED sales
 *          day, not no-sales, amount above zero). A store that was closed (no sales day) is never waited on.
 *   FIX 3  Every fiscal period up to today closed: `willPostOn` null and a plain sentence that the books are closed; nothing crashes.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, settlementIntakeRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { dayBlockers } from '../../src/settlement-intake/day-checks';
import { loanCheckForDay } from '../../src/settlement-intake/loan-check';
import { getReviewDayDetail, listReviewDays } from '../../src/settlement-intake/review';
import { asOrg, closedPeriod, lineOn, mkLoan, salesDay, setDestination, stageGrabOctober, world3, type World3 } from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 8 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const stageAll = async (w: World3): Promise<void> => {
  for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) {
    await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
  }
};
const TODAY = '2026-11-05';

/** Counts every statement a transaction sends to Postgres (postgres.js `unsafe` is what drizzle calls for each one). */
function queryCounter(tx: Tx): { count: () => number; stop: () => void } {
  const client = (tx as unknown as { session: { client: { unsafe: (...a: unknown[]) => unknown } } }).session.client;
  const original = client.unsafe;
  let n = 0;
  client.unsafe = function counted(this: unknown, ...a: unknown[]) {
    n += 1;
    return original.apply(client, a);
  };
  return { count: () => n, stop: () => void (client.unsafe = original) };
}

/** `days` more Grab days per store (one copy of that store's 13 Oct line and its loan lines on each date), dates from `from`. Raw connection. */
async function cloneGrabDays(w: World3, from: string, days: number): Promise<void> {
  for (const channelId of [w.grabA, w.grabB, w.grabC]) {
    const template = await lineOn(sql, w.orgId, channelId, '2026-10-13');
    await sql`
      with made as (
        insert into settlement_day_lines (org_id, channel_id, store_id, platform, sales_date, version, source_upload_id, order_value, gross_info, commission, marketing,
          platform_fee, vendor_discount, loan_deduction, loan_disbursal, net_payout, paid_state)
        select t.org_id, t.channel_id, t.store_id, t.platform, d::date, 1, t.source_upload_id, t.order_value, t.gross_info, t.commission, t.marketing, t.platform_fee,
          t.vendor_discount, t.loan_deduction, t.loan_disbursal, t.net_payout, 'paid'
          from settlement_day_lines t, generate_series(${from}::date, ${from}::date + ${days - 1}::int, interval '1 day') d
         where t.id = ${template.id}
        returning id)
      insert into settlement_loan_lines (org_id, day_line_id, kind, amount, row_ordinal)
      select l.org_id, m.id, l.kind, l.amount, l.row_ordinal from made m, settlement_loan_lines l where l.day_line_id = ${template.id}`;
  }
}

const listWith = async (w: World3, who: Actor): Promise<{ queries: number; rows: Awaited<ReturnType<typeof listReviewDays>> }> =>
  asOrg(w.orgId, async (tx) => {
    const counter = queryCounter(tx);
    const rows = await listReviewDays(tx, who);
    const queries = counter.count();
    counter.stop();
    return { queries, rows };
  });

/* ================================================================== FIX 1 */

describe('T-511 S5b FIX 1 - listReviewDays costs a fixed number of queries', () => {
  it('30 days versus 90 days (3 stores): the query count does not grow with the number of days, and every row equals the single-day answer [kills: a query per day; a batch that changes an answer]', async () => {
    const w = await world3(sql, 'batch-count');
    await stageAll(w);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-06-12', principal: '150000.00', repayment: '1771.88' });
    await salesDay(sql, w, w.storeA, w.grabA, '2026-07-02', '1000.00', { verified: true });
    await salesDay(sql, w, w.storeB, w.grabB, '2026-07-03', '1000.00', { verified: false });
    await setDestination(sql, w, w.grabA);

    // keep exactly one staged day per store (the 13 Oct template): 10 days a store is 30 in all, then 30 a store is 90
    await sql`update settlement_day_lines set is_current = false where org_id = ${w.orgId} and sales_date <> '2026-10-13'`;
    await cloneGrabDays(w, '2026-07-01', 9);
    const small = await listWith(w, w.admin);
    await cloneGrabDays(w, '2026-08-01', 20);
    const big = await listWith(w, w.admin);
    expect(big.rows.days.length).toBeGreaterThan(small.rows.days.length * 2);
    expect(big.queries, `small ${small.queries} for ${small.rows.days.length} days, big ${big.queries} for ${big.rows.days.length}`).toBeLessThanOrEqual(small.queries + 3);

    // identical to the single-day paths, for the admin and for the manager of one store (the redacted view)
    for (const who of [w.admin, w.managerA]) {
      const { rows } = await listWith(w, who);
      expect(rows.days.length).toBeGreaterThan(0);
      for (const row of rows.days) {
        const detail = await asOrg(w.orgId, (tx) => getReviewDayDetail(tx, who, { lineId: row.lineId }, { today: TODAY }));
        const fresh = await asOrg(w.orgId, async (tx) => {
          const line = (await settlementIntakeRepo.dayLineById(tx, w.orgId, row.lineId))!;
          return row.platform === 'grab' ? (await loanCheckForDay(tx, who, line.salesDate)).view : null;
        });
        expect(row.blockers, `${row.salesDate} ${row.storeName}`).toEqual(row.reviewState === 'pending' ? detail!.blockers.map((b) => b.sentence) : []);
        expect(row.loanCheck, `${row.salesDate} ${row.storeName}`).toEqual(fresh ? { status: fresh.status, sentence: fresh.sentence } : null);
        expect({ f: row.staffFigure, d: row.difference }).toEqual({ f: detail!.staffFigure, d: detail!.difference });
      }
    }
  });
});

/* ================================================================== FIX 2 */

describe('T-511 S5b FIX 2 - waiting for other stores\' files waits only for a store that recorded Grab sales that day', () => {
  async function threeStoresWithMalvarAndBanayLinesGone(hint: string) {
    const w = await world3(sql, hint);
    await stageAll(w);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    // Malvar's and Banay's files still COVER 13 Oct, but neither store holds a current line for it
    await sql`update settlement_day_lines set is_current = false where org_id = ${w.orgId} and channel_id in (${w.grabB}, ${w.grabC}) and sales_date = '2026-10-13'`;
    return w;
  }
  const check = (w: World3, who: Actor) => asOrg(w.orgId, (tx) => loanCheckForDay(tx, who, '2026-10-13'));

  it('Malvar was closed on 13 Oct (no sales day): not waited on. Banay has a verified sales day and no line: still waited on [kills: waiting for a closed store; never waiting]', async () => {
    const w = await threeStoresWithMalvarAndBanayLinesGone('fix2-closed');
    await salesDay(sql, w, w.storeC, w.grabC, '2026-10-13', '1200.00', { verified: true });
    const r = (await check(w, w.admin)).result;
    expect(r.status).toBe('waiting_for_other_stores');
    expect(r.waitingOn.map((s) => s.storeName)).toEqual(['Banay-banay']);
    expect(r.sentence).toContain('Banay-banay');
    expect(r.sentence).not.toContain('Malvar');
  });

  it('nobody recorded Grab sales that day: nothing to wait for, so the day is judged on the rows it has [kills: waiting on every covering file]', async () => {
    const w = await threeStoresWithMalvarAndBanayLinesGone('fix2-none');
    const r = (await check(w, w.admin)).result;
    expect(r.waitingOn).toEqual([]);
    expect(r.status).not.toBe('waiting_for_other_stores');
  });

  it('a confirmed no-sales day and an unverified day are not "recorded sales": not waited on (the rule of the "no file yet" list) [kills: any sales_days row counted]', async () => {
    const w = await threeStoresWithMalvarAndBanayLinesGone('fix2-nosales');
    await salesDay(sql, w, w.storeB, w.grabB, '2026-10-13', '0.00', { verified: true, noSales: true });
    await salesDay(sql, w, w.storeC, w.grabC, '2026-10-13', '900.00', { verified: false });
    expect((await check(w, w.admin)).result.waitingOn).toEqual([]);
  });

  it('manager view: still no store name, no id, whoever is waited on [kills: Banay named to a Lipa manager]', async () => {
    const w = await threeStoresWithMalvarAndBanayLinesGone('fix2-manager');
    await salesDay(sql, w, w.storeC, w.grabC, '2026-10-13', '1200.00', { verified: true });
    const v = (await check(w, w.managerA)).view;
    expect(v.status).toBe('waiting_for_other_stores');
    expect(v.sentence).toMatch(/^Waiting for other stores['’] files\.?$/i);
    expect(v.sentence).not.toMatch(/Malvar|Banay/);
  });
});

/* ================================================================== FIX 3 */

describe('T-511 S5b FIX 3 - every fiscal period up to today is closed', () => {
  it('willPostOn is null and postNote says the books are closed, in a plain sentence; dayBlockers, the detail and the list all answer [kills: a crash or a date in the future]', async () => {
    const w = await world3(sql, 'fix3-allclosed', { periods: false });
    await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, w.managerA, 'lipa');
    await closedPeriod(sql, w, '2026-10-01', '2026-10-31');
    await closedPeriod(sql, w, '2026-11-01', '2026-11-30');
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-13');

    const r = await asOrg(w.orgId, async (tx) => dayBlockers(tx, w.managerA, (await settlementIntakeRepo.dayLineById(tx, w.orgId, line.id))!, { today: TODAY }));
    expect(r.willPostOn).toBeNull();
    expect(r.postNote).toMatch(/books are closed/i);
    expect(r.postNote).not.toMatch(/[a-z]+_[a-z_]+/);

    const detail = await asOrg(w.orgId, (tx) => getReviewDayDetail(tx, w.managerA, { lineId: line.id }, { today: TODAY }));
    expect(detail).toMatchObject({ willPostOn: null });
    expect(detail!.postNote).toMatch(/books are closed/i);
    expect(detail!.salesCorrection).toBeNull();

    const list = await asOrg(w.orgId, (tx) => listReviewDays(tx, w.managerA));
    expect(list.days.map((d) => d.lineId)).toContain(line.id);
  });
});
