import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-534 S4 - refund: recordRefund, the Z / X that read refunds, the sales day the Z derives and the books it posts.
 * docs/tasks/534-pos-convert-correction-refund.md ("Refund", S4 tests). Real Postgres on a scratch "_test" database; sales are made through the real domain (T-531 fixture).
 *
 * The receipt NEVER changes; a refund is its own row with its lines and money-back rows, collected into the Z (day_close_id, once). Each case names the mutant it kills.
 */
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { AuthenticationError, POS_APPROVAL_REFUSED } from '@shareat/auth';
import { RefusalError, goneSentence } from '@shareat/db';
import { findSalesReceiptByNo, listTodaysSalesReceipts, recordRefund, verifySalesDay } from '../../src';
import { CORRECTION_NEEDS_PIN } from '../../src/pos/tender-correction';
import { RECORDED_DIFFERENTLY } from '../../src/pos/shared';
import { recordTenderCorrection, sendV1Bridge } from '../../src/pos';
import { D1, D2, asOrg, auditsOf, close, closeAll, fakeWriter, journalLines, manila, pinOf, reading, salesDaysOf, sell, sql, tenderMap, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');
const AT2 = manila(D2, '22:30');
const GC_REF = 'GC-REFUND-01';

interface Made { receiptId: string; total: string; lines: { id: string; name: string; qty: number; net: string; gross: string }[]; pays: { id: string; tender_id: string; amount: string }[] }

/** A sale through the real domain, with its line and payment ids read back. */
async function made(w: World, o: Parameters<typeof sell>[1]): Promise<Made> {
  const s = await sell(w, o);
  const lines = await sql<Made['lines']>`select id, name, qty, net::text, gross::text from pos_sales_receipt_lines where receipt_id = ${s.receiptId} order by line_no`;
  const pays = await sql<Made['pays']>`select id, tender_id, amount::text from pos_sales_receipt_payments where receipt_id = ${s.receiptId} order by id`;
  return { receiptId: s.receiptId, total: s.total, lines, pays };
}
/** 4 pork = 1,000.00 paid by `cash` and `gcash` (the rest of the 1,000 is GCash). */
const thousand = (w: World, cash: string, o: { at?: Date } = {}) =>
  made(w, {
    at: o.at ?? manila(D1, '12:00'), items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00',
    pay: [{ tenderId: w.cash, amount: cash }, ...(Number(cash) < 1000 ? [{ tenderId: w.gcash, amount: (1000 - Number(cash)).toFixed(2), ref: 'GC-SALE-001' }] : [])],
  });

interface Ask {
  requestId?: string;
  lines?: [number, number][];
  pays?: [number, string, string?][];
  reason?: string;
  who?: World['counter'];
  pin?: string;
  receiptId?: string;
  at?: Date;
}
const refund = (w: World, m: Made, o: Ask = {}) =>
  asOrg(w.orgId, (tx) =>
    recordRefund(tx, o.who ?? w.manager, {
      storeId: w.storeId, pairingId: w.pairingId, requestId: o.requestId ?? uuid(), receiptId: o.receiptId ?? m.receiptId,
      lines: (o.lines ?? [[0, 1]]).map(([i, qty]) => ({ receiptLineId: m.lines[i]!.id, qty })),
      payments: (o.pays ?? [[0, '250.00']]).map(([i, amount, ref]) => ({ paymentId: m.pays[i]!.id, amount, ...(ref ? { referenceNo: ref } : {}) })),
      reason: o.reason ?? 'Customer returned it', ...(o.pin ? { approval: { pin: o.pin } } : {}),
    }),
  );
const rows = (w: World) => sql<{ id: string; refund_seq: number; total: string; day_close_id: string | null; approved_by: string }[]>`
  select id, refund_seq, total::text, day_close_id, approved_by from pos_refunds where org_id = ${w.orgId} order by refund_seq`;
const refundLines = (w: World) => sql<{ receipt_line_id: string; qty: number; amount: string }[]>`select receipt_line_id, qty, amount::text from pos_refund_lines where org_id = ${w.orgId} order by id`;
const misses = async (w: World) => Number((await sql<{ n: number }[]>`select count(*)::int n from sign_in_attempts where org_id = ${w.orgId} and kind = 'miss'`)[0]!.n);

async function expectRefusal(p: Promise<unknown>, sentence: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toBe(sentence);
}
/** The senior bill: 2 pork (500.00), ONE senior on 1 unit (VAT 26.79 + 20% 44.64 = 71.43), net 428.57. */
const seniorBill = (w: World) =>
  made(w, { at: manila(D1, '12:00'), items: [{ item: w.menu.pork, qty: 2 }], heads: 2, discounts: [{ lineIndex: 0, kind: 'senior', qty: 1, dinerNo: 1 }], pay: [{ tenderId: w.cash, amount: '500.00' }] });

describe('T-534 S4 - what a line gives back', () => {
  it('1 of 3 on a bill with a 20% senior discount refunds the DISCOUNTED share, not the gross (pins DEF-590) [kills: the discount spread over nothing]', async () => {
    const w = await world();
    const m = await made(w, { at: manila(D1, '12:00'), items: [{ item: w.menu.pork, qty: 3 }], heads: 3, discounts: [{ lineIndex: 0, kind: 'senior', qty: 3, dinerNo: 1 }], pay: [{ tenderId: w.cash, amount: '1000.00' }] });
    const net = m.lines[0]!.net;
    expect(Number(net), 'fixture sanity: the senior discount took money off the line').toBeLessThan(750);
    expect(net).toBe('535.71'); // 3 x (250.00 - 26.79 VAT - 44.64 20%) = 3 x 178.57
    const r = await refund(w, m, { lines: [[0, 1]], pays: [[0, '178.57']] });
    expect(r.total).toBe('178.57'); // the line's net / 3, never the 250.00 the old design gave back
    expect(Number(r.total)).toBeLessThan(250);
    expect(await refundLines(w)).toEqual([{ receipt_line_id: m.lines[0]!.id, qty: 1, amount: '178.57' }]);
    // the gross figure is refused as a payment over the refund: the money going back must equal the lines
    await expectRefusal(refund(w, m, { pays: [[0, '250.00']] }), 'The money going back (₱250.00) must equal the refund total (₱178.57).');
  });

  it('the refund that brings a line to its sold quantity takes the EXACT remainder: 214.29 + 214.28 = the line net 428.57 [kills: every piece rounded]', async () => {
    const w = await world();
    const m = await seniorBill(w);
    expect(m.lines[0]!.net).toBe('428.57');
    const a = await refund(w, m, { pays: [[0, '214.29']] });
    const b = await refund(w, m, { pays: [[0, '214.28']] });
    expect([a.total, b.total]).toEqual(['214.29', '214.28']);
    expect((await refundLines(w)).map((l) => l.amount)).toEqual(['214.29', '214.28']);
    // nothing is left on the line, and it can never be refunded again
    await expectRefusal(refund(w, m, { pays: [[0, '0.01']] }), 'Only 0 of Pork belly can still be refunded.');
  });

  it('a second refund over the quantity is refused, whole; exactly what is left is allowed [kills: no quantity cap]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    await refund(w, m, { lines: [[0, 3]], pays: [[0, '750.00']] });
    await expectRefusal(refund(w, m, { lines: [[0, 2]], pays: [[0, '500.00']] }), 'Only 1 of Pork belly can still be refunded.');
    expect(await rows(w)).toHaveLength(1);
    await expect(refund(w, m, { lines: [[0, 1]], pays: [[0, '250.00']] })).resolves.toMatchObject({ wrote: true, total: '250.00' });
  });
});

