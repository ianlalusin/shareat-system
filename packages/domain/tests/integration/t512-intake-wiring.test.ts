import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-512 (T-511 S5c) TESTER - the settlement intake reads the rule book. docs/tasks/512-business-rules-s5c-spec.md "Wiring" items 2, 3 and 4.
 * Real Postgres (`_test` database via TEST_DATABASE_URL). Public entry points only: `ingestSettlementFile`, `loanCheckForDay`, `dayBlockers`,
 * `getReviewDayDetail`, `listReviewDays`. Rules are put in force on past dates with a RAW insert (`putRule`): the writer refuses backdating, a test cannot wait for 2026.
 *
 * RED today (effect tests): withholding / VAT / loan tolerance / the "large" mark are constants. GREEN today and must stay green: the defaults tests and the query count.
 *
 * ASSUMPTIONS beyond the agreed list (builders must follow them):
 *   - the "large" mark is a boolean `differenceLarge` on BOTH `SettlementReviewRow` (listReviewDays) and `ReviewDayDetail` (getReviewDayDetail); false when there is no difference
 *     or no staff figure; its base for the percent is the FILE figure (orderValue); it uses the absolute difference (staff above the file counts); a difference exactly AT the
 *     tolerance is not large (the T-150 rule: past tolerance + half a centavo). Every non-zero difference is still flagged (`needsAttention`, `difference`): large is not a blocker.
 *   - the loan tolerance and the Foodpanda withholding/VAT are resolved on the line's SALES DATE (Foodpanda: the invoice's LAST sales day), the day itself included.
 *   - a staged line keeps its snapshot: changing a rule after an upload does not touch the stored other lines.
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
import { readFpFixture } from '../unit/t511-s4-helpers';
import { LIPA_FP, asOrg, lineOn, mkLoan, salesDay, setDestination, stageGrabOctober, synthFoodpanda, upload, world3, type World3 } from './_fixtures/t511-s5-world';
import { putRule } from './_fixtures/t512-rules';

