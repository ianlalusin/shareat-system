import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-558 R3 (TESTER) - the day close with short-paid receipts (amends T-531). docs/tasks/558-pos-sale-variance-tolerance.md R3; bible rows 453, 270.
 *
 * WHAT CHANGES (R3): T-531 asserted  sum(byTender) = grossTotal  exactly. It becomes  sum(byTender) + varianceTotal = grossTotal, where varianceTotal = the sum of the receipts' gaps
 * (only gaps above zero; an overpayment's change never offsets one). The reading gains `varianceTotal` and `shortfallCount` (receipts whose gap is above the tolerance, the findings).
 * The derived sales day: revenue unchanged (the server's prices); the TENDER side is short by varianceTotal, so the day carries a variance line from the looked-up posting pattern.
 * The December bridge: payments.totalGross stays the gross, byMethod sums to gross - variance, a day over PHP 1 of variance is refused (pure cases: src/pos/t558-v1-bridge-variance.test.ts;
 * the database-driven ones are here). The slips are in apps/erp/src/lib/pos-print/t558-short-payments.test.ts.
 *
 * THE POSTING ACCOUNT: a short payment posts DR 7350 Cash over and short (Ian 11 Nov, bible row 459, POSTING-PATTERNS
 * `sale.pos-short-payment`). `VARIANCE_ACCOUNT` pins it in one place.
 *
 * ASSUMED API: the Reading from readingFor / xReading / closeDay carries `varianceTotal` (decimal text) and `shortfallCount` (number). The sales day and its posting are reached only
 * through the existing closeDay / verifySalesDay (a column or routing input for the variance is the builder's; this file asserts the journal).
 *
 * RED NOW FOR THE RIGHT REASON: the reading has no varianceTotal; and closing a day with a short receipt is refused by the derived-day check
 * ("The day ... cannot be booked as it stands: the day does not reconcile") because the tender side is short.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { RefusalError } from '@shareat/db';
import { verifySalesDay } from '@shareat/domain';
import {
  DC, asOrg, clockAt, close, closeAll, closeTendersOf, closesOf, fakeWriter, journalLines, pinOf, reading, salesDaysOf, standardDay, tenderMap, type Reading,
} from './_fixtures/t531-day-close';
import { D1, cents, manila, sellHundred, world58, type World58 } from './_fixtures/t558-variance';

afterAll(closeAll);

/** The account a POS short payment posts to: bible row 459. */
const VARIANCE_ACCOUNT = '7350';
const KNOWN_LINES = ['1110', '1140', '4100', '4150', '4900', '4950'];
const END = manila(D1, '22:30');
const PESO = '₱';

const sum = (xs: string[]) => xs.reduce((a, x) => a + cents(x), 0);
const identity = (r: Reading) => {
  expect(sum(Object.values(tenderMap(r))) + cents(r.varianceTotal ?? 'MISSING'), 'sum of tenders + variance = gross').toBe(cents(r.grossTotal));
};

/** Two receipts at 100.00: one paid in full, one paid 99.99 (variance 0.01, no finding). */
async function shortDay(w: World58) {
  await sellHundred(w, [{ tenderId: w.cash, amount: '100.00' }], manila(D1, '12:00'));
  await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], manila(D1, '13:00'));
}
const verifyAs = (w: World58, dayId: string) => asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, dayId));
const closeIt = async (w: World58) => close(w, END, await pinOf(w, w.managerId));