describe('T-534 S4 - how the money goes back', () => {
  it('a refund over what a payment can give back is refused; change given is not refundable; two methods each hold their own cap [kills: no per-payment cap]', async () => {
    const w = await world();
    const m = await thousand(w, '300.00'); // cash 300 + GCash 700
    // 500 needs 500 back: cash can take only 300
    await expectRefusal(refund(w, m, { lines: [[0, 2]], pays: [[0, '400.00'], [1, '100.00', GC_REF]] }), 'Only ₱300.00 can still be refunded to Cash.');
    expect(await rows(w)).toHaveLength(0);
    await refund(w, m, { lines: [[0, 2]], pays: [[0, '300.00'], [1, '200.00', GC_REF]] });
    // cash is spent: the next 500 can come back by GCash alone (500 of its 700 is left)
    await expectRefusal(refund(w, m, { lines: [[0, 2]], pays: [[0, '100.00'], [1, '400.00', GC_REF]] }), 'Only ₱0.00 can still be refunded to Cash.');
    await expect(refund(w, m, { lines: [[0, 2]], pays: [[1, '500.00', GC_REF]] })).resolves.toMatchObject({ wrote: true });
    // change is not the till's money: a 1,500 tender for 1,000 gives back at most 1,000
    const big = await made(w, { at: manila(D1, '13:00'), items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00', pay: [{ tenderId: w.cash, amount: '1500.00' }] });
    await expectRefusal(refund(w, big, { lines: [[0, 4]], pays: [[0, '1000.01']] }), 'Only ₱1000.00 can still be refunded to Cash.'); // 1,500 tendered - 500 change = 1,000 kept
    await expect(refund(w, big, { lines: [[0, 4]], pays: [[0, '1000.00']] })).resolves.toMatchObject({ wrote: true });
    await expectRefusal(refund(w, big, { lines: [[0, 1]], pays: [[0, '250.00']] }), 'Only 0 of Pork belly can still be refunded.');
  });

  it('a wallet money-back row needs the reference of the money sent back; a cash row takes none; a payment used twice is refused', async () => {
    const w = await world();
    const m = await thousand(w, '300.00');
    await expectRefusal(refund(w, m, { lines: [[0, 1]], pays: [[1, '250.00']] }), 'The reference number must be 4 to 40 characters.');
    await expectRefusal(refund(w, m, { lines: [[0, 1]], pays: [[1, '250.00', 'ab']] }), 'The reference number must be 4 to 40 characters.');
    await expectRefusal(refund(w, m, { lines: [[0, 1]], pays: [[0, '100.00'], [0, '150.00']] }), 'Each payment can only be used once.');
    await expectRefusal(refund(w, m, { lines: [[0, 1], [0, 1]] }), 'Each item can only be picked once.');
    await expectRefusal(refund(w, m, { lines: [] }), 'Pick at least one item to refund.');
    expect(await rows(w)).toHaveLength(0);
    await refund(w, m, { lines: [[0, 1]], pays: [[1, '250.00', GC_REF]] });
    const [p] = await sql<{ reference_no: string | null; tender_id: string }[]>`select reference_no, tender_id from pos_refund_payments where org_id = ${w.orgId}`;
    expect(p).toMatchObject({ reference_no: GC_REF, tender_id: w.gcash });
    const [audit] = await auditsOf(w, 'pos.refund_recorded');
    expect(audit).toMatchObject({ actor_person_id: w.managerId, store_id: w.storeId });
    expect(JSON.stringify(audit!.after)).not.toContain(GC_REF);
  });

  it('the refund number runs per store from 1, formatted <store code>-R-<6 digits>; the list shows the refund and what is left', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const first = await refund(w, m, { lines: [[0, 1]], pays: [[0, '250.00']] });
    const second = await refund(w, m, { lines: [[0, 1]], pays: [[0, '250.00']] });
    const code = (await sql<{ code: string }[]>`select code from stores where id = ${w.storeId}`)[0]!.code;
    expect([first.refundNo, second.refundNo]).toEqual([`${code}-R-000001`, `${code}-R-000002`]);
    expect((await rows(w)).map((r) => r.refund_seq)).toEqual([1, 2]);
    const list = await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }));
    const r = list.receipts[0]!;
    expect(r).toMatchObject({ refundedTotal: '500.00' });
    expect(r.refunds.map((x) => x.refundNo)).toEqual([`${code}-R-000001`, `${code}-R-000002`]);
    expect(r.lines).toMatchObject([{ lineId: m.lines[0]!.id, qty: 4, left: 2, amounts: ['250.00', '500.00'] }]);
    expect(r.refundPayments).toMatchObject([{ paymentId: m.pays[0]!.id, kind: 'cash', left: '500.00' }]);
  });
});

