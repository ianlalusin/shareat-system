import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { arRepo, closeDb, tradeRepo } from '@shareat/db';
import { voidTradeOrder, WHOLESALE_REVENUE_CODE } from '@shareat/domain';
import { api, asOrg, buyer, counts, dispatch, fixture, freezeClock, internalOrder, orderWorth, owed, payNow, sayOf, thawClock, TODAY, type Fx } from './_fixtures/t433-b2b';

/**
 * T-433 S1 (TESTER) - pay now at dispatch. docs/tasks/433-b2b-trade-order-gaps.md, cases 1-12.
 * Clock frozen at 2026-10-16. Each test names the mutant (M1..M12) that must turn it red.
 *
 * Booklet column (S2) is NOT used here.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });

beforeAll(() => freezeClock());
afterAll(async () => {
  thawClock();
  await closeDb();
  await sql.end({ timeout: 5 });
});

const R1 = (total: string) => `Paid now cannot be more than this order's ₱${total}.`;
const R2 = 'A branch transfer is not paid for; remove the payment.';
const R3 = "Pay into a money account at this order's store.";
const R4 = "This order is already dispatched; record the payment on the customer's page.";
const R5 = 'This charge has payments against it. Void the payment first.';

async function paidOrder(f: Fx, amount = '5000.00') {
  const customerId = await buyer(sql, f);
  const o = await orderWorth(sql, f, customerId, amount);
  return { ...o, customerId };
}
const positionOf = (f: Fx, customerId: string) =>
  asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, customerId)).then((p) => p.controlBalance);

describe('S1 pay now', () => {
  it('1. pay the full 5,000 cash: one charge, one collection allocated to it, balance 0.00 (M1: skip the allocation)', async () => {
    const f = await fixture(sql, 's1c1');
    const o = await paidOrder(f);
    const r = await dispatch(f, f.manager, o.orderId, payNow('5000.00', f.drawerA));
    const c = await counts(sql, f, o.customerId);
    expect(c).toMatchObject({ charges: 1, collections: 1, allocations: 1 });
    const [al] = await sql<{ amount_applied: string; ar_charge_id: string }[]>`
      select a.amount_applied::text, a.ar_charge_id from ar_collection_allocations a join ar_collections c on c.id = a.ar_collection_id
      where c.customer_id = ${o.customerId}`;
    expect(al).toMatchObject({ amount_applied: '5000.00', ar_charge_id: r.chargeId });
    expect(Number(await positionOf(f, o.customerId))).toBe(0);
    expect(await owed(sql, f, o.customerId)).toBe('0.00');
  });

  it('2. pay 2,000 of 5,000: allocation is 2,000 (not the total), outstanding 3,000.00 (M2: allocate total)', async () => {
    const f = await fixture(sql, 's1c2');
    const o = await paidOrder(f);
    const r = await dispatch(f, f.manager, o.orderId, payNow('2000.00', f.drawerA));
    const [al] = await sql<{ amount_applied: string }[]>`
      select a.amount_applied::text from ar_collection_allocations a join ar_collections c on c.id = a.ar_collection_id where c.customer_id = ${o.customerId}`;
    expect(al!.amount_applied).toBe('2000.00');
    expect(await asOrg(f.orgId, (tx) => arRepo.outstandingForCharge(tx, f.orgId, r.chargeId!))).toBe('3000.00');
    expect(await owed(sql, f, o.customerId)).toBe('3000.00');
  });

  it('3. a failing collection leaves NO charge and NO stock move (M3: collect in a separate transaction)', async () => {
    const f = await fixture(sql, 's1c3');
    const o = await paidOrder(f);
    // The e-wallet without proof makes recordCollection throw AFTER the charge was raised.
    await expect(dispatch(f, f.manager, o.orderId, payNow('2000.00', f.walletA))).rejects.toThrow(/needs proof of payment/);
    const c = await counts(sql, f, o.customerId);
    expect(c).toMatchObject({ charges: 0, collections: 0, allocations: 0, movements: 0 });
    const order = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(order!.status).not.toBe('dispatched');
    expect(await owed(sql, f, o.customerId)).toBe('0');
  });

  it('4. 5,000.01 against a 5,000 order is refused with exactly R1; nothing posted (M4: drop the <= total check)', async () => {
    const f = await fixture(sql, 's1c4');
    const o = await paidOrder(f);
    const r = await sayOf(dispatch(f, f.manager, o.orderId, payNow('5000.01', f.drawerA)));
    expect(r.said).toBe(R1('5000.00'));
    expect(await counts(sql, f, o.customerId)).toMatchObject({ charges: 0, collections: 0, movements: 0 });
  });

  it('5. an internal (branch) order with payNow is refused with exactly R2 (M5: ignore payNow on internal)', async () => {
    const f = await fixture(sql, 's1c5');
    const o = await internalOrder(sql, f);
    const r = await sayOf(dispatch(f, f.manager, o.orderId, payNow('100.00', f.drawerA)));
    expect(r.said).toBe(R2);
    const order = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(order!.status).not.toBe('dispatched');
    expect(await counts(sql, f, o.customerId)).toMatchObject({ collections: 0, movements: 0 });
  });

  it('6. GCash with no proof gets the existing proof sentence (M6: pass a dummy receiptFileId)', async () => {
    const f = await fixture(sql, 's1c6');
    const o = await paidOrder(f);
    const r = await sayOf(dispatch(f, f.manager, o.orderId, payNow('2000.00', f.walletA)));
    expect(r.message).toMatch(/online collection needs proof of payment/);
    expect(await counts(sql, f, o.customerId)).toMatchObject({ charges: 0, collections: 0 });
    // control: with a real proof file the same payment goes through
    await dispatch(f, f.manager, o.orderId, payNow('2000.00', f.walletA, { receiptFileId: f.fileId }));
    expect(await counts(sql, f, o.customerId)).toMatchObject({ charges: 1, collections: 1 });
  });

  it('7. re-dispatching a dispatched order with payNow is refused with exactly R4; still one collection (M7: early return ignores payNow)', async () => {
    const f = await fixture(sql, 's1c7');
    const o = await paidOrder(f);
    await dispatch(f, f.manager, o.orderId, payNow('2000.00', f.drawerA));
    const r = await sayOf(dispatch(f, f.manager, o.orderId, payNow('1000.00', f.drawerA)));
    expect(r.said).toBe(R4);
    expect((await counts(sql, f, o.customerId)).collections).toBe(1);
    // and an order dispatched WITHOUT payNow refuses a later payNow the same way
    const o2 = await paidOrder(f);
    await dispatch(f, f.manager, o2.orderId);
    expect((await sayOf(dispatch(f, f.manager, o2.orderId, payNow('1000.00', f.drawerA)))).said).toBe(R4);
    expect((await counts(sql, f, o2.customerId)).collections).toBe(0);
  });

  it('8. recordChargeWithCollection as an actor holding only record_ar_collection is refused for approve_buyer; nothing posted (M8: delete its authorize)', async () => {
    const f = await fixture(sql, 's1c8');
    const customerId = await buyer(sql, f);
    const input = {
      storeId: f.storeId, customerId, chargeDate: '2026-10-10', totalAmount: '1000.00',
      revenueAccountCode: WHOLESALE_REVENUE_CODE, payNow: { amount: '1000.00', moneyAccountId: f.drawerA },
    };
    const r = await sayOf(asOrg(f.orgId, (tx) => api.recordChargeWithCollection(tx, f.collector, input)));
    expect(r.message).toMatch(/may not 'approve_buyer'/);
    expect(await counts(sql, f, customerId)).toMatchObject({ charges: 0, collections: 0 });
    // control: the manager (who holds approve_buyer) can
    await asOrg(f.orgId, (tx) => api.recordChargeWithCollection(tx, f.manager, input));
    expect(await counts(sql, f, customerId)).toMatchObject({ charges: 1, collections: 1 });
  });

  it('9. the journal equals the two-screen posting: Dr 1210/Cr 4300 then Dr cash/Cr 1210, party = customer (M9: credit 4300 directly)', async () => {
    const f = await fixture(sql, 's1c9');
    const o = await paidOrder(f, '5000.00');
    await dispatch(f, f.manager, o.orderId, payNow('2000.00', f.drawerA));
    const legs = await sql<{ source_type: string; code: string; debit: string; credit: string; party_id: string | null }[]>`
      select je.source_type, a.code, jl.debit::text, jl.credit::text, jl.party_id
      from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.source_type in ('ar_charge', 'ar_collection')
        and (jl.party_id = ${o.customerId} or a.code in ('4300', '1110'))
      order by je.source_type, a.code`;
    const by = (st: string, code: string) => legs.find((l) => l.source_type === st && l.code === code);
    expect(by('ar_charge', '1210')).toMatchObject({ debit: '5000.00', party_id: o.customerId });
    expect(by('ar_charge', '4300')).toMatchObject({ credit: '5000.00' });
    expect(by('ar_collection', '1110')).toMatchObject({ debit: '2000.00' });
    expect(by('ar_collection', '1210')).toMatchObject({ credit: '2000.00', party_id: o.customerId });
    // revenue is credited ONCE (by the charge); a collection never touches it
    expect(legs.filter((l) => l.code === '4300')).toHaveLength(1);
  });

  it('10. order dated 2026-10-10 dispatched on 2026-10-16: charge dated 10-10, collection dated 10-16 (M10: collection uses orderDate)', async () => {
    const f = await fixture(sql, 's1c10');
    const o = await paidOrder(f);
    await dispatch(f, f.manager, o.orderId, payNow('2000.00', f.drawerA));
    const [ch] = await sql<{ d: string }[]>`select charge_date::text as d from ar_charges where customer_id = ${o.customerId}`;
    const [co] = await sql<{ d: string }[]>`select collection_date::text as d from ar_collections where customer_id = ${o.customerId}`;
    expect(ch!.d).toBe('2026-10-10');
    expect(co!.d).toBe(TODAY);
  });

  it("11. paying into the OTHER store's safe for an A order is refused with exactly R3 (M11: drop the store check)", async () => {
    const f = await fixture(sql, 's1c11');
    const o = await paidOrder(f);
    const r = await sayOf(dispatch(f, f.manager, o.orderId, payNow('2000.00', f.safeB)));
    expect(r.said).toBe(R3);
    expect(await counts(sql, f, o.customerId)).toMatchObject({ charges: 0, collections: 0, movements: 0 });
  });

  it('12. voiding a paid-now order is refused with exactly R5 and changes nothing; void the payment first, then it voids (M12: delete the allocation check in voidCharge)', async () => {
    const f = await fixture(sql, 's1c12');
    const o = await paidOrder(f);
    const r = await dispatch(f, f.manager, o.orderId, payNow('5000.00', f.drawerA));
    const before = await counts(sql, f, o.customerId);
    const refused = await sayOf(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: o.orderId, reason: 'wrong buyer' })));
    expect(refused.said).toBe(R5);
    expect(await counts(sql, f, o.customerId)).toEqual(before);
    const [ch] = await sql<{ status: string }[]>`select status from ar_charges where id = ${r.chargeId}`;
    const [co] = await sql<{ id: string; status: string }[]>`select id, status from ar_collections where customer_id = ${o.customerId}`;
    expect(ch!.status).toBe('posted');
    expect(co!.status).toBe('posted');
    // voidCharge itself refuses too (the guard lives in AR, not only in the trade caller)
    const direct = await sayOf(asOrg(f.orgId, (tx) => import('@shareat/domain').then((d) => d.voidCharge(tx, f.manager, { chargeId: r.chargeId!, reason: 'x' }))));
    expect(direct.said).toBe(R5);
    // void the payment, then the order voids
    await asOrg(f.orgId, async (tx) => (await import('@shareat/domain')).voidCollection(tx, f.manager, { collectionId: co!.id, reason: 'refunded' }));
    await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: o.orderId, reason: 'wrong buyer' }));
    const order = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(order!.status).toBe('void');
  });
});