const sql = postgres(url, { max: 8 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const zip = (b: Buffer): File => ({ bytes: b, contentType: 'application/zip' });
const TODAY = '2026-11-05';
let tagSeq = 0;
const tag = (): string => `t512-${Date.now()}-${++tagSeq}`;
const money = (c: bigint): string => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
const centsOf = (t: string): bigint => {
  const neg = t.startsWith('-');
  const [i = '0', f = ''] = (neg ? t.slice(1) : t).split('.');
  const v = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -v : v;
};

/* ================================================================== Wiring 4: staging resolves withholding and VAT on the invoice's LAST sales day */

describe('T-512 ingest - Foodpanda withholding and VAT come from the rules, resolved on the invoice\'s last sales day', () => {
  const FILE = 'foodpanda-lipa-oct5-34col.zip'; // Lipa 23-30 Sep: R / 1.12 base, 0.5%, rounding line -0.05 on the last sales day
  const adjustments = (orgId: string) =>
    sql<{ amount: string; sales_date: string }[]>`
      select o.amount::text, d.sales_date::text from settlement_other_lines o join settlement_day_lines d on d.org_id = o.org_id and d.id = o.day_line_id
       where o.org_id = ${orgId} and o.kind = 'adjustment' order by d.sales_date`;
  const lastDay = async (): Promise<string> => (await readFpFixture(FILE)).orders.map((o) => o.orderDate).sort().at(-1)!;
  const dayAfter = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  it('defaults: the five-PDF rounding line is staged exactly as before, on the last sales day (green today) [kills: a default that moved]', async () => {
    const w = await world3(sql, 'ing-default');
    const last = await lastDay();
    const r = await ingest(w, w.managerA, zip(upload(FILE).bytes));
    expect(r.warnings.join(' | ')).not.toMatch(/does not match the usual rule/i);
    expect(await adjustments(w.orgId)).toEqual([{ amount: '-0.05', sales_date: last }]);
  });

  it('a withholding rate of 1% in force from the invoice\'s last sales day: that day\'s rule applies to the WHOLE invoice (no order matches 1%: no rounding line, the "usual rule" warning); the start day itself counts [kills: the rule read on today\'s date; < for <=]', async () => {
    const w = await world3(sql, 'ing-wh-on');
    const last = await lastDay();
    await putRule(sql, w.orgId, 'tax.withholding_rate_percent', '1.000000', last);
    const r = await ingest(w, w.managerA, zip(upload(FILE).bytes));
    expect(await adjustments(w.orgId)).toEqual([]);
    expect(r.warnings.join(' | ')).toMatch(/does not match the usual rule/i);
  });

  it('the same rate starting the day AFTER the last sales day is not used: the file stages as at the defaults [kills: reading the latest row regardless of date; reading the upload date]', async () => {
    const w = await world3(sql, 'ing-wh-after');
    const last = await lastDay();
    await putRule(sql, w.orgId, 'tax.withholding_rate_percent', '1.000000', dayAfter(last));
    const r = await ingest(w, w.managerA, zip(upload(FILE).bytes));
    expect(await adjustments(w.orgId)).toEqual([{ amount: '-0.05', sales_date: last }]);
    expect(r.warnings.join(' | ')).not.toMatch(/does not match the usual rule/i);
  });

  it('a rate that started before the invoice\'s FIRST day but was replaced before its last day is read as of the last day: the later row wins [kills: the first sales day used]', async () => {
    const w = await world3(sql, 'ing-wh-last');
    const last = await lastDay();
    await putRule(sql, w.orgId, 'tax.withholding_rate_percent', '1.000000', '2026-01-01', { at: '2026-01-01T00:00:00Z' });
    await putRule(sql, w.orgId, 'tax.withholding_rate_percent', '0.500000', last, { at: '2026-02-01T00:00:00Z' });
    await ingest(w, w.managerA, zip(upload(FILE).bytes));
    expect(await adjustments(w.orgId)).toEqual([{ amount: '-0.05', sales_date: last }]);
  });

  it('VAT 0% in force on the last sales day changes the divisor: the R / 1.12 invoice no longer matches, so no rounding line [kills: 112 fixed]', async () => {
    const w = await world3(sql, 'ing-vat');
    const last = await lastDay();
    await putRule(sql, w.orgId, 'tax.vat_percent', '0.000000', last);
    const r = await ingest(w, w.managerA, zip(upload(FILE).bytes));
    expect(await adjustments(w.orgId)).toEqual([]);
    expect(r.warnings.join(' | ')).toMatch(/does not match the usual rule/i);
  });

  it('another org\'s rule never reaches this org\'s staging [kills: a rule read across orgs]', async () => {
    const w = await world3(sql, 'ing-iso');
    const other = await world3(sql, 'ing-iso-other');
    await putRule(sql, other.orgId, 'tax.withholding_rate_percent', '1.000000', '2000-01-01');
    await ingest(w, w.managerA, zip(upload(FILE).bytes));
    expect(await adjustments(w.orgId)).toHaveLength(1);
  });

  it('snapshot: a rule changed AFTER the upload does not restate the staged lines (the figure computed at upload stays) [kills: a staged line recomputed on read]', async () => {
    const w = await world3(sql, 'ing-snapshot');
    const last = await lastDay();
    await ingest(w, w.managerA, zip(upload(FILE).bytes));
    const before = await adjustments(w.orgId);
    expect(before).toEqual([{ amount: '-0.05', sales_date: last }]);
    await putRule(sql, w.orgId, 'tax.withholding_rate_percent', '1.000000', '2000-01-01');
    await putRule(sql, w.orgId, 'tax.vat_percent', '0.000000', '2000-01-01');
    expect(await adjustments(w.orgId)).toEqual(before);
    const line = await lineOn(sql, w.orgId, w.fpA, last);
    const detail = await asOrg(w.orgId, (tx) => getReviewDayDetail(tx, w.admin, { lineId: line.id }, { today: TODAY }));
    expect(detail!.otherLines.filter((l) => l.kind === 'adjustment').map((l) => l.amount)).toEqual(['-0.05']);
  });
});

/* ================================================================== Wiring 3: the loan final tolerance, per sales date */

describe('T-512 loan check - the final-payment tolerance is the rule, resolved on the sales date', () => {
  /**
   * The 27 Oct case (S5b): on 27 Oct the files take 2,363.11 against 2,363.12 expected, and it matches ONLY because loan 1 is on its last payment (591.24 left) and Grab
   * shortens a last payment by a centavo. To land the October files on that state the loan's principal is measured, not guessed: a first world runs the allocator with
   * a huge principal and sums what loan 1 takes on every earlier staged day; the real world then borrows exactly that sum plus 591.24.
   */
  async function stageThreeStores(w: World3): Promise<void> {
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) {
      await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    }
  }
  const earlierDates = async (w: World3): Promise<string[]> => {
    const rows = await sql<{ d: string }[]>`
      select distinct sales_date::text as d from settlement_day_lines where org_id = ${w.orgId} and platform = 'grab' and is_current and sales_date < '2026-10-27' order by 1`;
    return rows.map((r) => r.d);
  };
  async function measurePending(): Promise<bigint> {
    const w = await world3(sql, 'loan-measure');
    await stageThreeStores(w);
    const loan1 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '900000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '900000.00', repayment: '1771.88' });
    let total = 0n;
    for (const d of await earlierDates(w)) {
      const r = await asOrg(w.orgId, (tx) => loanCheckForDay(tx, w.admin, d));
      total += centsOf(String(r.result.byLoan.find((l) => l.loanId === loan1)!.allocated));
    }
    return total;
  }
  async function finalDayWorld(hint: string) {
    const pending = await measurePending();
    const w = await world3(sql, hint);
    await stageThreeStores(w);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: money(pending + 59124n), repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    return w;
  }
  const check = (w: World3, date = '2026-10-27') => asOrg(w.orgId, (tx) => loanCheckForDay(tx, w.admin, date));

  it('defaults: 27 Oct passes (2,363.11 against 2,363.12, loan 1 on its last payment) and an ordinary day passes (green today) [kills: the S5b audit fix lost]', async () => {
    const w = await finalDayWorld('loan-default');
    const last = await check(w);
    expect(last.result.status, last.result.sentence).toBe('ok');
    expect(last.result.byLoan.some((l) => l.final)).toBe(true);
    expect((await check(w, '2026-10-20')).result.status).toBe('ok');
  });

  it('a final-payment tolerance of 0.00 in force from 1 Oct flips 27 Oct from ok to mismatch, while the ordinary day 20 Oct stays ok (the tolerance belongs to the final loan only) [kills: the tolerance fixed at one centavo; the tolerance applied to every day]', async () => {
    const w = await finalDayWorld('loan-zero');
    await putRule(sql, w.orgId, 'settlement.loan_final_tolerance', '0.000000', '2026-10-01');
    const last = await check(w);
    expect(last.result.status, last.result.sentence).toBe('mismatch');
    expect(last.result.blocking).toBe(true);
    expect((await check(w, '2026-10-20')).result.status).toBe('ok');
  });

  it('the tolerance is read on the SALES DATE: a 0.00 that starts on 28 Oct leaves 27 Oct ok; one that starts ON 27 Oct already applies [kills: today\'s rule used for a past day; < for <=]', async () => {
    const later = await finalDayWorld('loan-later');
    await putRule(sql, later.orgId, 'settlement.loan_final_tolerance', '0.000000', '2026-10-28');
    expect((await check(later)).result.status).toBe('ok');
    const onDay = await finalDayWorld('loan-onday');
    await putRule(sql, onDay.orgId, 'settlement.loan_final_tolerance', '0.000000', '2026-10-27');
    expect((await check(onDay)).result.status).toBe('mismatch');
  });

  it('every path that shows the loan check sees the same rule: the loan check itself, the day blockers, the day detail and the review list [kills: one path left on the constant]', async () => {
    const w = await finalDayWorld('loan-paths');
    await setDestination(sql, w, w.grabA);
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-27');
    const paths = async () => {
      const blockers = await asOrg(w.orgId, async (tx) => dayBlockers(tx, w.admin, (await settlementIntakeRepo.dayLineById(tx, w.orgId, line.id))!, { today: TODAY }));
      const detail = await asOrg(w.orgId, (tx) => getReviewDayDetail(tx, w.admin, { lineId: line.id }, { today: TODAY }));
      const list = await asOrg(w.orgId, (tx) => listReviewDays(tx, w.admin, {}));
      const row = list.days.find((d) => d.lineId === line.id)!;
      return {
        check: (await check(w)).result.status,
        blocker: blockers.blockers.some((b) => b.code === 'loan_check'),
        detail: detail!.loan.check?.status,
        list: row.loanCheck?.status,
      };
    };
    expect(await paths()).toEqual({ check: 'ok', blocker: false, detail: 'ok', list: 'ok' });
    await putRule(sql, w.orgId, 'settlement.loan_final_tolerance', '0.000000', '2026-10-01');
    expect(await paths()).toEqual({ check: 'mismatch', blocker: true, detail: 'mismatch', list: 'mismatch' });
  });
});

/* ================================================================== Wiring 2: the "large" mark */

describe('T-512 review - a difference is marked "large" by the same variance rule, on the sales date; every difference is still flagged', () => {
  /** one synthetic Foodpanda day of `revenue`, verified by staff at `staff`; returns the review row and the day detail of that day */
  async function dayWith(w: World3, date: string, revenue: number, staff: string) {
    await ingest(w, w.managerA, zip(synthFoodpanda([{ date, revenue }], LIPA_FP, tag())));
    await salesDay(sql, w, w.storeA, w.fpA, date, staff, { verified: true });
    const line = await lineOn(sql, w.orgId, w.fpA, date);
    const list = await asOrg(w.orgId, (tx) => listReviewDays(tx, w.admin, {}));
    const row = list.days.find((d) => d.lineId === line.id)! as typeof list.days[number] & { differenceLarge?: boolean };
    const detail = (await asOrg(w.orgId, (tx) => getReviewDayDetail(tx, w.admin, { lineId: line.id }, { today: TODAY })))! as NonNullable<Awaited<ReturnType<typeof getReviewDayDetail>>> & { differenceLarge?: boolean };
    return { row, detail };
  }
  const staffFor = (revenue: number, diff: string): string => money(BigInt(revenue) * 100n - centsOf(diff));

  it('defaults (floor 50.00, 10%): on a 300.00 day, 30.00 and 50.00 are flagged but not large, 50.01 is large; on a 5,000.00 day 500.00 is not large and 500.01 is; a negative difference counts by its size [kills: the mark missing; floor and percent swapped; > for >=]', async () => {
    const w = await world3(sql, 'lg-default');
    const cases: [string, number, string, boolean][] = [
      ['2026-10-01', 300, '30.00', false],
      ['2026-10-02', 300, '50.00', false],
      ['2026-10-03', 300, '50.01', true],
      ['2026-10-04', 5000, '499.99', false],
      ['2026-10-05', 5000, '500.00', false],
      ['2026-10-06', 5000, '500.01', true],
      ['2026-10-07', 300, '-80.00', true],
      ['2026-10-08', 300, '-30.00', false],
    ];
    for (const [date, revenue, diff, large] of cases) {
      const { row, detail } = await dayWith(w, date, revenue, staffFor(revenue, diff));
      expect(row.difference, `${date} difference`).toBe(diff);
      expect(row.needsAttention, `${date} ${diff}: every non-zero difference is still flagged`).toBe(true);
      expect(row.differenceLarge, `${date} ${diff} (list)`).toBe(large);
      expect(detail.differenceLarge, `${date} ${diff} (detail)`).toBe(large);
    }
  });

  it('no difference, or no staff figure yet: nothing is large and nothing is invented [kills: a mark on a clean day]', async () => {
    const w = await world3(sql, 'lg-none');
    const clean = await dayWith(w, '2026-10-01', 300, '300.00');
    expect(clean.row.difference).toBe('0.00');
    expect(clean.row.differenceLarge).toBeFalsy();
    expect(clean.detail.differenceLarge).toBeFalsy();
    await ingest(w, w.managerA, zip(synthFoodpanda([{ date: '2026-10-02', revenue: 300 }], LIPA_FP, tag()))); // no verified sales day
    const line = await lineOn(sql, w.orgId, w.fpA, '2026-10-02');
    const list = await asOrg(w.orgId, (tx) => listReviewDays(tx, w.admin, {}));
    const row = list.days.find((d) => d.lineId === line.id)! as { difference: string | null; differenceLarge?: boolean };
    expect(row.difference).toBeNull();
    expect(row.differenceLarge).toBeFalsy();
  });

  it('floor 5.00 and percent 1 from 1 Sep: a 30.00 difference on a 300.00 day is now large, 5.00 is not, 5.01 is; a rule that starts later (floor 1,000 from 20 Oct) applies from that day only [kills: the rule read as a constant; the date ignored]', async () => {
    const w = await world3(sql, 'lg-rules');
    await putRule(sql, w.orgId, 'settlement.variance_floor_amount', '5.000000', '2026-09-01');
    await putRule(sql, w.orgId, 'settlement.variance_percent', '1.000000', '2026-09-01');
    await putRule(sql, w.orgId, 'settlement.variance_floor_amount', '1000.000000', '2026-10-20');
    const cases: [string, number, string, boolean][] = [
      ['2026-10-01', 300, '30.00', true],
      ['2026-10-02', 300, '5.00', false],
      ['2026-10-03', 300, '5.01', true],
      ['2026-10-05', 300, '100.00', true],
      ['2026-10-25', 300, '100.00', false],
      ['2026-10-20', 300, '-900.00', false],
      ['2026-10-19', 300, '-900.00', true],
    ];
    for (const [date, revenue, diff, large] of cases) {
      const { row, detail } = await dayWith(w, date, revenue, staffFor(revenue, diff));
      expect(row.needsAttention, `${date} ${diff}: still flagged`).toBe(true);
      expect(row.differenceLarge, `${date} ${diff} (list)`).toBe(large);
      expect(detail.differenceLarge, `${date} ${diff} (detail)`).toBe(large);
    }
  });
});

/* ================================================================== the query count stays flat (green today) */

describe('T-512 listReviewDays - reading the rule book adds at most ONE query to the 36 of S5b, at 30 days and at 90 days', () => {
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
  const listWith = (w: World3, who: Actor) =>
    asOrg(w.orgId, async (tx) => {
      const counter = queryCounter(tx);
      const rows = await listReviewDays(tx, who);
      const queries = counter.count();
      counter.stop();
      return { queries, days: rows.days.length };
    });

  it('30 days and 90 days (3 stores, loans, a rule row in place) both stay within 37 queries and do not grow with the days [kills: a rule lookup per day]', async () => {
    const w = await world3(sql, 't512-count');
    await stageThreeStoresQuick(w);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-06-12', principal: '150000.00', repayment: '1771.88' });
    await setDestination(sql, w, w.grabA);
    await putRule(sql, w.orgId, 'settlement.variance_floor_amount', '80.000000', '2026-01-01');
    await putRule(sql, w.orgId, 'settlement.loan_final_tolerance', '0.020000', '2026-01-01');
    await sql`update settlement_day_lines set is_current = false where org_id = ${w.orgId} and sales_date <> '2026-10-13'`;
    await cloneGrabDays(w, '2026-07-01', 9);
    const small = await listWith(w, w.admin);
    await cloneGrabDays(w, '2026-08-01', 20);
    const big = await listWith(w, w.admin);
    expect(big.days).toBeGreaterThan(small.days * 2);
    expect(small.queries, `30 days: ${small.queries}`).toBeLessThanOrEqual(37);
    expect(big.queries, `90 days: ${big.queries}`).toBeLessThanOrEqual(37);
    expect(big.queries, `small ${small.queries}, big ${big.queries}`).toBeLessThanOrEqual(small.queries);
  });

  async function stageThreeStoresQuick(w: World3): Promise<void> {
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) {
      await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    }
  }
});