describe('T-534 S4 - the Z, the cash count and the sales day', () => {
  it('expected cash drops by the cash refund: the X shows cash 750, GCash 0 of a 250 cash refund, "Refunds 250", and the receipt is untouched [kills: the Z ignoring refunds]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const before = await reading(w, AT);
    expect(tenderMap(before)).toEqual({ [w.cash]: '1000.00' });
    await refund(w, m, { lines: [[0, 1]], pays: [[0, '250.00']] });
    const x = await reading(w, AT);
    expect(tenderMap(x)).toEqual({ [w.cash]: '750.00' });
    expect(x.grossTotal).toBe('1000.00');
    expect((x as unknown as { refunds: unknown }).refunds).toEqual({ total: '250.00', cash: '250.00', count: 1 });
    expect(await sql`select tender_id, amount::text, change_given::text from pos_sales_receipt_payments where receipt_id = ${m.receiptId}`).toEqual([{ tender_id: w.cash, amount: '1000.00', change_given: '0.00' }]);
  });

  it('a refund after the receipt\'s own Z lands in the NEXT Z, and the first Z does not change [kills: refunds only read with their receipts]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const z1 = await close(w, AT, await pinOf(w, w.managerId));
    expect(tenderMap(z1.reading)).toEqual({ [w.cash]: '1000.00' });
    await refund(w, m, { lines: [[0, 1]], pays: [[0, '250.00']] }); // after the Z
    expect((await rows(w))[0]!.day_close_id).toBeNull();
    await made(w, { at: manila(D2, '12:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', pay: [{ tenderId: w.cash, amount: '500.00' }] });
    const z2 = await close(w, AT2, await pinOf(w, w.managerId));
    expect(tenderMap(z2.reading)).toEqual({ [w.cash]: '250.00' }); // 500 sold - 250 refunded
    expect(z2.reading.grossTotal).toBe('500.00');
    expect((z2.reading as unknown as { refunds: unknown }).refunds).toEqual({ total: '250.00', cash: '250.00', count: 1 });
    // the Z collected the refund once; a replay of Z1 still reads 1,000, a replay of Z2 still 250
    expect((await rows(w))[0]!.day_close_id).toBe(z2.dayCloseId);
    const again1 = await close(w, AT, await pinOf(w, w.managerId), { closeId: z1.dayCloseId });
    expect(again1.wrote).toBe(false);
    expect(tenderMap(again1.reading)).toEqual({ [w.cash]: '1000.00' });
    const again2 = await close(w, AT2, await pinOf(w, w.managerId), { closeId: z2.dayCloseId });
    expect(tenderMap(again2.reading)).toEqual({ [w.cash]: '250.00' });
    expect((again2.reading as unknown as { refunds: { total: string } }).refunds.total).toBe('250.00');
    // the frozen Z tender rows are the net figures
    const closeRows = await sql<{ amount: string }[]>`select amount::text from pos_day_close_tenders where day_close_id = ${z2.dayCloseId}`;
    expect(closeRows.map((c) => c.amount)).toEqual(['250.00']);
  });

  it('the sales day\'s refunds equal the Z\'s, cash and wallets are net of them, and the day verifies and posts balanced with Dr 4950 for the refund [kills: refunds: ZERO]', async () => {
    const w = await world();
    const m = await thousand(w, '600.00'); // cash 600 + GCash 400
    await refund(w, m, { lines: [[0, 2]], pays: [[0, '300.00'], [1, '200.00', GC_REF]] });
    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(tenderMap(z.reading)).toEqual({ [w.cash]: '300.00', [w.gcash]: '200.00' });
    const [day] = await salesDaysOf(w);
    expect(day).toMatchObject({ source: 'pos_receipts', total_sales: '1000.00', cash_collected: '300.00', online_collected: '200.00' });
    const refunds = (await sql<{ refunds: string }[]>`select refunds::text from sales_days where id = ${day!.id}`)[0]!.refunds;
    expect(refunds).toBe((z.reading as unknown as { refunds: { total: string } }).refunds.total);
    expect(refunds).toBe('500.00');
    const res = await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, day!.id));
    const lines = await journalLines(res.journalEntryId);
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0)).toBe(lines.reduce((a, l) => a + cents(l.credit), 0));
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['1110', '300.00', '0.00'],
      ['1140', '200.00', '0.00'],
      ['4150', '0.00', '1000.00'],
      ['4950', '500.00', '0.00'], // refunds are contra-revenue (T-375 W11); cash and the wallet above are NET of them
    ]);
  });
});

