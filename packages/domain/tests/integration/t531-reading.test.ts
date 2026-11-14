import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-531 R2 (TESTER) - the reading: `readingFor` and `xReading` (docs/tasks/531-pos-day-close.md R2, R8 "Reading"). Real Postgres on a scratch "_test" database.
 * Sales are made through the real domain; every device figure is priceSession's (see `_fixtures/t531-day-close.ts`, which also holds the standard day's hand figures).
 *
 * ASSUMED API: see the header of the fixture. `readingFor(tx, actor, { storeId, terminalId, at }, deps)` returns `Reading` (camelCase names exactly as R2 spells them;
 * `byTender` is read through `tenderMap`, so an array of `{ tenderId, amount }` or a record keyed by tender id both pass). Money is a decimal string ('2896.71').
 * `xReading(tx, actor, { storeId, terminalId }, deps)` is the paired terminal's reading with `record_sale`; it writes nothing.
 *
 * RED NOW FOR THE RIGHT REASON: packages/domain/src/pos/day-close.ts does not exist. The module is loaded lazily, so each case fails "MISSING EXPORT: ... (T-531 not built)"
 * AFTER its fixture ran. The "fixture sanity" cases run for real.
 *
 * Window times (Manila, day starts 04:00): D1 04:00 is where a store live from D1 opens its first window (row 390); the first window is read at `at`.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { AuthorizationError } from '@shareat/auth';
import {
  D1, D2, DC, RATES, asOrg, auditsOf, clockAt, closeAll, manila, porkSale, reading, secondTerminal, sell, sql, standardDay, stateVersion, tenderMap, world, type World,
} from './_fixtures/t531-day-close';

afterAll(closeAll);

/** A Z written by raw SQL (the reading's tests do not depend on closeDay): its window, and the receipts it holds. */
async function rawZ(w: World, o: { date: string; start: Date; end: Date; zNo?: number; receiptIds: string[] }): Promise<string> {
  const [z] = await sql<{ id: string }[]>`
    insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
    values (${w.orgId}, ${w.storeId}, ${w.terminalId}, ${o.zNo ?? 1}, ${o.date}, ${o.start}, ${o.end}, ${o.receiptIds.length}, 0, ${w.counterId}, ${w.managerId}) returning id`;
  if (o.receiptIds.length > 0) await sql`update pos_sales_receipts set day_close_id = ${z!.id} where id in ${sql(o.receiptIds)}`;
  return z!.id;
}

