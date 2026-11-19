/**
 * T-534 S1 (migration 0265) - pos_refunds, pos_refund_lines, pos_refund_payments. Raw SQL against the DATABASE (owner statements; a refusal is a CHECK, FK or trigger).
 * The append guard is the 0240 xmin pattern: a refund's lines and payments are written only by the transaction that wrote the refund. So a test that adds children
 * writes the refund and them in ONE transaction (`refundTx`); each statement under test is an `attempt` (a savepoint), so a refusal does not end the transaction.
 * The refund row itself is always written at the top level of that transaction (a write inside a savepoint carries the sub-transaction's id, 0240 header).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql as db } from './_fixtures/t401-menu';
import {
  attempt, baseWorld, dayClose, expectCode, insQ, ins, refundLineRow, refundPaymentRow, refundRow, refusal, sale, sql, underReplica,
  type Q, type Sale, type W,
} from './_fixtures/t534-s1';

afterAll(async () => {
  await db.end({ timeout: 5 });
});

const upd = (table: string, id: string, set: Record<string, unknown>) => refusal(() => sql`update ${sql(table)} set ${sql(set as never)} where id = ${id}`);

/** Writes the refund and runs fn in the same transaction. */
async function refundTx<T>(w: W, s: Sale, fn: (r: { tx: Q; refundId: string }) => Promise<T>, o: Record<string, unknown> = {}): Promise<T> {
  return (await sql.begin(async (tx) => {
    const refundId = await insQ(tx, 'pos_refunds', refundRow(w, s, o));
    return fn({ tx, refundId });
  })) as T;
}
/** A committed refund with one line and one money-back row. */
async function fullRefund(w: W, s: Sale) {
  return refundTx(w, s, async ({ tx, refundId }) => {
    const lineId = await insQ(tx, 'pos_refund_lines', refundLineRow(w, s, refundId));
    const payId = await insQ(tx, 'pos_refund_payments', refundPaymentRow(w, s, refundId));
    return { refundId, lineId, payId };
  });
}