describe('T-534 S4 - where and who', () => {
  it('another store of the same org cannot refund this store\'s receipt: the receipt is looked up AT the tablet\'s own store (row 402) [kills: no store filter on the receipt]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    // store B gets its own live POS switch and a till, so its manager is a legitimate caller there
    await sql`insert into pos_stores (org_id, store_id, mode, live_from, changed_by) values (${w.orgId}, ${w.store2Id}, 'live', '2026-01-01', ${w.adminId})`;
    await sql`insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${w.orgId}, ${w.store2Id}, 1, ${w.pairingBId}, ${w.adminId})`;
    const err = await asOrg(w.orgId, (tx) =>
      recordRefund(tx, w.managerOther, {
        storeId: w.store2Id, pairingId: w.pairingBId, requestId: uuid(), receiptId: m.receiptId,
        lines: [{ receiptLineId: m.lines[0]!.id, qty: 1 }], payments: [{ paymentId: m.pays[0]!.id, amount: '250.00' }], reason: 'Customer returned it',
      }),
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe(goneSentence('that receipt'));
    expect(await rows(w)).toHaveLength(0);
  });

  it('a receipt that is not this store\'s, or does not exist, is refused as unknown (row 402); nothing is written', async () => {
    const w = await world();
    const other = await world();
    const foreign = await thousand(other, '1000.00');
    const m = await thousand(w, '1000.00');
    await expectRefusal(refund(w, m, { receiptId: foreign.receiptId }), goneSentence('that receipt'));
    await expectRefusal(refund(w, m, { receiptId: uuid() }), goneSentence('that receipt'));
    expect(await rows(w)).toHaveLength(0);
    expect(await rows(other)).toHaveLength(0);
  });

  it('without the right and with a wrong PIN it is refused, the miss COUNTS although the call rolled back, and nothing is written [kills: the PIN not checked]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    expect(await misses(w)).toBe(0);
    const err = await refund(w, m, { who: w.counter, pin: '999999' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(POS_APPROVAL_REFUSED);
    expect(await misses(w)).toBe(1);
    expect(await rows(w)).toHaveLength(0);
    await expectRefusal(refund(w, m, { who: w.counter }), CORRECTION_NEEDS_PIN); // no PIN at all: asked for, not a miss
    expect(await misses(w)).toBe(1);
  });

  it('a cashier with a manager\'s PIN records it, approved by that manager; a signed-in holder of the right approves it themselves', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const viaPin = await refund(w, m, { who: w.counter, pin: await pinOf(w, w.managerId) });
    const own = await refund(w, m, { who: w.manager, lines: [[0, 1]], pays: [[0, '250.00']] });
    expect((await rows(w)).map((r) => r.approved_by)).toEqual([w.managerId, w.managerId]);
    expect(viaPin.slip).toMatchObject({ approvedByName: 'Manny Manager', recordedByName: 'Cara Counter', receiptNo: expect.stringMatching(/-01-\d{6}$/) });
    expect(own.slip.lines).toEqual([{ name: 'Pork belly', qty: 1, amount: '250.00' }]);
  });
});

