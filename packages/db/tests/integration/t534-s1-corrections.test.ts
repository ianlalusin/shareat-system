/**
 * T-534 S1 (migration 0265) - pos_tender_corrections (a wrong payment method fixed before the Z). Raw SQL against the DATABASE (owner statements, so a
 * refusal is a CHECK, FK or trigger). The receipt is never touched: the last test pins that the frozen receipt and its payment are byte-for-byte as sold.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql as db } from './_fixtures/t401-menu';
import { baseWorld, correctionRow, dayClose, expectCode, ins, refusal, sale, sql, underReplica } from './_fixtures/t534-s1';

afterAll(async () => {
  await db.end({ timeout: 5 });
});

const upd = (id: string, set: Record<string, unknown>) => refusal(() => sql`update pos_tender_corrections set ${sql(set as never)} where id = ${id}`);

describe('T-534 S1 pos_tender_corrections', () => {
  it('a valid correction (300 of a 500 cash payment moved to the wallet) is accepted', async () => {
    const w = await baseWorld('k1');
    const s = await sale(w);
    const id = await ins('pos_tender_corrections', correctionRow(w, s));
    const [r] = await sql`select amount::text, day_close_id from pos_tender_corrections where id = ${id}`;
    expect(r).toMatchObject({ amount: '300.00', day_close_id: null });
  });

  it('CHECK to_tender <> the payment\'s own tender: moving cash to cash is refused (23514)', async () => {
    const w = await baseWorld('k2');
    const s = await sale(w);
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { to_tender_id: w.cash }))), '23514', 'pos_tender_corrections_tenders_differ_check');
  });

  it('from_tender_id must BE the payment\'s tender: naming the wallet as the payment\'s tender is refused (23503), so the check above cannot be dodged', async () => {
    const w = await baseWorld('k3');
    const s = await sale(w);
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { from_tender_id: w.wallet, to_tender_id: w.cash }))), '23503', 'pos_tender_corrections_from_tender_of_payment_fk');
  });

  it('the payment must belong to the receipt, and the receipt to the store (23503)', async () => {
    const w = await baseWorld('k4');
    const a = await sale(w);
    const b = await sale(w);
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, a, { payment_id: b.paymentId }))), '23503', 'pos_tender_corrections_payment_of_receipt_fk');
    const atStore2 = await sale(w, { store: 2 });
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, a, { store_id: w.store2Id }))), '23503', 'pos_tender_corrections_receipt_same_store_fk');
    await ins('pos_tender_corrections', correctionRow(w, atStore2));
  });

  it('CHECK amount > 0, reference_no 4..40 characters, a reason that is not blank (23514)', async () => {
    const w = await baseWorld('k5');
    const s = await sale(w);
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { amount: '0' }))), '23514', 'pos_tender_corrections_amount_check');
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { amount: '-5' }))), '23514', 'pos_tender_corrections_amount_check');
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { reference_no: 'abc' }))), '23514', 'pos_tender_corrections_reference_no_check');
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { reason: '  ' }))), '23514', 'pos_tender_corrections_reason_check');
    await ins('pos_tender_corrections', correctionRow(w, s, { reference_no: null }));
  });

  it('request_id is unique per org (23505); the same id in another org is allowed', async () => {
    const w = await baseWorld('k6');
    const w2 = await baseWorld('k6b');
    const s = await sale(w);
    const s2 = await sale(w2);
    const request_id = crypto.randomUUID();
    await ins('pos_tender_corrections', correctionRow(w, s, { request_id }));
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { request_id, amount: '10.00' }))), '23505', 'pos_tender_corrections_org_request_unique');
    await ins('pos_tender_corrections', correctionRow(w2, s2, { request_id }));
  });

  it('cross-org: another org\'s tender, approver or receipt is refused (23503)', async () => {
    const w = await baseWorld('k7');
    const w2 = await baseWorld('k7b');
    const s = await sale(w);
    const s2 = await sale(w2);
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { to_tender_id: w2.wallet }))), '23503', 'pos_tender_corrections_to_tender_id_same_org_fk');
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s, { approved_by: w2.manager }))), '23503', 'pos_tender_corrections_approved_by_same_org_fk');
    expectCode(await refusal(() => ins('pos_tender_corrections', correctionRow(w, s2))), '23503');
  });

  it('frozen: UPDATE of anything but day_close_id is refused (23001), also in replica mode; DELETE refused (23001)', async () => {
    const w = await baseWorld('k8');
    const s = await sale(w);
    const id = await ins('pos_tender_corrections', correctionRow(w, s));
    for (const set of [{ amount: '1.00' }, { reason: 'edited' }, { to_tender_id: w.cash }, { approved_by: w.personId }, { reference_no: 'OTHER12345' }]) {
      expectCode(await upd(id, set), '23001', 'frozen once written');
    }
    expectCode(await underReplica((tx) => tx`update pos_tender_corrections set amount = '1.00' where id = ${id}`), '23001', 'frozen once written');
    expectCode(await refusal(() => sql`delete from pos_tender_corrections where id = ${id}`), '23001', 'never deleted');
    expectCode(await underReplica((tx) => tx`delete from pos_tender_corrections where id = ${id}`), '23001', 'never deleted');
  });

  it('day_close_id is set once: NULL -> Z accepted, a later change refused (23001); a Z of another store is refused (23503)', async () => {
    const w = await baseWorld('k9');
    const s = await sale(w);
    const id = await ins('pos_tender_corrections', correctionRow(w, s));
    expectCode(await upd(id, { day_close_id: await dayClose(w, { store: 2 }) }), '23503', 'pos_tender_corrections_day_close_same_store_fk');
    const z = await dayClose(w);
    expect(await upd(id, { day_close_id: z })).toBeUndefined();
    expectCode(await upd(id, { day_close_id: await dayClose(w) }), '23001', 'set once');
  });

  it('a correction never edits the receipt: the receipt and its payment are unchanged and still frozen', async () => {
    const w = await baseWorld('k10');
    const s = await sale(w);
    const before = await sql`select to_jsonb(p) j from pos_sales_receipt_payments p where id = ${s.paymentId}`;
    await ins('pos_tender_corrections', correctionRow(w, s));
    const after = await sql`select to_jsonb(p) j from pos_sales_receipt_payments p where id = ${s.paymentId}`;
    expect(after).toEqual(before);
    expectCode(await refusal(() => sql`update pos_sales_receipt_payments set tender_id = ${w.wallet} where id = ${s.paymentId}`), '23001', 'frozen once written');
  });
});