// ======================================================================================================================
describe('R3 reading - sum of tenders + sum of variance = gross', () => {
  it('2 receipts, one paid 99.99: gross 200.00, cash 199.99, varianceTotal 0.01, shortfallCount 0; the identity holds [kills: the old exact "tenders = gross" assertion throwing an internal fault]', async () => {
    const w = await world58();
    await shortDay(w);
    const r = await reading(w, END);
    expect(r).toMatchObject({ receiptCount: 2, grossTotal: '200.00', varianceTotal: '0.01', shortfallCount: 0 });
    expect(tenderMap(r)).toEqual({ [w.cash]: '199.99' });
    identity(r);
  });

  it('a finding too: add a GCash sale paid 99.50 - variance 0.51, one finding, tenders cash 199.99 + GCash 99.50, identity holds', async () => {
    const w = await world58();
    await shortDay(w);
    await sellHundred(w, [{ tenderId: w.gcash, amount: '99.50', ref: 'GC-558-0010' }], manila(D1, '14:00'));
    const r = await reading(w, END);
    expect(r).toMatchObject({ receiptCount: 3, grossTotal: '300.00', varianceTotal: '0.51', shortfallCount: 1 });
    expect(tenderMap(r)).toEqual({ [w.cash]: '199.99', [w.gcash]: '99.50' });
    identity(r);
  });

  it('a day paid exactly or over in cash has varianceTotal 0.00 and shortfallCount 0: change never offsets a gap and is never a variance', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '100.00' }], manila(D1, '12:00'));
    await sellHundred(w, [{ tenderId: w.cash, amount: '120.00' }], manila(D1, '13:00'));
    const r = await reading(w, END);
    expect(r).toMatchObject({ grossTotal: '200.00', varianceTotal: '0.00', shortfallCount: 0 });
    expect(tenderMap(r)).toEqual({ [w.cash]: '200.00' });
    identity(r);
  });

  it('a short receipt and an over-paid receipt on one day: the variance is 0.01, NOT 0.01 - 0.20 (only gaps above zero count)', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], manila(D1, '12:00'));
    await sellHundred(w, [{ tenderId: w.cash, amount: '100.20' }], manila(D1, '13:00'));
    const r = await reading(w, END);
    expect(r).toMatchObject({ grossTotal: '200.00', varianceTotal: '0.01' });
    identity(r);
  });

  it('the X reading (xReading) carries the same two figures', async () => {
    const w = await world58();
    await shortDay(w);
    const x = (await asOrg(w.orgId, (tx) => DC.xReading(tx, w.counter, { storeId: w.storeId, terminalId: w.terminalId }, clockAt(END)))) as Reading;
    expect(x).toMatchObject({ varianceTotal: '0.01', shortfallCount: 0 });
  });
});

// ======================================================================================================================
describe('R3 close - a short day closes, and the sales day it derives posts balanced', () => {
  it('closeDay on the short day is NOT refused: the Z holds gross 200.00 and tenders 199.99 (tenders + variance = gross); one submitted pos_receipts sales day at total 200.00', async () => {
    const w = await world58();
    await shortDay(w);
    const res = await closeIt(w);
    expect(res.reading).toMatchObject({ grossTotal: '200.00', varianceTotal: '0.01', shortfallCount: 0 });
    expect((await closesOf(w)).map((z) => z.gross_total)).toEqual(['200.00']);
    expect(sum((await closeTendersOf(res.dayCloseId)).map((t) => t.amount))).toBe(19999);
    expect(await salesDaysOf(w)).toMatchObject([{ status: 'submitted', source: 'pos_receipts', total_sales: '200.00' }]);
  });

  it('a day with a FINDING also closes (a short payment is never a reason to refuse the close): shortfallCount 1 on the Z', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.50' }], manila(D1, '12:00'));
    const res = await closeIt(w);
    expect(res.reading).toMatchObject({ varianceTotal: '0.50', shortfallCount: 1 });
    expect(await salesDaysOf(w)).toHaveLength(1);
  });

  it('verify posts a BALANCED entry: debits equal credits at 200.00, the revenue is the server\'s 200.00, and the variance is ONE extra debit line of exactly 0.01 [kills: posting the cash at 200.00; dropping the variance; a one-sided entry]', async () => {
    const w = await world58();
    await shortDay(w);
    await closeIt(w);
    const [d] = await salesDaysOf(w);
    const res = await verifyAs(w, d!.id);
    const lines = await journalLines(res.journalEntryId);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0), 'debits').toBe(20000);
    expect(lines.reduce((a, l) => a + cents(l.credit), 0), 'credits').toBe(20000);
    expect(lines.filter((l) => cents(l.credit) > 0).map((l) => [l.code, l.credit])).toEqual([['4150', '200.00']]);
    expect(lines.filter((l) => l.code === '1110').map((l) => l.debit), 'cash is what was actually taken').toEqual(['199.99']);
    const extra = lines.filter((l) => cents(l.debit) > 0 && !KNOWN_LINES.includes(l.code));
    expect(extra.map((l) => l.debit), 'exactly one more debit line, the variance').toEqual(['0.01']);
  });

  it('the variance line is a debit of 0.01 to VARIANCE_ACCOUNT, the looked-up cash over/short account - 1110 199.99, 7350 0.01 / 4150 200.00', async () => {
    const w = await world58();
    await shortDay(w);
    await closeIt(w);
    const [d] = await salesDaysOf(w);
    const lines = await journalLines((await verifyAs(w, d!.id)).journalEntryId);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['1110', '199.99', '0.00'],
      ['4150', '0.00', '200.00'],
      [VARIANCE_ACCOUNT, '0.01', '0.00'], // journalLines orders by account code, so 7350 sorts after 4150
    ]);
  });

  it('the standard three-receipt day plus one short receipt: both tender-side and revenue-side identities hold - the entry balances at 3,175.00 with the variance beside the discounts', async () => {
    const w = await world58();
    await standardDay(w);
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], manila(D1, '22:00'));
    const res = await closeIt(w);
    expect(res.reading).toMatchObject({ grossTotal: '2996.71', varianceTotal: '0.01' });
    const [d] = await salesDaysOf(w);
    const lines = await journalLines((await verifyAs(w, d!.id)).journalEntryId);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0)).toBe(317500);
    expect(lines.reduce((a, l) => a + cents(l.credit), 0)).toBe(317500);
    expect(lines.map((l) => [l.code, l.debit, l.credit]).filter(([c]) => KNOWN_LINES.includes(c!))).toEqual([
      ['1110', '2496.70', '0.00'],
      ['1140', '500.00', '0.00'],
      ['4100', '0.00', '2245.00'],
      ['4150', '0.00', '930.00'],
      ['4900', '178.29', '0.00'],
    ]);
    expect(lines.filter((l) => !KNOWN_LINES.includes(l.code)).map((l) => l.debit)).toEqual(['0.01']);
  });

  it('a day with NO short payment posts exactly as T-531 pinned (no variance line, no extra account) [control: the unchanged path]', async () => {
    const w = await world58();
    await standardDay(w);
    await closeIt(w);
    const [d] = await salesDaysOf(w);
    const lines = await journalLines((await verifyAs(w, d!.id)).journalEntryId);
    expect(lines.map((l) => l.code)).toEqual(['1110', '1140', '4100', '4150', '4900']);
  });
});