describe('T-534 S4 - idempotent on request_id, and written in the top-level transaction', () => {
  it('the same request_id twice is ONE refund with ONE number, the second says it wrote nothing and returns the same slip; other figures under the same id are refused [kills: no replay check]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const requestId = uuid();
    const first = await refund(w, m, { requestId });
    const second = await refund(w, m, { requestId });
    expect(first.wrote).toBe(true);
    expect(second).toMatchObject({ wrote: false, id: first.id, refundNo: first.refundNo, total: first.total });
    expect(second.slip).toEqual(first.slip);
    expect(await rows(w)).toHaveLength(1);
    expect(await refundLines(w)).toHaveLength(1);
    await expectRefusal(refund(w, m, { requestId, lines: [[0, 2]], pays: [[0, '500.00']] }), RECORDED_DIFFERENTLY);
    expect(await rows(w)).toHaveLength(1);
  });

  it('a replay needs no PIN: the retry of a saved refund answers from the stored rows even for a cashier with no PIN, before approval is asked again [kills: the replay check after the approval]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const requestId = uuid();
    const first = await refund(w, m, { requestId, who: w.counter, pin: await pinOf(w, w.managerId) });
    const retry = await refund(w, m, { requestId, who: w.counter }); // no PIN this time
    expect(retry).toMatchObject({ wrote: false, id: first.id });
    expect(await misses(w)).toBe(0);
  });

  it('two identical requests at the same moment are ONE refund: the second waits for the store lock, then finds the first [kills: no re-check after the lock]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const requestId = uuid();
    const both = await Promise.all([refund(w, m, { requestId }), refund(w, m, { requestId })]);
    expect(both.map((r) => r.wrote).sort()).toEqual([false, true]);
    expect(both[0]!.id).toBe(both[1]!.id);
    expect(await rows(w)).toHaveLength(1);
  });

  it('refund, lines and money-back rows are written in the TOP-LEVEL transaction: no savepoint in the domain function, and the database append guard accepts what it wrote [kills: a savepoint around the children]', async () => {
    const src = readFileSync(new URL('../../src/pos/refund.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // code only, comments out
    expect(src).not.toMatch(/savepoint/i);
    expect(src).not.toMatch(/\.transaction\(/);
    const w = await world();
    const m = await thousand(w, '1000.00');
    await refund(w, m, { lines: [[0, 4]], pays: [[0, '1000.00']] });
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_refund_lines where org_id = ${w.orgId}`)[0]!.n).toBe(1);
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_refund_payments where org_id = ${w.orgId}`)[0]!.n).toBe(1);
  });
});