describe('T-534 S1 pos_refunds', () => {
  it('a refund with a line and a money-back row written in one transaction is accepted (partial: 1 of 4 portions, cash back)', async () => {
    const w = await baseWorld('r1');
    const s = await sale(w);
    const r = await fullRefund(w, s);
    const [row] = await sql`select total::text from pos_refunds where id = ${r.refundId}`;
    expect(row!.total).toBe('125.00');
  });

  it('CHECKs: total > 0, refund_seq > 0, reason not blank (23514)', async () => {
    const w = await baseWorld('r2');
    const s = await sale(w);
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { total: '0' }))), '23514', 'pos_refunds_total_check');
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { total: '-1' }))), '23514', 'pos_refunds_total_check');
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { refund_seq: 0 }))), '23514', 'pos_refunds_refund_seq_check');
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { reason: ' ' }))), '23514', 'pos_refunds_reason_check');
  });

  it('request_id is unique per org (23505); refund_seq is unique per store (23505), and a second store may reuse it', async () => {
    const w = await baseWorld('r3');
    const w2 = await baseWorld('r3b');
    const s = await sale(w);
    const s2 = await sale(w2);
    const request_id = crypto.randomUUID();
    await ins('pos_refunds', refundRow(w, s, { request_id, refund_seq: 7001 }));
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { request_id, refund_seq: 7002 }))), '23505', 'pos_refunds_org_request_unique');
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { refund_seq: 7001 }))), '23505', 'pos_refunds_store_refund_seq_unique');
    await ins('pos_refunds', refundRow(w2, s2, { request_id, refund_seq: 7001 }));
    const atStore2 = await sale(w, { store: 2 });
    await ins('pos_refunds', refundRow(w, atStore2, { refund_seq: 7001 }));
  });

  it('a refund is at the receipt\'s own store and org: a store, terminal or approver that does not match is refused (23503)', async () => {
    const w = await baseWorld('r4');
    const w2 = await baseWorld('r4b');
    const s = await sale(w);
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { store_id: w.store2Id, terminal_id: w.terminal2Id }))), '23503', 'pos_refunds_parent_receipt_same_store_fk');
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { terminal_id: w.terminal2Id }))), '23503', 'pos_refunds_terminal_same_store_fk');
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s, { approved_by: w2.manager }))), '23503', 'pos_refunds_approved_by_same_org_fk');
    const s2 = await sale(w2);
    expectCode(await refusal(() => ins('pos_refunds', refundRow(w, s2))), '23503');
  });

  it('frozen: UPDATE of anything but day_close_id is refused (23001), also in replica mode; DELETE refused (23001); day_close_id set once', async () => {
    const w = await baseWorld('r5');
    const s = await sale(w);
    const { refundId } = await fullRefund(w, s);
    for (const set of [{ total: '1.00' }, { reason: 'edited' }, { approved_by: w.personId }, { refund_seq: 99999 }]) expectCode(await upd('pos_refunds', refundId, set), '23001', 'frozen once written');
    expectCode(await underReplica((tx) => tx`update pos_refunds set total = '1.00' where id = ${refundId}`), '23001', 'frozen once written');
    expectCode(await refusal(() => sql`delete from pos_refunds where id = ${refundId}`), '23001', 'never deleted');
    expectCode(await underReplica((tx) => tx`delete from pos_refunds where id = ${refundId}`), '23001', 'never deleted');
    expectCode(await upd('pos_refunds', refundId, { day_close_id: await dayClose(w, { store: 2 }) }), '23503', 'pos_refunds_day_close_same_store_fk');
    expect(await upd('pos_refunds', refundId, { day_close_id: await dayClose(w) })).toBeUndefined();
    expectCode(await upd('pos_refunds', refundId, { day_close_id: await dayClose(w) }), '23001', 'set once');
  });

  describe('lines and money-back rows', () => {
    it('APPEND GUARD: a line or a money-back row inserted in a LATER transaction is refused (23001); in the same transaction it is accepted', async () => {
      const w = await baseWorld('r6');
      const s = await sale(w);
      const refundId = await ins('pos_refunds', refundRow(w, s));
      expectCode(await refusal(() => ins('pos_refund_lines', refundLineRow(w, s, refundId))), '23001', 'A refund is written once');
      expectCode(await refusal(() => ins('pos_refund_payments', refundPaymentRow(w, s, refundId))), '23001', 'A refund is written once');
      const same = await refundTx(w, s, async ({ tx, refundId: rid }) => [
        await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, s, rid))),
        await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, rid))),
      ]);
      expect(same).toEqual([undefined, undefined]);
      const [n] = await sql`select count(*)::int n from pos_refund_lines where refund_id = ${refundId}`;
      expect(n!.n).toBe(0);
    });

    it('APPEND GUARD also holds under replica mode (ENABLE ALWAYS)', async () => {
      const w = await baseWorld('r7');
      const s = await sale(w);
      const refundId = await ins('pos_refunds', refundRow(w, s));
      expectCode(await underReplica((tx) => insQ(tx, 'pos_refund_lines', refundLineRow(w, s, refundId))), '23001', 'A refund is written once');
    });

    it('append-only: UPDATE and DELETE of a line or a money-back row are refused (23001), also in replica mode', async () => {
      const w = await baseWorld('r8');
      const s = await sale(w);
      const r = await fullRefund(w, s);
      expectCode(await upd('pos_refund_lines', r.lineId, { qty: 2 }), '23001', 'append-only');
      expectCode(await upd('pos_refund_payments', r.payId, { amount: '1.00' }), '23001', 'append-only');
      expectCode(await refusal(() => sql`delete from pos_refund_lines where id = ${r.lineId}`), '23001', 'append-only');
      expectCode(await refusal(() => sql`delete from pos_refund_payments where id = ${r.payId}`), '23001', 'append-only');
      expectCode(await underReplica((tx) => tx`update pos_refund_lines set qty = 2 where id = ${r.lineId}`), '23001', 'append-only');
      expectCode(await underReplica((tx) => tx`delete from pos_refund_payments where id = ${r.payId}`), '23001', 'append-only');
    });

    it('CHECKs: qty > 0, amounts > 0, reference_no 4..40 characters (23514)', async () => {
      const w = await baseWorld('r9');
      const s = await sale(w);
      await refundTx(w, s, async ({ tx, refundId }) => {
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, s, refundId, { qty: 0 }))), '23514', 'pos_refund_lines_qty_check');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, s, refundId, { amount: '0' }))), '23514', 'pos_refund_lines_amount_check');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, refundId, { amount: '-1' }))), '23514', 'pos_refund_payments_amount_check');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, refundId, { reference_no: 'ab' }))), '23514', 'pos_refund_payments_reference_no_check');
        expect(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, refundId, { tender_id: w.cash, reference_no: 'GC1234567' })))).toBeUndefined();
      });
    });

    it('one row per line and one per original payment in a refund (23505)', async () => {
      const w = await baseWorld('r10');
      const s = await sale(w);
      await refundTx(w, s, async ({ tx, refundId }) => {
        await insQ(tx, 'pos_refund_lines', refundLineRow(w, s, refundId));
        await insQ(tx, 'pos_refund_payments', refundPaymentRow(w, s, refundId));
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, s, refundId, { qty: 2, amount: '250.00' }))), '23505', 'pos_refund_lines_refund_line_unique');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, refundId, { amount: '10.00' }))), '23505', 'pos_refund_payments_refund_payment_unique');
      });
    });

    it('the line and the payment must be the PARENT receipt\'s own (23503): another receipt\'s line, payment, or a receipt_id that is not the refund\'s', async () => {
      const w = await baseWorld('r11');
      const a = await sale(w);
      const b = await sale(w);
      await refundTx(w, a, async ({ tx, refundId }) => {
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, a, refundId, { receipt_line_id: b.lineId }))), '23503', 'pos_refund_lines_line_of_receipt_fk');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, a, refundId, { payment_id: b.paymentId }))), '23503', 'pos_refund_payments_payment_of_receipt_fk');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, b, refundId))), '23503', 'pos_refund_lines_refund_receipt_fk');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, b, refundId))), '23503', 'pos_refund_payments_refund_receipt_fk');
        expect(await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, a, refundId)))).toBeUndefined();
      });
    });

    it('the money goes back by the payment\'s own tender (ruling 2A): another tender on the row is refused (23503)', async () => {
      const w = await baseWorld('r12');
      const s = await sale(w);
      await refundTx(w, s, async ({ tx, refundId }) => {
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, refundId, { tender_id: w.wallet, reference_no: 'GC1234567' }))), '23503', 'pos_refund_payments_tender_of_payment_fk');
        expect(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, refundId)))).toBeUndefined();
      });
    });

    it('cross-org: a line or payment under another org\'s id is refused (23503)', async () => {
      const w = await baseWorld('r13');
      const w2 = await baseWorld('r13b');
      const s = await sale(w);
      await refundTx(w, s, async ({ tx, refundId }) => {
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_lines', refundLineRow(w, s, refundId, { org_id: w2.orgId }))), '23503');
        expectCode(await attempt(tx, (q) => insQ(q, 'pos_refund_payments', refundPaymentRow(w, s, refundId, { org_id: w2.orgId }))), '23503');
      });
    });
  });
});
