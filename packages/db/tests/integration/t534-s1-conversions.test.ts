/**
 * T-534 S1 (migration 0265) - pos_payment_conversions (Convert). docs/tasks/534-pos-convert-correction-refund.md. Raw SQL against the DATABASE.
 * Owner statements (privileges bypassed, so a refusal is the TRIGGER or CHECK); the app-role legs run as shareat_app inside a rolled-back transaction.
 * Each refusal sits beside a positive control (the same write, allowed by the one thing that differs). SQLSTATEs: 23514 check, 23505 unique, 23503 FK,
 * 23001 restrict_violation (frozen / once-only / void-after-close), 42501 privilege.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { APP_ROLE } from '../../src/rls/registry';
import { asApp, sql as db } from './_fixtures/t401-menu';
import { baseWorld, conversionRow, dayClose, expectCode, ins, insQ, refusal, sql, underReplica } from './_fixtures/t534-s1';

afterAll(async () => {
  await db.end({ timeout: 5 });
});

const upd = (id: string, set: Record<string, unknown>) => refusal(() => sql`update pos_payment_conversions set ${sql(set as never)} where id = ${id}`);
const voidSet = (w: { manager: string }) => ({ voided_by: w.manager, voided_at: new Date(), void_reason: 'Wrong amount typed' });

describe('T-534 S1 pos_payment_conversions', () => {
  it('a valid cash -> wallet conversion is accepted and reads back', async () => {
    const w = await baseWorld('c1');
    const id = await ins('pos_payment_conversions', conversionRow(w, { note: 'GCash cash-in' }));
    const [r] = await sql`select amount::text, day_close_id, voided_at from pos_payment_conversions where id = ${id}`;
    expect(r).toMatchObject({ amount: '500.00', day_close_id: null, voided_at: null });
  });

  it('CHECK from <> to: the same tender both ways is refused (23514)', async () => {
    const w = await baseWorld('c2');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { to_tender_id: w.cash }))), '23514', 'pos_payment_conversions_tenders_differ_check');
  });

  it('CHECK amount > 0: zero and negative are refused (23514), a centavo is accepted', async () => {
    const w = await baseWorld('c3');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { amount: '0' }))), '23514', 'pos_payment_conversions_amount_check');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { amount: '-1.00' }))), '23514', 'pos_payment_conversions_amount_check');
    await ins('pos_payment_conversions', conversionRow(w, { amount: '0.01' }));
  });

  it('CHECK void triple is all-or-none: one or two of the three is refused (23514), all three accepted', async () => {
    const w = await baseWorld('c4');
    const t = new Date();
    const bad = [{ voided_by: w.manager }, { voided_at: t }, { void_reason: 'x' }, { voided_by: w.manager, voided_at: t }, { voided_at: t, void_reason: 'x' }];
    for (const extra of bad) expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, extra))), '23514', 'pos_payment_conversions_void_shape_check');
    await ins('pos_payment_conversions', conversionRow(w, { voided_by: w.manager, voided_at: t, void_reason: 'x' }));
  });

  it('CHECK a blank note or void reason is refused (23514)', async () => {
    const w = await baseWorld('c5');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { note: '   ' }))), '23514', 'pos_payment_conversions_note_check');
    expectCode(
      await refusal(() => ins('pos_payment_conversions', conversionRow(w, { voided_by: w.manager, voided_at: new Date(), void_reason: '  ' }))),
      '23514',
      'pos_payment_conversions_void_reason_check',
    );
  });

  it('request_id is unique per org: a repeat is refused (23505); the same id in another org is a different row', async () => {
    const w = await baseWorld('c6');
    const w2 = await baseWorld('c6b');
    const request_id = crypto.randomUUID();
    await ins('pos_payment_conversions', conversionRow(w, { request_id }));
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { request_id }))), '23505', 'pos_payment_conversions_org_request_unique');
    await ins('pos_payment_conversions', conversionRow(w2, { request_id }));
  });

  it('cross-org: another org\'s tender, person, store or terminal is refused (23503); a Z of the other store too', async () => {
    const w = await baseWorld('c7');
    const w2 = await baseWorld('c7b');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { from_tender_id: w2.cash }))), '23503', 'pos_payment_conversions_from_tender_id_same_org_fk');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { to_tender_id: w2.wallet }))), '23503', 'pos_payment_conversions_to_tender_id_same_org_fk');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { recorded_by: w2.personId }))), '23503', 'pos_payment_conversions_recorded_by_same_org_fk');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { store_id: w2.storeId }))), '23503', 'pos_payment_conversions_store_id_same_org_fk');
    expectCode(await refusal(() => ins('pos_payment_conversions', conversionRow(w, { terminal_id: w.terminal2Id }))), '23503', 'pos_payment_conversions_terminal_same_store_fk');
    const otherStoreZ = await dayClose(w, { store: 2 });
    const id = await ins('pos_payment_conversions', conversionRow(w));
    expectCode(await upd(id, { day_close_id: otherStoreZ }), '23503', 'pos_payment_conversions_day_close_same_store_fk');
  });

  it('frozen: every column but day_close_id and the void triple refuses UPDATE (23001), also under replica mode; DELETE refused (23001)', async () => {
    const w = await baseWorld('c8');
    const id = await ins('pos_payment_conversions', conversionRow(w));
    for (const set of [{ amount: '1.00' }, { note: 'edited' }, { from_tender_id: w.wallet, to_tender_id: w.cash }, { request_id: crypto.randomUUID() }, { recorded_by: w.manager }, { store_id: w.store2Id }]) {
      expectCode(await upd(id, set), '23001', 'frozen once written');
    }
    expectCode(await underReplica((tx) => tx`update pos_payment_conversions set amount = '1.00' where id = ${id}`), '23001', 'frozen once written');
    expectCode(await refusal(() => sql`delete from pos_payment_conversions where id = ${id}`), '23001', 'never deleted');
    expectCode(await underReplica((tx) => tx`delete from pos_payment_conversions where id = ${id}`), '23001', 'never deleted');
    const [r] = await sql`select amount::text from pos_payment_conversions where id = ${id}`;
    expect(r!.amount).toBe('500.00');
  });

  it('day_close_id is set once: NULL -> Z accepted, any later change refused (23001)', async () => {
    const w = await baseWorld('c9');
    const z1 = await dayClose(w);
    const z2 = await dayClose(w);
    const id = await ins('pos_payment_conversions', conversionRow(w));
    expect(await upd(id, { day_close_id: z1 })).toBeUndefined();
    expectCode(await upd(id, { day_close_id: z2 }), '23001', 'set once');
    expectCode(await upd(id, { day_close_id: null }), '23001', 'set once');
    const [r] = await sql`select day_close_id from pos_payment_conversions where id = ${id}`;
    expect(r!.day_close_id).toBe(z1);
  });

  it('void: allowed once while the row has no Z; a second change to the triple is refused (23001); the row is unchanged', async () => {
    const w = await baseWorld('c10');
    const id = await ins('pos_payment_conversions', conversionRow(w));
    expect(await upd(id, voidSet(w))).toBeUndefined();
    expectCode(await upd(id, { void_reason: 'changed my mind' }), '23001', 'set once');
    expectCode(await upd(id, { voided_by: w.personId }), '23001', 'set once');
    expectCode(await upd(id, { voided_at: null, voided_by: null, void_reason: null }), '23001', 'set once');
    const [r] = await sql`select void_reason from pos_payment_conversions where id = ${id}`;
    expect(r!.void_reason).toBe('Wrong amount typed');
  });

  it('void after the Z is refused (23001), and so is a void in the same write that sets the Z; nothing changes', async () => {
    const w = await baseWorld('c11');
    const z = await dayClose(w);
    const closed = await ins('pos_payment_conversions', conversionRow(w));
    expect(await upd(closed, { day_close_id: z })).toBeUndefined();
    expectCode(await upd(closed, voidSet(w)), '23001', 'closed day');
    expectCode(await underReplica((tx) => tx`update pos_payment_conversions set voided_by = ${w.manager}, voided_at = now(), void_reason = 'late' where id = ${closed}`), '23001', 'closed day');
    const together = await ins('pos_payment_conversions', conversionRow(w));
    const z2 = await dayClose(w);
    expectCode(await upd(together, { day_close_id: z2, ...voidSet(w) }), '23001', 'closed day');
    const rows = await sql`select id, voided_at, day_close_id from pos_payment_conversions where id in ${sql([closed, together])}`;
    expect(rows.every((r) => r.voided_at === null)).toBe(true);
    expect(rows.find((r) => r.id === together)!.day_close_id).toBeNull();
  });

  it('a voided conversion may still be collected into a Z afterwards (day_close_id after the void is allowed)', async () => {
    const w = await baseWorld('c12');
    const id = await ins('pos_payment_conversions', conversionRow(w));
    expect(await upd(id, voidSet(w))).toBeUndefined();
    expect(await upd(id, { day_close_id: await dayClose(w) })).toBeUndefined();
  });

  it('writes inside a transaction as the app role: own org visible, another org invisible; UPDATE of amount and DELETE are privilege errors (42501)', async () => {
    const w = await baseWorld('c13');
    const w2 = await baseWorld('c13b');
    const id = await ins('pos_payment_conversions', conversionRow(w));
    const other = await ins('pos_payment_conversions', conversionRow(w2));
    const seen = await asApp(w.orgId, async (tx) => (await tx`select id from pos_payment_conversions where id in ${tx([id, other])}`).map((r) => r.id as string));
    expect(seen.value).toEqual([id]);
    const insertOk = await asApp(w.orgId, (tx) => insQ(tx, 'pos_payment_conversions', conversionRow(w)));
    expect(insertOk.err).toBeUndefined();
    const crossOrgInsert = await asApp(w.orgId, (tx) => insQ(tx, 'pos_payment_conversions', conversionRow(w2)));
    expectCode(crossOrgInsert.err, '42501');
    const amount = await asApp(w.orgId, (tx) => tx`update pos_payment_conversions set amount = '1.00' where id = ${id}`);
    expectCode(amount.err, '42501');
    const del = await asApp(w.orgId, (tx) => tx`delete from pos_payment_conversions where id = ${id}`);
    expectCode(del.err, '42501');
    const voidOk = await asApp(w.orgId, (tx) => tx`update pos_payment_conversions set voided_by = ${w.manager}, voided_at = now(), void_reason = 'typo' where id = ${id}`);
    expect(voidOk.err).toBeUndefined();
    expect(APP_ROLE).toBe('shareat_app');
  });

  it('the Z read: the partial index lists only conversions with no Z', async () => {
    const w = await baseWorld('c14');
    const open = await ins('pos_payment_conversions', conversionRow(w));
    const closed = await ins('pos_payment_conversions', conversionRow(w));
    await sql`update pos_payment_conversions set day_close_id = ${await dayClose(w)} where id = ${closed}`;
    const rows = await sql`select id from pos_payment_conversions where store_id = ${w.storeId} and day_close_id is null`;
    expect(rows.map((r) => r.id)).toEqual([open]);
    const [ix] = await sql`select indexdef from pg_indexes where indexname = 'pos_payment_conversions_open_idx'`;
    expect(ix!.indexdef).toContain('WHERE (day_close_id IS NULL)');
  });
});