describe('T-534 S4 - the December v1 bridge sends the day net of its refunds', () => {
  it('a Z with a 250.00 cash refund is sent to v1 as total 750.00 and cash 750.00, so v1\'s own methods-vs-total check holds [kills: the bridge keeping the gross]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    await refund(w, m, { lines: [[0, 1]], pays: [[0, '250.00']] });
    await close(w, AT, await pinOf(w, w.managerId));
    const f = fakeWriter();
    const res = await asOrg(w.orgId, (tx) => sendV1Bridge(tx, w.counter, { storeId: w.storeId, businessDates: [D1] }, { writer: f.writer }));
    expect(res.results).toEqual([{ businessDate: D1, status: 'sent' }]);
    const data = f.calls[0]!.data as { payments: { totalGross: number; byMethod: Record<string, number> } };
    expect(data.payments).toMatchObject({ totalGross: 750, byMethod: { cash: 750 } });
  });
});

describe('T-613 D1 - the refund cap follows an S3 tender correction', () => {
  const tenThousand = (w: World) => made(w, { at: manila(D1, '12:00'), items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00', pay: [{ tenderId: w.cash, amount: '1000.00' }] });
  const correct = (w: World, m: Made, amount = '300.00') =>
    asOrg(w.orgId, (tx) =>
      recordTenderCorrection(tx, w.manager, {
        storeId: w.storeId, pairingId: w.pairingId, requestId: uuid(), receiptId: m.receiptId, paymentId: m.pays[0]!.id, toTenderId: w.gcash, amount, referenceNo: 'GC-0001234', reason: 'Customer paid by GCash',
      }),
    );
  const refundBy = (w: World, m: Made, pays: { tenderId?: string; amount: string; ref?: string }[], qty = 4) =>
    asOrg(w.orgId, (tx) =>
      recordRefund(tx, w.manager, {
        storeId: w.storeId, pairingId: w.pairingId, requestId: uuid(), receiptId: m.receiptId, lines: [{ receiptLineId: m.lines[0]!.id, qty }],
        payments: pays.map((p) => ({ paymentId: m.pays[0]!.id, amount: p.amount, ...(p.tenderId ? { tenderId: p.tenderId } : {}), ...(p.ref ? { referenceNo: p.ref } : {}) })), reason: 'Customer returned it',
      }),
    );

  it('P1,000 cash with P300 corrected to GCash: cash can give back at most P700, GCash P300; the list says so; the two refunds net the Z to zero [kills: a cap that ignores corrections, a refund that cannot go to the corrected method]', async () => {
    const w = await world();
    const m = await tenThousand(w);
    await correct(w, m);
    await expectRefusal(refundBy(w, m, [{ amount: '1000.00' }]), 'Only ₱700.00 can still be refunded to Cash.');
    await expectRefusal(refundBy(w, m, [{ amount: '700.00' }, { tenderId: w.gcash, amount: '300.01', ref: 'GC-REFUND-9' }]), 'Only ₱300.00 can still be refunded to GCash.');
    const list = await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }));
    expect(list.receipts[0]!.refundPayments).toMatchObject([{ tenderId: w.cash, left: '700.00' }, { tenderId: w.gcash, left: '300.00' }]);
    await refundBy(w, m, [{ amount: '700.00' }, { tenderId: w.gcash, amount: '300.00', ref: 'GC-REFUND-9' }]);
    expect(await sql`select tender_id, amount::text from pos_refund_payments where org_id = ${w.orgId} order by amount desc`).toEqual([{ tender_id: w.cash, amount: '700.00' }, { tender_id: w.gcash, amount: '300.00' }]);
    const after = await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }));
    expect(after.receipts[0]!.refundPayments).toMatchObject([{ left: '0.00' }, { left: '0.00' }]);
    expect(tenderMap(await reading(w, AT))).toEqual({ [w.cash]: '0.00', [w.gcash]: '0.00' });
  });
  it('money already refunded by the paid row own method cannot also be moved off it by a correction: P1,000 cash, P500 refunded, correcting P600 is refused at correction time [kills: a correction cap that ignores refunds]', async () => {
    const w = await world();
    const m = await tenThousand(w);
    await refundBy(w, m, [{ amount: '500.00' }], 2);
    await expectRefusal(correct(w, m, '600.00'), 'Only ₱500.00 of this payment can still be moved to another method.');
    await correct(w, m, '500.00');
  });
  it('an omitted method and the paid row own method are one thing: naming both is a duplicate, and a replay with the other spelling is the same refund [kills: comparing raw input]', async () => {
    const w = await world();
    const m = await tenThousand(w);
    await expectRefusal(refundBy(w, m, [{ amount: '100.00' }, { tenderId: w.cash, amount: '150.00' }], 1), 'Each payment can only be used once.');
    const requestId = uuid();
    const send = (tenderId?: string) =>
      asOrg(w.orgId, (tx) =>
        recordRefund(tx, w.manager, {
          storeId: w.storeId, pairingId: w.pairingId, requestId, receiptId: m.receiptId, lines: [{ receiptLineId: m.lines[0]!.id, qty: 1 }],
          payments: [{ paymentId: m.pays[0]!.id, amount: '250.00', ...(tenderId ? { tenderId } : {}) }], reason: 'Customer returned it',
        }),
      );
    expect((await send()).wrote).toBe(true);
    expect((await send(w.cash)).wrote).toBe(false);
  });
  it('a method the receipt was neither paid nor corrected to is refused in words', async () => {
    const w = await world();
    const m = await tenThousand(w);
    await expectRefusal(refundBy(w, m, [{ tenderId: w.gcash, amount: '1000.00', ref: 'GC-REFUND-9' }]), 'The money can only go back by the way it was paid.');
  });
});

