import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S5b (TESTER, 2026-11-05) - the day detail and the slice-5 exit checks on the redacted Lipa fixtures, on a REAL Postgres.
 * docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 5 and "Tests" (the late-order exit check, the key scan); design Component K, decisions 15, 17, 19;
 * docs/discovery/t511-exit5-store-day-comparison.md (Lipa 20 Oct: recorded 9,474.00 against file 9,928.00 = 454.00, the 23:18 order).
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/review.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT (tester's choices where the spec leaves a signature open; the builder must meet these or ask BOSS to change the tests). The spec names no function that
 * hands the day detail to the screen, so one is added: `getReviewDayDetail`, exported from `review.ts` and from `@shareat/domain`:
 *  D1  `getReviewDayDetail(tx, actor, { lineId }, opts?: { today?: string }): Promise<ReviewDayDetail | null>`. null for an unknown line, another org's line, or a line the
 *      actor may not see (the same answer for all three: nothing leaks that the line exists). Visible under the same store scope as `listReviewDays`.
 *  D2  ReviewDayDetail = {
 *        lineId, storeId, storeName, platform, salesDate, reviewState, decisionReason: string | null, changedSinceBooked,
 *        fileFigure: string (the file order value), staffFigure: string | null, difference: string | null (file minus staff, fresh as in listReviewDays),
 *        orders: { time: string | null; amount: string }[],
 *        salesCorrection: { to: string; on: string; sentence: string } | null,
 *        loan: { check: { status, blocking, sentence, ownLines } | null; lines: { kind: 'deduction' | 'disbursal'; amount: string; loanName: string | null; ownerStoreName: string | null; allocationSource: 'auto' | 'admin' }[] },
 *        charges: { commission, marketing, platformFee, vendorDiscount, grossInfo },  // numeric text, as staged
 *        otherLines: { kind, bookedAs, amount, lineDate: string | null, description: string | null }[],
 *        vatOnFees: string | null,   // Foodpanda: re-read from the STORED file, 12% of Appendix B (CPC + weekly fee) rounded once on the sum; null for Grab
 *        feeMonthNote: string | null,
 *        blockers: { code, sentence }[], willPostOn: string | null, postNote: string | null }   // = dayBlockers
 *  D3  ORDERS (the staff-accuracy list, read again from the STORED file, nothing kept in the tables): present ONLY when `difference` is neither null nor "0.00"; then every
 *      order of that sales day, ascending by time, each with EXACTLY the keys `time` and `amount`: Grab `time` = "HH:MM" 24-hour Manila wall clock as printed in
 *      `Created On`, `amount` = the order's `Net Sales` (the order-value basis); Foodpanda `time` = null (the file has a date only) and `amount` = column R. NO order id,
 *      transaction id, booking id, customer or merchant field, in the keys or anywhere in the serialized detail.
 *  D4  `salesCorrection` (a read-only preview, nothing posts): when the difference is not null and not "0.00": { to: the file figure, on: `firstOpenDateOnOrAfter(salesDate, today)` as
 *      YYYY-MM-DD, sentence: "Sales will be corrected to <file figure, thousands separators> on <date> ..." }; else null.
 *  D5  Privacy: a manager's detail has no other store's name, no company-wide loan amount, no UUID in any sentence; `loan.lines` are the viewer's OWN store's lines only.
 *  D6  The PandaGO-only invoice (no day): `listReviewDays(...).pandagoOnly[0]` carries `sentence` = exactly "PandaGO: <amount> will be paid to you by Foodpanda (cash on delivery that
 *      PandaGO riders collected for you, less PandaGO fees). It is not part of the sales receivable and is not booked here; record it yourself." (<amount> is 374.32, a peso sign or a
 *      thousands separator allowed), and `dateNote`: one sentence that gives the workbook's invoice date (2026-10-02 or 2 Oct) and says the PDF may carry another date.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { getReviewDayDetail, listReviewDays } from '../../src/settlement-intake/review';
import { cents, fmt, grabOracle, readFpFixture, sum } from '../unit/t511-s4-helpers';
import {
  UUID_RE, asOrg, closedPeriod, fixture, lineOn, mkLoan, parseGrab, salesDay, stageGrabOctober, upload, world3, type World3,
} from './_fixtures/t511-s5-world';

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
const detailOf = (w: World3, who: Actor, lineId: string, opts: { today?: string } = { today: TODAY }) => asOrg(w.orgId, (tx) => getReviewDayDetail(tx, who, { lineId }, opts));
const stageLipa = (w: World3) => stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, w.managerA, 'lipa');