// ======================================================================================================================
describe('R3 bridge - the December document for a short day (driven from the database)', () => {
  const pathOf = (w: World58) => `stores/${w.posStoreId}/analytics/${D1.replace(/-/g, '')}`;
  const sentence = (x: string) => `Short payments of ${PESO}${x} exceed v1's ${PESO}1 check; send this day by hand.`;
  const send = (w: World58, writer: unknown) => asOrg(w.orgId, (tx) => DC.sendV1Bridge(tx, w.counter, { storeId: w.storeId, businessDates: [D1] }, { writer }));
  const resend = (w: World58, writer: unknown) => asOrg(w.orgId, (tx) => DC.resendV1Bridge(tx, w.manager, { storeId: w.storeId, businessDate: D1 }, { writer }));

  it('variance 0.01: the document is sent with totalGross 200 (the gross) and byMethod cash 199.99 (gross minus variance)', async () => {
    const w = await world58();
    await shortDay(w);
    await closeIt(w);
    const fw = fakeWriter();
    const out = await send(w, fw.writer);
    expect(out.results).toMatchObject([{ businessDate: D1, status: 'sent' }]);
    expect(fw.calls).toHaveLength(1);
    expect(fw.calls[0]!.path).toBe(pathOf(w));
    expect(fw.calls[0]!.data).toMatchObject({ payments: { totalGross: 200, txCount: 2, byMethod: { cash: 199.99 } } });
  });

  it('variance exactly 1.00 (paid 99.00): still sent', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.00' }], manila(D1, '12:00'));
    await closeIt(w);
    const fw = fakeWriter();
    expect((await send(w, fw.writer)).results[0]).toMatchObject({ status: 'sent' });
    expect(fw.calls[0]!.data).toMatchObject({ payments: { totalGross: 100, byMethod: { cash: 99 } } });
  });

  it('variance over PHP 1 (paid 98.99, short 1.01): the bridge write is refused with the exact sentence - nothing is sent, the failure is recorded, the close stays committed', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '98.99' }], manila(D1, '12:00'));
    const res = await closeIt(w);
    const fw = fakeWriter();
    const out = await send(w, fw.writer);
    expect(out.results[0]).toMatchObject({ businessDate: D1, status: 'failed', reason: sentence('1.01') });
    expect(fw.calls).toHaveLength(0);
    expect((await closesOf(w)).map((z) => z.id)).toEqual([res.dayCloseId]);
  });

  it('Resend of that day is refused in words (a RefusalError with the same sentence) and writes nothing', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '98.99' }], manila(D1, '12:00'));
    await closeIt(w);
    const fw = fakeWriter();
    const err = await resend(w, fw.writer).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe(sentence('1.01'));
    expect(fw.calls).toHaveLength(0);
  });
});