describe('T-613 D3 - a Z of only refunds is no longer "nothing to close"', () => {
  it('a refund of an earlier day with no new sales reaches the Z, which now CLOSES (T-614 S1: the refund is all excess, so it posts as its own entry and there is no sales day) instead of "no sales to close" or a refusal [kills: the receipt-count gate]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    await close(w, AT, await pinOf(w, w.managerId));
    await refund(w, m, { lines: [[0, 1]], pays: [[0, '250.00']] });
    expect(((await reading(w, AT2)) as unknown as { refunds: { count: number } }).refunds.count).toBe(1);
    const z = await close(w, AT2, await pinOf(w, w.managerId));
    expect(z.wrote).toBe(true);
    expect(z.salesDayId).toBeNull();
    expect((await sql<{ n: number }[]>`select count(*)::int n from journal_entries where org_id = ${w.orgId} and idempotency_key like 'pos_refund_excess:%'`)[0]!.n).toBe(1);
  });
});

describe('T-613 D4 - find a receipt of an earlier day by its number', () => {
  const find = (w: World, receiptNo: string, now: Date) => asOrg(w.orgId, (tx) => findSalesReceiptByNo(tx, w.counter, { storeId: w.storeId, receiptNo, now }));

  it('a receipt already in a Z is not in the list, is found by its number (store code optional, any case), in the list shape, and refunds through the same dialog data [kills: no lookup]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    const no = (await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }))).receipts[0]!.receiptNo;
    await close(w, AT, await pinOf(w, w.managerId));
    expect((await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }))).receipts).toHaveLength(0);
    const found = await find(w, no.toLowerCase(), manila(D2, '10:00'));
    expect(found.receipts).toHaveLength(1);
    expect(found.receipts[0]).toMatchObject({ receiptId: m.receiptId, receiptNo: no, canCorrect: false, lines: [{ left: 4 }], refundPayments: [{ left: '1000.00' }] });
    expect((await find(w, no.split('-').slice(-2).join('-'), manila(D2, '10:00'))).receipts).toHaveLength(1);
    const out = await refund(w, m, { receiptId: found.receipts[0]!.receiptId, lines: [[0, 1]], pays: [[0, '250.00']] });
    expect(out.wrote).toBe(true);
  });
  it('a wrong store code, a malformed number, an unknown number and a receipt older than 30 days answer an empty list [kills: a lookup with no age limit or no store-code check]', async () => {
    const w = await world();
    await thousand(w, '1000.00');
    const no = (await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }))).receipts[0]!.receiptNo;
    const [, till, seq] = no.split('-').slice(-3).length === 3 ? no.split('-').slice(-3) : ['', '', ''];
    const soon = manila(D2, '10:00');
    expect((await find(w, no, soon)).receipts).toHaveLength(1);
    expect((await find(w, `ZZZ-${till}-${seq}`, soon)).receipts).toHaveLength(0);
    expect((await find(w, 'hello', soon)).receipts).toHaveLength(0);
    expect((await find(w, `${till}-999999`, soon)).receipts).toHaveLength(0);
    expect((await find(w, no, new Date(manila(D1, '12:00').getTime() + 31 * 86_400_000))).receipts).toHaveLength(0);
  });
  it('T-614 S2: the window is the business rule pos.receipt_lookup_days: 5 loses a 10-day-old receipt, 60 finds a 45-day-old one, no row keeps 30 [kills: reading a constant instead of the rule]', async () => {
    const w = await world();
    await thousand(w, '1000.00');
    const no = (await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }))).receipts[0]!.receiptNo;
    const day = 86_400_000;
    const at = (days: number) => new Date(manila(D1, '12:00').getTime() + days * day);
    expect((await find(w, no, at(10))).receipts, 'default 30: 10 days old is found').toHaveLength(1);
    expect((await find(w, no, at(45))).receipts, 'default 30: 45 days old is not found').toHaveLength(0);
    await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${w.orgId}, 'pos.receipt_lookup_days', '5', '2000-01-01', ${w.managerId}, 'test')`;
    expect((await find(w, no, at(10))).receipts, 'rule 5: 10 days old is not found').toHaveLength(0);
    expect((await find(w, no, at(3))).receipts, 'rule 5: 3 days old is found').toHaveLength(1);
    await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${w.orgId}, 'pos.receipt_lookup_days', '60', '2000-01-02', ${w.managerId}, 'test')`;
    expect((await find(w, no, at(45))).receipts, 'rule 60: 45 days old is found').toHaveLength(1);
  });
});