/* ------------------------------------------------------------------ an independent oracle over the fixture text (never the code under test) */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
interface Order { time: string; amount: string }
/** Every Payment row of the Lipa October Transactions file whose printed Created On date is `date`, ascending by time. */
function grabOrdersOn(date: string): Order[] {
  const g = parseGrab(fixture('grab-lipa-oct-transactions.csv'));
  const at = (name: string): number => g.headers.findIndex((h) => h.trim() === name);
  const out: Order[] = [];
  for (const r of g.rows) {
    if ((r[at('Category')] ?? '').trim() !== 'Payment') continue;
    const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/.exec((r[at('Created On')] ?? '').trim());
    if (!m) throw new Error('oracle: unreadable Created On');
    const iso = `${m[3]}-${String(MONTHS.indexOf(m[2] as string) + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
    if (iso !== date) continue;
    const hour = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
    out.push({ time: `${String(hour).padStart(2, '0')}:${m[5]}`, amount: fmt(cents(r[at('Net Sales')] as string)) });
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : cents(a.amount) < cents(b.amount) ? -1 : 1));
}
const total = (orders: Order[]): bigint => sum(orders.map((o) => cents(o.amount)));

/** every value the redacted Grab file prints that identifies an order, a customer, a merchant or a store (at least 6 characters) */
function identifyingValues(): string[] {
  const g = parseGrab(fixture('grab-lipa-oct-transactions.csv'));
  const columns = g.headers.map((h, i) => [h.trim(), i] as const).filter(([h]) => /(^|\s)(ID|Name)$|ID \d$|Customer|Phone|Email|Address/i.test(h) && h !== 'Settlement ID');
  const values = new Set<string>();
  for (const r of g.rows) for (const [, i] of columns) {
    const v = (r[i] ?? '').trim();
    if (v.length >= 6) values.add(v);
  }
  return [...values];
}
function keysOf(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((e) => keysOf(e, out));
  else if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.push(k); keysOf(v, out); }
  return out;
}
const FORBIDDEN_KEY = /(order|booking|transaction|merchant|partner|passenger)_?id|customer|passenger|phone|email|address/i;

/* ================================================================== the late-order exit check */

describe('T-511 S5b exit check - the days with an order after 23:00 show the staff-versus-file gap, with the order listed', () => {
  it('Lipa 20 Oct (the real recorded figure): 9,474.00 recorded against 9,928.00 in the file = 454.00, and the 23:18 order of 454.00 is on the list [kills: no staff-vs-file gap; the late order missing]', async () => {
    const w = await world3(sql, 'detail-20oct');
    await stageLipa(w);
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-20', '9474.00', { verified: true });
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-20');
    const d = (await detailOf(w, w.managerA, line.id))!;
    expect(d).toMatchObject({ lineId: line.id, storeName: 'Lipa', platform: 'grab', salesDate: '2026-10-20', fileFigure: '9928.00', staffFigure: '9474.00', difference: '454.00', reviewState: 'pending' });
    const expected = grabOrdersOn('2026-10-20');
    expect(expected.length).toBe(22);
    expect(d.orders).toEqual(expected);
    expect(d.orders.filter((o) => (o.time ?? '') >= '23:00')).toEqual([{ time: '23:18', amount: '454.00' }]);
    expect(fmt(total(d.orders.map((o) => ({ time: o.time ?? '', amount: o.amount }))))).toBe('9928.00');
  });

  for (const date of ['2026-10-01', '2026-10-05', '2026-10-10', '2026-10-19', '2026-10-22', '2026-10-26']) {
    it(`Lipa ${date}: staff left out the order after 23:00, so the gap is exactly that order and it is listed with its time and amount [kills: a late order lost at the day boundary]`, async () => {
      const w = await world3(sql, `detail-late-${date}`);
      await stageLipa(w);
      const orders = grabOrdersOn(date);
      const late = orders.filter((o) => o.time >= '23:00');
      expect(late.length, `the fixture has an order after 23:00 on ${date}`).toBeGreaterThan(0);
      const fileFigure = total(orders);
      expect(fmt(fileFigure), 'the oracle agrees with the staged file figure').toBe(grabOracle(fixture('grab-lipa-oct-transactions.csv'), fixture('grab-lipa-oct-transfers.csv')).days.get(date)!.orderValue);
      await salesDay(sql, w, w.storeA, w.grabA, date, fmt(fileFigure - total(late)), { verified: true });
      const line = await lineOn(sql, w.orgId, w.grabA, date);
      const d = (await detailOf(w, w.managerA, line.id))!;
      expect(d.difference).toBe(fmt(total(late)));
      expect(d.staffFigure).toBe(fmt(fileFigure - total(late)));
      expect(d.orders).toEqual(orders);
      expect(d.orders.filter((o) => (o.time ?? '') >= '23:00')).toEqual(late);
    });
  }

  it('Lipa 21 Oct: the late order of the 20th booked a day late makes the 21st\'s recorded figure 454.00 too high; the gap is -454.00 and the day\'s orders are listed [kills: a negative gap hidden]', async () => {
    const w = await world3(sql, 'detail-21oct');
    await stageLipa(w);
    const orders = grabOrdersOn('2026-10-21');
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-21', fmt(total(orders) + 45400n), { verified: true });
    const d = (await detailOf(w, w.managerA, (await lineOn(sql, w.orgId, w.grabA, '2026-10-21')).id))!;
    expect(d.difference).toBe('-454.00');
    expect(d.orders).toEqual(orders);
  });

  it('a day with no gap lists no orders and offers no correction; a day whose sales day is not verified has no figure, no gap and no list [kills: orders always shown; a gap invented]', async () => {
    const w = await world3(sql, 'detail-nogap');
    await stageLipa(w);
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-12', '6753.00', { verified: true });
    const same = (await detailOf(w, w.managerA, (await lineOn(sql, w.orgId, w.grabA, '2026-10-12')).id))!;
    expect(same).toMatchObject({ staffFigure: '6753.00', difference: '0.00', orders: [], salesCorrection: null });
    const waiting = (await detailOf(w, w.managerA, (await lineOn(sql, w.orgId, w.grabA, '2026-10-13')).id))!;
    expect(waiting).toMatchObject({ staffFigure: null, difference: null, orders: [], salesCorrection: null });
    expect(waiting.blockers.map((b) => b.sentence).join(' | ')).toMatch(/waiting for the sales day to be verified/i);
  });
});

describe('T-511 S5b day detail - the sales correction preview (read-only text)', () => {
  it('Lipa 20 Oct, October open: "Sales will be corrected to 9,928.00 on 2026-10-20"; with October closed it names the first open date, 1 November [kills: a correction date that ignores the closed period]', async () => {
    const w = await world3(sql, 'detail-correction', { periods: false });
    await stageLipa(w);
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-20', '9474.00', { verified: true });
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-20');
    const open = (await detailOf(w, w.managerA, line.id))!;
    expect(open.salesCorrection).toMatchObject({ to: '9928.00', on: '2026-10-20' });
    expect(open.salesCorrection!.sentence).toMatch(/^Sales will be corrected to \S*9,928\.00 on (2026-10-20|20 Oct)/i);
    await closedPeriod(sql, w, '2026-10-01', '2026-10-31');
    const closed = (await detailOf(w, w.managerA, line.id))!;
    expect(closed.salesCorrection).toMatchObject({ to: '9928.00', on: '2026-11-01' });
    expect(closed.salesCorrection!.sentence).toMatch(/on (2026-11-01|1 Nov)/i);
    expect(closed.willPostOn).toBe('2026-11-01');
  });
});

/* ================================================================== no order id, no customer: the key scan */

describe('T-511 S5b day detail - nothing that identifies an order, a customer, a merchant or a store leaves the server', () => {
  it('Lipa 20 Oct: every order has exactly the keys time and amount; no key anywhere names an order id, customer, phone, email or address; no value of any identifying column of the file appears in the serialized detail [kills: an order id or customer field in the list]', async () => {
    const w = await world3(sql, 'detail-keyscan');
    await stageLipa(w);
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-20', '9474.00', { verified: true });
    const d = (await detailOf(w, w.admin, (await lineOn(sql, w.orgId, w.grabA, '2026-10-20')).id))!;
    expect(d.orders.length).toBe(22);
    for (const o of d.orders) expect(Object.keys(o).sort()).toEqual(['amount', 'time']);
    for (const k of keysOf(d)) expect(k, `key ${k}`).not.toMatch(FORBIDDEN_KEY);
    const text = JSON.stringify(d);
    const values = identifyingValues();
    expect(values.length, 'the oracle found identifying values to look for').toBeGreaterThan(100);
    for (const v of values) expect(text, 'an identifying value leaked').not.toContain(v);
    for (const s of [...d.blockers.map((b) => b.sentence), d.loan.check?.sentence ?? '', d.salesCorrection?.sentence ?? '']) expect(s).not.toMatch(UUID_RE);
  });

  it('Foodpanda: the day\'s orders carry a date only (time null) and their column R amounts; the total is the day\'s file figure; nothing else about an order [kills: invented times; extra fields]', async () => {
    const w = await world3(sql, 'detail-fp-orders');
    await ingest(w, w.managerA, { bytes: upload('foodpanda-lipa-oct5-34col.zip').bytes, contentType: 'application/zip' });
    const inv = await readFpFixture('foodpanda-lipa-oct5-34col.zip');
    const date = inv.orders[0]!.orderDate;
    const mine = inv.orders.filter((o) => o.orderDate === date).map((o) => o.revenueAfterDiscounts).sort();
    expect(mine.length).toBeGreaterThan(1);
    const fileFigure = sum(mine.map((m) => cents(m)));
    await salesDay(sql, w, w.storeA, w.fpA, date, fmt(fileFigure - 10000n), { verified: true });
    const d = (await detailOf(w, w.managerA, (await lineOn(sql, w.orgId, w.fpA, date)).id))!;
    expect(d).toMatchObject({ platform: 'foodpanda', fileFigure: fmt(fileFigure), difference: '100.00' });
    expect(d.orders.map((o) => o.time)).toEqual(mine.map(() => null));
    expect(d.orders.map((o) => o.amount).sort()).toEqual(mine);
    for (const o of d.orders) expect(Object.keys(o).sort()).toEqual(['amount', 'time']);
    expect(d.loan.check).toBeNull();
    for (const k of keysOf(d)) expect(k).not.toMatch(FORBIDDEN_KEY);
  });
});

/* ================================================================== Foodpanda: VAT on fees, PandaGO, both dates */

describe('T-511 S5b day detail - Foodpanda figures re-read from the stored file', () => {
  it('"VAT on fees" is its own figure: 12% of Appendix B (CPC ads and the weekly platform fee) rounded once on the sum, read again from the stored invoice (Lipa 23-30 Sep); Grab has none [kills: VAT folded into the fee with no line of its own; per-row rounding]', async () => {
    const w = await world3(sql, 'detail-vat');
    await ingest(w, w.managerA, { bytes: upload('foodpanda-lipa-oct5-34col.zip').bytes, contentType: 'application/zip' });
    const inv = await readFpFixture('foodpanda-lipa-oct5-34col.zip');
    const rows = inv.charges.filter((c) => c.kind === 'cpc_ad' || c.kind === 'platform_fee');
    const exact = sum(rows.map((c) => cents(c.netTotal) * BigInt(c.vatRate)));
    const vat = (2n * exact + 100n) / 200n; // round half up, once, on the sum
    expect(vat, 'the invoice has Appendix B charges').toBeGreaterThan(0n);
    const date = inv.orders[0]!.orderDate;
    const d = (await detailOf(w, w.admin, (await lineOn(sql, w.orgId, w.fpA, date)).id))!;
    expect(d.vatOnFees).toBe(fmt(vat));
    const g = await world3(sql, 'detail-vat-grab');
    await stageLipa(g);
    const grab = (await detailOf(g, g.admin, (await lineOn(sql, g.orgId, g.grabA, '2026-10-12')).id))!;
    expect(grab.vatOnFees).toBeNull();
  });

  it('the PandaGO-only invoice: the approved sentence with 374.32, and one note with the workbook date and a pointer to the PDF [kills: PandaGO booked or silent; wording drift]', async () => {
    const w = await world3(sql, 'detail-pandago');
    await ingest(w, w.managerA, { bytes: upload('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip').bytes, contentType: 'application/zip' });
    const out = await asOrg(w.orgId, (tx) => listReviewDays(tx, w.managerA, {}));
    const p = (out as unknown as { pandagoOnly: { sentence: string; dateNote: string; workbookDate: string }[] }).pandagoOnly[0]!;
    expect(p.sentence).toMatch(
      /^PandaGO: \S*374\.32 will be paid to you by Foodpanda \(cash on delivery that PandaGO riders collected for you, less PandaGO fees\)\. It is not part of the sales receivable and is not booked here; record it yourself\.$/,
    );
    expect(p.workbookDate).toBe('2026-10-02');
    expect(p.dateNote).toMatch(/2026-10-02|2 Oct/);
    expect(p.dateNote).toMatch(/PDF/);
    expect(p.dateNote).not.toMatch(UUID_RE);
  });
});

/* ================================================================== privacy of the loan lines and of the detail itself */

describe('T-511 S5b day detail - who may see it and what a manager reads about loans', () => {
  it('an unknown line, another store\'s line (manager B) and another org\'s admin all get null: the same answer, nothing leaks [kills: a cross-store or cross-org read of a detail]', async () => {
    const w = await world3(sql, 'detail-scope');
    await stageLipa(w);
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-12');
    const other = await world3(sql, 'detail-scope-other');
    expect(await detailOf(w, w.managerB, line.id)).toBeNull();
    expect(await detailOf(other, other.admin, line.id)).toBeNull();
    expect(await detailOf(w, w.admin, '00000000-0000-4000-8000-0000000000ff')).toBeNull();
    expect(await detailOf(w, w.managerA, line.id)).not.toBeNull();
  });

  it('all three stores\' October files in, loans recorded: the manager of Lipa reads only Lipa\'s own deductions (49.87 and 1,771.88 on 13 Oct), never Malvar or Banay-banay, never the company total; the manager of Malvar the same for 541.37 [kills: another store\'s payments in a manager\'s detail]', async () => {
    const w = await world3(sql, 'detail-loan-privacy');
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    const lipa = (await detailOf(w, w.managerA, (await lineOn(sql, w.orgId, w.grabA, '2026-10-13')).id))!;
    expect(lipa.loan.lines.filter((l) => l.kind === 'deduction').map((l) => l.amount).sort()).toEqual(['1771.88', '49.87']);
    const lipaText = JSON.stringify(lipa);
    for (const secret of ['Malvar', 'Banay', '2363.12', '2,363.12']) expect(lipaText, secret).not.toContain(secret);
    const malvar = (await detailOf(w, w.managerB, (await lineOn(sql, w.orgId, w.grabB, '2026-10-13')).id))!;
    expect(malvar.loan.lines.filter((l) => l.kind === 'deduction').map((l) => l.amount)).toEqual(['541.37']);
    const malvarText = JSON.stringify(malvar);
    for (const secret of ['Banay', '49.87', '1771.88', '2363.12', '2,363.12']) expect(malvarText, secret).not.toContain(secret);
    for (const s of [lipa.loan.check?.sentence ?? '', malvar.loan.check?.sentence ?? '']) expect(s).not.toMatch(UUID_RE);
    const admin = (await detailOf(w, w.admin, (await lineOn(sql, w.orgId, w.grabA, '2026-10-13')).id))!;
    expect(admin.loan.check?.sentence).toMatch(/2,363\.12/);
  });

  it('the day\'s side tables: Lipa 12 Oct shows its 150,000.00 disbursal as a loan line of kind disbursal, and its other lines carry a kind and amount but no description with an id [kills: disbursal dropped; ids in descriptions]', async () => {
    const w = await world3(sql, 'detail-side');
    await stageLipa(w);
    const d = (await detailOf(w, w.admin, (await lineOn(sql, w.orgId, w.grabA, '2026-10-12')).id))!;
    expect(d.loan.lines.map((l) => `${l.kind}:${l.amount}`).sort()).toEqual(['deduction:591.24', 'disbursal:150000.00']);
    for (const o of d.otherLines) expect(o.description ?? '').not.toMatch(UUID_RE);
    const want = grabOracle(fixture('grab-lipa-oct-transactions.csv'), fixture('grab-lipa-oct-transfers.csv')).days.get('2026-10-12')!;
    expect(d.charges).toMatchObject({ commission: want.commission, marketing: want.marketing, platformFee: want.platformFee, grossInfo: want.grossInfo });
    expect([d.charges.commission, d.charges.grossInfo]).toEqual(['1688.25', '6807.00']); // the figures of docs/discovery/t511-exit5-store-day-comparison.md
  });
});
