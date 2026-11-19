import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-534 S3 - wrong payment method: recordTenderCorrection, the Z that reads the corrected split, and the sales day it derives.
 * docs/tasks/534-pos-convert-correction-refund.md ("Wrong payment method", S3 tests). Real Postgres on a scratch "_test" database; the sales day is the standard one (T-531 fixture).
 *
 * The receipt NEVER changes; a correction is its own row, collected into the Z (day_close_id, once). Each case names the mutant it kills.
 */
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
import { listTodaysSalesReceipts, recordTenderCorrection } from '../../src/pos';
import { CORRECTION_CLOSED, CORRECTION_NEEDS_PIN } from '../../src/pos/tender-correction';
import { RECORDED_DIFFERENTLY } from '../../src/pos/shared';
import { D1, asOrg, auditsOf, close, closeAll, manila, pinOf, reading, salesDayTendersOf, salesDaysOf, sell, sql, tenderMap, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');
const GC_REF = 'GC-0001234';

/** One ₱1,000 bill (pork x4) paid in cash `tendered` (change = tendered - 1000). */
async function thousand(w: World, tendered = '1000.00') {
  const sale = await sell(w, { at: manila(D1, '12:00'), items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00', pay: [{ tenderId: w.cash, amount: tendered }] });
  const [pay] = await sql<{ id: string }[]>`select id from pos_sales_receipt_payments where receipt_id = ${sale.receiptId}`;
  return { receiptId: sale.receiptId, paymentId: pay!.id };
}

interface Fix { requestId?: string; amount?: string; to?: string; ref?: string | null; reason?: string; who?: World['counter']; pin?: string; receiptId?: string }
const correct = (w: World, r: { receiptId: string; paymentId: string }, o: Fix = {}) =>
  asOrg(w.orgId, (tx) =>
    recordTenderCorrection(tx, o.who ?? w.manager, {
      storeId: w.storeId, pairingId: w.pairingId, requestId: o.requestId ?? uuid(), receiptId: o.receiptId ?? r.receiptId, paymentId: r.paymentId, toTenderId: o.to ?? w.gcash,
      amount: o.amount ?? '300.00', referenceNo: o.ref === undefined ? GC_REF : o.ref, reason: o.reason ?? 'Customer paid by GCash', ...(o.pin ? { approval: { pin: o.pin } } : {}),
    }),
  );
const rows = (w: World) => sql<{ id: string; day_close_id: string | null; amount: string; approved_by: string; reference_no: string | null; from_tender_id: string; to_tender_id: string }[]>`
  select id, day_close_id, amount::text, approved_by, reference_no, from_tender_id, to_tender_id from pos_tender_corrections where org_id = ${w.orgId} order by recorded_at, id`;
const misses = async (w: World) => Number((await sql<{ n: number }[]>`select count(*)::int n from sign_in_attempts where org_id = ${w.orgId} and kind = 'miss'`)[0]!.n);

async function expectRefusal(p: Promise<unknown>, sentence: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toBe(sentence);
}

describe('T-534 S3 - the Z reads the corrected split; the receipt does not change', () => {
  it('moving 300 of a 1,000 cash payment to GCash: the Z says cash 700 / GCash 300, the receipt is untouched, the sales day takes the same split [kills: the Z ignoring corrections]', async () => {
    const w = await world();
    const r = await thousand(w);
    await correct(w, r);
    const x = await reading(w, AT);
    expect(tenderMap(x)).toEqual({ [w.cash]: '700.00', [w.gcash]: '300.00' });
    expect(x.grossTotal).toBe('1000.00');

    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(tenderMap(z.reading)).toEqual({ [w.cash]: '700.00', [w.gcash]: '300.00' });
    // the receipt's own payment row is the 1,000 cash, exactly as paid
    expect(await sql`select tender_id, amount::text, change_given::text from pos_sales_receipt_payments where receipt_id = ${r.receiptId}`).toEqual([{ tender_id: w.cash, amount: '1000.00', change_given: '0.00' }]);
    // the Z's own frozen tender rows and the sales day it derived use the corrected split
    const closeRows = await sql<{ tender_id: string; amount: string }[]>`select tender_id, amount::text from pos_day_close_tenders where day_close_id = ${z.dayCloseId}`;
    expect(Object.fromEntries(closeRows.map((c) => [c.tender_id, c.amount]))).toEqual({ [w.cash]: '700.00', [w.gcash]: '300.00' });
    const [day] = await salesDaysOf(w);
    expect(day).toMatchObject({ total_sales: '1000.00', cash_collected: '700.00', online_collected: '300.00' });
    expect((await salesDayTendersOf(day!.id)).map((t) => t.amount)).toEqual(['300.00']);
    // the Z collected the correction, once
    expect((await rows(w)).map((c) => c.day_close_id)).toEqual([z.dayCloseId]);
    // a replay of the Z (the history, a reprint) reads the same corrected figures
    const again = await close(w, AT, await pinOf(w, w.managerId), { closeId: z.dayCloseId });
    expect(again.wrote).toBe(false);
    expect(tenderMap(again.reading)).toEqual({ [w.cash]: '700.00', [w.gcash]: '300.00' });
  });

  it('moving the WHOLE payment leaves no empty cash row on the Z; the sum of the methods still equals the gross', async () => {
    const w = await world();
    const r = await thousand(w);
    await correct(w, r, { amount: '1000.00' });
    const x = await reading(w, AT);
    expect(tenderMap(x)).toEqual({ [w.gcash]: '1000.00' });
    expect(x.byTender.reduce((a, t) => a + Number(t.amount), 0)).toBe(1000);
  });

  it('the Receipts list shows the corrected method, says corrected, and offers what is still free to move', async () => {
    const w = await world();
    const r = await thousand(w);
    const before = await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }));
    expect(before.receipts[0]).toMatchObject({ tenders: 'Cash', corrected: false, canCorrect: true });
    expect(before.receipts[0]!.payments).toMatchObject([{ paymentId: r.paymentId, tenderId: w.cash, left: '1000.00' }]);
    await correct(w, r);
    const after = await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }));
    expect(after.receipts[0]).toMatchObject({ tenders: 'Cash + GCash', corrected: true, canCorrect: true });
    expect(after.receipts[0]!.payments).toMatchObject([{ left: '700.00' }]);
  });
});