// ======================================================================================================================
describe('fixture sanity (runs now: the standard day is what the cases below assume)', () => {
  it('three receipts with the hand figures, change on the cash lines, the senior on R2 and the 10% preset on R3', async () => {
    const w = await world();
    const made = await standardDay(w);
    expect(made.map((m) => [m.subtotal, m.discountTotal, m.total])).toEqual([
      ['1427.00', '0.00', '1427.00'],
      ['1148.00', '128.29', '1019.71'],
      ['500.00', '50.00', '450.00'],
    ]);
    const pay = await sql<{ name: string; amount: string; change_given: string }[]>`
      select t.name, p.amount::text, p.change_given::text from pos_sales_receipt_payments p join tenders t on t.id = p.tender_id
        join pos_sales_receipts r on r.id = p.receipt_id where r.org_id = ${w.orgId} order by r.receipt_seq, t.name`;
    expect(pay).toEqual([
      { name: 'Cash', amount: '2000.00', change_given: '573.00' },
      { name: 'Cash', amount: '600.00', change_given: '80.29' },
      { name: 'GCash', amount: '500.00', change_given: '0.00' },
      { name: 'Cash', amount: '500.00', change_given: '50.00' },
    ]);
    const kinds = await sql<{ kind: string; n: number }[]>`
      select d.kind, count(*)::int n from pos_sales_receipt_line_discounts d join pos_sales_receipt_lines l on l.id = d.receipt_line_id
        join pos_sales_receipts r on r.id = l.receipt_id where r.org_id = ${w.orgId} group by d.kind order by d.kind`;
    expect(kinds).toEqual([{ kind: 'preset', n: 1 }, { kind: 'senior', n: 1 }]);
    const refill = await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipt_lines l join pos_sales_receipts r on r.id = l.receipt_id where r.org_id = ${w.orgId} and l.kind = 'refill' and l.gross = 0`;
    expect(refill[0]!.n).toBe(1);
  });

  it('the live store opens its first window at live_from; the v1 methods are mapped (Cash, GCash) for the bridge tests', async () => {
    const w = await world('live', D1);
    const [s] = await sql<{ mode: string; live_from: string }[]>`select mode, live_from::text from pos_stores where store_id = ${w.storeId}`;
    expect(s).toEqual({ mode: 'live', live_from: D1 });
    const [t] = await sql<{ n: number }[]>`select count(*)::int n from tenders where store_id = ${w.storeId} and pos_v1_alias in ('Cash','GCash')`;
    expect(t!.n).toBe(2);
  });
});

// ======================================================================================================================
describe('R2 - the figures of the open window (centavo exact)', () => {
  it('the standard day: count, gross (receipt totals after discounts), subtotal, discounts by kind, diners, heads, sessions', async () => {
    const w = await world();
    await standardDay(w);
    const r = await reading(w, manila(D1, '22:30'));
    expect(r.windowStart).toEqual(manila(D1, '04:00'));
    expect(r.windowEnd).toEqual(manila(D1, '22:30'));
    expect(r.receiptCount).toBe(3);
    expect(r.grossTotal).toBe('2896.71');
    expect(r.subtotal).toBe('3075.00');
    expect(r.discountTotal).toBe('178.29');
    expect(r.discounts).toEqual({ senior: '128.29', pwd: '0.00', other: '50.00' });
    expect(r.seniorPwdDiners).toBe(1);
    expect(r.heads).toBe(5);
    expect(r.packageSessions).toBe(2);
    expect(r.lateCount).toBe(0);
    expect(r.toCheckCount).toBe(0);
    expect(r.spansTwoDates).toBe(false);
  });

  it('unli + a la carte = subtotal, EXACTLY (stated from the receipt lines, never a residual); refill lines are 0; checked against the raw lines by kind', async () => {
    const w = await world();
    await standardDay(w);
    const r = await reading(w, manila(D1, '22:30'));
    expect(r.unliSales).toBe('2245.00');
    expect(r.alaCarteSales).toBe('830.00');
    const [raw] = await sql<{ pkg: string; other: string }[]>`
      select coalesce(sum(l.gross) filter (where l.kind = 'package'), 0)::text pkg, coalesce(sum(l.gross) filter (where l.kind <> 'package'), 0)::text other
        from pos_sales_receipt_lines l join pos_sales_receipts r on r.id = l.receipt_id where r.org_id = ${w.orgId}`;
    expect([r.unliSales, r.alaCarteSales]).toEqual([raw!.pkg, raw!.other]);
    expect(Number(r.unliSales) + Number(r.alaCarteSales)).toBeCloseTo(Number(r.subtotal), 2);
  });

  it('byTender is the NET collected: cash is the tendered amount minus the change on each receipt (2,396.71, not 3,100.00); GCash as tendered; their sum is the gross, exactly', async () => {
    const w = await world();
    await standardDay(w);
    const r = await reading(w, manila(D1, '22:30'));
    const by = tenderMap(r);
    expect(by[w.cash]).toBe('2396.71');
    expect(by[w.gcash]).toBe('500.00');
    expect(Object.keys(by).sort()).toEqual([w.cash, w.gcash].sort());
    expect(Number(by[w.cash]) + Number(by[w.gcash])).toBeCloseTo(Number(r.grossTotal), 2);
  });

  it('senior, PWD and other discounts are split by kind: a PWD diner (128.29), a custom fixed (60.00) and a preset (50.00) -> other 110.00; senior 0.00', async () => {
    const w = await world();
    const m = w.menu;
    await sell(w, { at: manila(D1, '12:00'), items: [{ item: m.unli, qty: 2 }], discounts: [{ lineIndex: 0, kind: 'pwd', qty: 1, dinerNo: 1 }], expectTotal: '769.71', pay: [{ tenderId: w.cash, amount: '800.00' }] });
    await sell(w, { at: manila(D1, '13:00'), items: [{ item: m.pork, qty: 2 }], discounts: [{ lineIndex: 0, kind: 'custom', qty: 2, valueType: 'fixed', value: '30.00' }], expectTotal: '440.00', pay: [{ tenderId: w.cash, amount: '440.00' }] });
    await sell(w, { at: manila(D1, '14:00'), items: [{ item: m.pork, qty: 2 }], discounts: [{ lineIndex: 0, kind: 'preset', qty: 2, presetId: w.emp10 }], expectTotal: '450.00', pay: [{ tenderId: w.cash, amount: '450.00' }] });
    const r = await reading(w, manila(D1, '22:00'));
    expect(r.discounts).toEqual({ senior: '0.00', pwd: '128.29', other: '110.00' });
    expect(r.discountTotal).toBe('238.29');
    expect(r.subtotal).toBe('1898.00');
    expect(r.grossTotal).toBe('1659.71');
    expect(r.seniorPwdDiners).toBe(1);
    expect(tenderMap(r)[w.cash]).toBe('1659.71');
  });

  it('an offline wallet payment is counted in its tender as tendered AND counted in toCheckCount', async () => {
    const w = await world();
    await sell(w, { at: manila(D1, '12:00'), items: [{ item: w.menu.pork, qty: 1 }], offline: true, expectTotal: '250.00', pay: [{ tenderId: w.gcash, amount: '250.00' }] });
    await porkSale(w, manila(D1, '13:00'));
    const r = await reading(w, manila(D1, '22:00'));
    expect(r.toCheckCount).toBe(1);
    expect(tenderMap(r)[w.gcash]).toBe('250.00');
    expect(tenderMap(r)[w.cash]).toBe('250.00');
    expect(r.grossTotal).toBe('500.00');
  });

  it('an empty window reads zeros (count 0, gross 0.00), not an error', async () => {
    const w = await world();
    const r = await reading(w, manila(D1, '10:00'));
    expect([r.receiptCount, r.grossTotal, r.subtotal, r.discountTotal, r.unliSales, r.alaCarteSales, r.heads, r.packageSessions]).toEqual([0, '0.00', '0.00', '0.00', '0.00', '0.00', 0, 0]);
    expect(Object.keys(tenderMap(r))).toEqual([]);
  });

  it('only THIS terminal\'s receipts: a sale on terminal 2 is not in terminal 1\'s reading', async () => {
    const w = await world();
    const t2 = await secondTerminal(w);
    await porkSale(w, manila(D1, '12:00'));
    await sell(w, { at: manila(D1, '13:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', pay: [{ tenderId: w.cash, amount: '500.00' }], terminal: t2 });
    const r1 = await reading(w, manila(D1, '22:00'));
    expect([r1.receiptCount, r1.grossTotal]).toEqual([1, '250.00']);
    const r2 = await asOrg(w.orgId, (tx) => DC.readingFor(tx, w.counter, { storeId: w.storeId, terminalId: t2.terminalId, at: manila(D1, '22:00') }, clockAt(manila(D1, '22:00'))));
    expect([r2.receiptCount, r2.grossTotal]).toEqual([1, '500.00']);
  });
});

// ======================================================================================================================
describe('R2 - the window', () => {
  it('the first-ever window opens at live_from + the business-day start hour (04:00 by RATES) on the store\'s live_from date', async () => {
    const w = await world('live', D1);
    await porkSale(w, manila(D1, '12:00'));
    expect((await reading(w, manila(D1, '22:00'))).windowStart).toEqual(manila(D1, '04:00'));
  });

  it('the start hour is the T-539 rule, not a constant: with a 06:00 day start the first window opens at 06:00', async () => {
    const w = await world('live', D1);
    await porkSale(w, manila(D1, '12:00'));
    const six = { readRules: async () => ({ ...(await RATES.readRules()), businessDayStartHour: 6 }), now: () => manila(D1, '22:00') };
    const r = await asOrg(w.orgId, (tx) => DC.readingFor(tx, w.counter, { storeId: w.storeId, terminalId: w.terminalId, at: manila(D1, '22:00') }, six));
    expect(r.windowStart).toEqual(manila(D1, '06:00'));
  });

  it('after a Z the window starts at that Z\'s window_end and holds only receipts that were not closed (the closed ones are excluded)', async () => {
    const w = await world();
    const day = await standardDay(w);
    await rawZ(w, { date: D1, start: manila(D1, '04:00'), end: manila(D2, '05:30'), receiptIds: day.map((d) => d.receiptId) });
    await porkSale(w, manila(D2, '12:00'));
    const r = await reading(w, manila(D2, '22:00'));
    expect(r.windowStart).toEqual(manila(D2, '05:30'));
    expect(r.windowEnd).toEqual(manila(D2, '22:00'));
    expect([r.receiptCount, r.grossTotal, r.lateCount]).toEqual([1, '250.00', 0]);
  });

  it('a LATE receipt (issued before windowStart, synced after the last Z) is counted in this window and flagged late; nothing is lost', async () => {
    const w = await world();
    const day = await standardDay(w);
    await rawZ(w, { date: D1, start: manila(D1, '04:00'), end: manila(D2, '05:30'), receiptIds: day.map((d) => d.receiptId) });
    await porkSale(w, manila(D2, '03:00')); // issued at 03:00 on D2, before the Z's end, but only now recorded
    await porkSale(w, manila(D2, '12:00'));
    const r = await reading(w, manila(D2, '22:00'));
    expect([r.receiptCount, r.grossTotal, r.lateCount]).toEqual([2, '500.00', 1]);
  });

  it('spansTwoDates: false at 22:30 on D1; false at exactly 04:00:00.000 on D2 (the last millisecond is still D1); true one millisecond later and at 10:00 on D2', async () => {
    const w = await world('live', D1);
    await porkSale(w, manila(D1, '12:00'));
    expect((await reading(w, manila(D1, '22:30'))).spansTwoDates).toBe(false);
    expect((await reading(w, manila(D2, '04:00'))).spansTwoDates).toBe(false);
    expect((await reading(w, new Date(manila(D2, '04:00').getTime() + 1))).spansTwoDates).toBe(true);
    expect((await reading(w, manila(D2, '10:00'))).spansTwoDates).toBe(true);
  });
});

// ======================================================================================================================
describe('R2 - X-reading: the same figures, nothing written, record_sale only', () => {
  it('xReading returns the open window\'s figures and writes NOTHING (no Z, no day_close_id, no sales day, no audit row, no state_version bump)', async () => {
    const w = await world();
    await standardDay(w);
    const before = async () => ({
      closes: Number((await sql<{ n: number }[]>`select count(*)::int n from pos_day_closes where org_id = ${w.orgId}`)[0]!.n),
      closed: Number((await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipts where org_id = ${w.orgId} and day_close_id is not null`)[0]!.n),
      days: Number((await sql<{ n: number }[]>`select count(*)::int n from sales_days where org_id = ${w.orgId}`)[0]!.n),
      audits: Number((await sql<{ n: number }[]>`select count(*)::int n from audit_log where org_id = ${w.orgId}`)[0]!.n),
      version: await stateVersion(w),
    });
    const was = await before();
    const x = await asOrg(w.orgId, (tx) => DC.xReading(tx, w.counter, { storeId: w.storeId, terminalId: w.terminalId, pairingId: w.pairingId }, clockAt(manila(D1, '22:30'))));
    expect([x.receiptCount, x.grossTotal, x.subtotal]).toEqual([3, '2896.71', '3075.00']);
    expect(await before()).toEqual(was);
    expect((await auditsOf(w, 'pos.day_closed')).length).toBe(0);
  });

  it('a person without record_sale (the kitchen) and a manager of ANOTHER store are refused; the counter and the store manager read', async () => {
    const w = await world();
    await porkSale(w, manila(D1, '12:00'));
    const x = (who: typeof w.counter) => asOrg(w.orgId, (tx) => DC.xReading(tx, who, { storeId: w.storeId, terminalId: w.terminalId, pairingId: w.pairingId }, clockAt(manila(D1, '22:30'))));
    await expect(x(w.counter)).resolves.toMatchObject({ receiptCount: 1 });
    await expect(x(w.manager)).resolves.toMatchObject({ receiptCount: 1 });
    await expect(x(w.kitchen)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(x(w.managerOther)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