describe('T-534 S3 - what may be moved', () => {
  it('more than is left on the payment is refused, whole; exactly what is left is allowed; change given is not movable [kills: no cap]', async () => {
    const w = await world();
    const r = await thousand(w, '1500.00'); // 500 change: the till kept 1,000
    await expectRefusal(correct(w, r, { amount: '1000.01' }), 'Only ₱1000.00 of this payment can still be moved to another method.');
    expect(await rows(w)).toHaveLength(0);
    await correct(w, r, { amount: '400.00' });
    await expectRefusal(correct(w, r, { amount: '600.01' }), 'Only ₱600.00 of this payment can still be moved to another method.');
    await expect(correct(w, r, { amount: '600.00' })).resolves.toMatchObject({ wrote: true });
    expect((await rows(w)).map((c) => c.amount)).toEqual(['400.00', '600.00']);
    await expectRefusal(correct(w, r, { amount: '0.01' }), 'Only ₱0.00 of this payment can still be moved to another method.');
  });

  it('after the Z it is refused with the closed-day sentence, and nothing is written [kills: no day-close check]', async () => {
    const w = await world();
    const r = await thousand(w);
    await close(w, AT, await pinOf(w, w.managerId));
    await expectRefusal(correct(w, r), CORRECTION_CLOSED);
    expect(CORRECTION_CLOSED).toBe('Already in a closed day. Refund it and ring it again.');
    expect(await rows(w)).toHaveLength(0);
  });

  it('a wallet needs a reference, a cash target does not; the same method as the payment, an unknown receipt and a missing reason are refused [kills: no reference check]', async () => {
    const w = await world();
    const r = await thousand(w);
    await expectRefusal(correct(w, r, { ref: null }), 'The reference number must be 4 to 40 characters.');
    await expectRefusal(correct(w, r, { ref: 'ab' }), 'The reference number must be 4 to 40 characters.');
    await expectRefusal(correct(w, r, { to: w.cash }), 'Pick a different payment method from the one this was paid with.');
    await expectRefusal(correct(w, r, { receiptId: uuid() }), goneSentence('that receipt'));
    await expectRefusal(correct(w, r, { reason: ' ' }), 'The reason must be 3 to 200 characters.');
    expect(await rows(w)).toHaveLength(0);
    await correct(w, r);
    expect((await rows(w))[0]).toMatchObject({ reference_no: GC_REF, from_tender_id: w.cash, to_tender_id: w.gcash });
    // wallet -> cash needs no reference: pay half by GCash on a second bill and move it back
    const s = await sell(w, { at: manila(D1, '13:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', pay: [{ tenderId: w.gcash, amount: '500.00', ref: 'GC-9999999' }] });
    const [p2] = await sql<{ id: string }[]>`select id from pos_sales_receipt_payments where receipt_id = ${s.receiptId}`;
    await expect(correct(w, { receiptId: s.receiptId, paymentId: p2!.id }, { to: w.cash, amount: '500.00', ref: null })).resolves.toMatchObject({ wrote: true });
  });
});

describe('T-534 S3 - who approves', () => {
  it('without the right and with a wrong PIN it is refused, the miss COUNTS although the call rolled back, and nothing is written [kills: the PIN not checked]', async () => {
    const w = await world();
    const r = await thousand(w);
    expect(await misses(w)).toBe(0);
    const err = await correct(w, r, { who: w.counter, pin: '999999' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(POS_APPROVAL_REFUSED);
    expect(await misses(w)).toBe(1);
    expect(await rows(w)).toHaveLength(0);
    // no PIN at all: asked for, and not a miss
    await expectRefusal(correct(w, r, { who: w.counter }), CORRECTION_NEEDS_PIN);
    expect(await misses(w)).toBe(1);
  });

  it('a cashier with a manager\'s PIN records it, approved by that manager; a signed-in holder of the right needs no PIN and approves it themselves', async () => {
    const w = await world();
    const r = await thousand(w);
    await correct(w, r, { who: w.counter, pin: await pinOf(w, w.managerId), amount: '100.00' });
    await correct(w, r, { who: w.manager, amount: '200.00' });
    expect((await rows(w)).map((c) => c.approved_by)).toEqual([w.managerId, w.managerId]);
    const [audit] = await auditsOf(w, 'pos.tender_corrected');
    expect(audit).toMatchObject({ actor_person_id: w.counterId, store_id: w.storeId });
    expect(JSON.stringify(audit!.after)).not.toContain(GC_REF);
  });
});

describe('T-534 S3 - idempotent on request_id', () => {
  it('the same request_id twice is ONE row, the second says it wrote nothing; the same id with other figures is refused [kills: no replay check]', async () => {
    const w = await world();
    const r = await thousand(w);
    const requestId = uuid();
    const first = await correct(w, r, { requestId });
    const second = await correct(w, r, { requestId });
    expect(first.wrote).toBe(true);
    expect(second).toEqual({ wrote: false, id: first.id });
    expect(await rows(w)).toHaveLength(1);
    await expectRefusal(correct(w, r, { requestId, amount: '301.00' }), RECORDED_DIFFERENTLY);
    expect(await rows(w)).toHaveLength(1);
  });
});

