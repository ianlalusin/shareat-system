import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { arRepo, closeDb, interEntityRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import * as domain from '@shareat/domain';
import {
  createCustomer, createItem, createTradeOrder, recordCollection, recordCustomerReturn, suggestCollectionAllocation, writeOffCharge,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { testItemCode } from './_fixtures/item-code';
import { asOrg, buyer, dispatch, fixture, freezeClock, sayOf, thawClock, uid, type Fx } from './_fixtures/t433-b2b';

/**
 * T-494 (F26 / DEF-789, F27 / DEF-790) - a charge's open amount counts every credit already taken off it, and a credit and a collection lock the
 * charge in one order. docs/tasks/494-ar-credited-outstanding.md. Real Postgres (TEST_DATABASE_URL, `_test` guard); runs on any `_test` DB.
 *
 * Lipa = the commissary (org f), Padre Garcia (PG) = the franchise (org g). The shortage credit, the franchise reconcile job and PG's receipt are
 * the real S5 flow (t398-s5e-reconcile.test.ts), so the inter-entity case is the real one: charge 3100.00, PG counts 8 of 10 kg, credit 620.00.
 *
 * MUTANTS (each must turn a leg red): openItems ignores credits -> a, b, c, d; the credited sum counts one entry twice -> a (2480.00 shows 1860.00);
 * the credit path reads the outstanding before taking the charge lock -> e1, e2; the collection stops locking the charge -> e2.
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

const api = domain as unknown as {
  runInterEntityReconcile: (opts?: { orgId?: string; trigger?: 'cron' | 'manual' }) => Promise<{ hadFailures: boolean }>;
  postFranchiseShortageCredit: (tx: unknown, actor: unknown, input: { shipmentId: string }) => Promise<{ entryId: string; value: string; cost: string }>;
  receiveInterEntityShipment: (tx: unknown, actor: unknown, input: Record<string, unknown>) => Promise<unknown>;
};

async function asPerson<T>(orgId: string, personId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(dsql`select set_config('app.person_id', ${personId}, true)`);
    return fn(tx);
  });
}

interface World { f: Fx; g: Fx; customerId: string; supplierId: string }

async function world(hint: string): Promise<World> {
  const tag = uid(hint);
  const f = await fixture(sql, `${hint}f`);
  const g = await fixture(sql, `${hint}g`);
  await sql`update organizations set name = ${`Padre Garcia ${tag}`} where id = ${g.orgId}`;
  await sql`update organizations set name = ${`Lipa ${tag}`} where id = ${f.orgId}`;
  const [sup] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, status, created_by, counterparty_org_id) values (${g.orgId}, ${`Lipa ${tag}`}, 'active', ${g.manager.personId}, ${f.orgId}) returning id`;
  const customer = await asOrg(f.orgId, (tx) =>
    createCustomer(tx, f.admin, { name: `Padre Garcia ${tag}`, customerGroup: 'franchise', counterpartyOrgId: g.orgId, priceListId: null }),
  );
  return { f, g, customerId: customer.id, supplierId: sup!.id };
}

async function mkItem(x: Fx, name: string, sellableWholesale: boolean) {
  const item = await asOrg(x.orgId, (tx) =>
    createItem(tx, x.superAdmin, { code: testItemCode(), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale }),
  );
  return item.id;
}

async function stockAt(f: Fx, itemId: string, qty: string, unitCost: string) {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost, locationId: f.locationId }],
    }),
  );
}

interface Sale { orderId: string; orderLineId: string; chargeId: string; shipmentId: string; shipmentLineId: string; pgItemId: string }

/** Lipa dispatches 10 kg at 310.00 (charge 3100.00) to PG; PG counts `received` kg; the 06:30 job raises the franchise_credit row. */
async function sellAndShort(w: World, received = '8'): Promise<Sale> {
  const itemId = await mkItem(w.f, 'Pork belly', true);
  await stockAt(w.f, itemId, '10', '250.0000');
  const order = await asOrg(w.f.orgId, (tx) =>
    createTradeOrder(tx, w.f.manager, { storeId: w.f.storeId, customerId: w.customerId, orderDate: '2026-10-10', lines: [{ itemId, quantity: '10', rate: '310.00' }] }),
  );
  const r = await dispatch(w.f, w.f.manager, order.orderId);
  const ship = await asOrg(w.f.orgId, (tx) => interEntityRepo.findByTradeOrder(tx, w.f.orgId, order.orderId));
  const lines = await asOrg(w.f.orgId, (tx) => interEntityRepo.linesOf(tx, ship!.id));
  const orderLine = (await sql<{ id: string }[]>`select id from trade_order_lines where order_id = ${order.orderId}`)[0]!;
  const pgItemId = await mkItem(w.g, 'Pork belly (PG)', false);
  await sql`insert into supplier_items (org_id, supplier_id, item_id, created_by) values (${w.g.orgId}, ${w.supplierId}, ${pgItemId}, ${w.g.manager.personId})`;
  const s: Sale = { orderId: order.orderId, orderLineId: orderLine.id, chargeId: r.chargeId!, shipmentId: ship!.id, shipmentLineId: lines[0]!.id, pgItemId };
  await asPerson(w.g.orgId, w.g.manager.personId, (tx) =>
    api.receiveInterEntityShipment(tx, w.g.manager, {
      shipmentId: s.shipmentId, storeId: w.g.storeId, lines: [{ shipmentLineId: s.shipmentLineId, itemId: pgItemId, receivedQuantity: received }],
    }),
  );
  const res = await api.runInterEntityReconcile({ orgId: w.f.orgId, trigger: 'manual' });
  expect(res.hadFailures).toBe(false);
  return s;
}

const credit = (w: World, s: Sale, tx?: Tx) =>
  tx
    ? api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId })
    : asOrg(w.f.orgId, (t) => api.postFranchiseShortageCredit(t, w.f.manager, { shipmentId: s.shipmentId }));

const collectOn = (f: Fx, customerId: string, chargeId: string, applied: string, amount = applied, tx?: Tx) => {
  const run = (t: Tx) =>
    recordCollection(t, f.manager, {
      storeId: f.storeId, customerId, collectionDate: '2026-10-16', amount, moneyAccountId: f.drawerA,
      allocations: [{ chargeId, amountApplied: applied }],
    });
  return tx ? run(tx) : asOrg(f.orgId, run);
};

const openOf = (f: Fx, customerId: string) => asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, customerId, f.storeId));
const netOf = (f: Fx, chargeId: string) => asOrg(f.orgId, (tx) => arRepo.outstandingForCharge(tx, f.orgId, chargeId));

/** The customer's 1210 balance, in the journal, as text (a negative one is the defect). */
async function receivable(f: Fx, customerId: string): Promise<string> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${f.orgId} and jl.party_type = 'customer' and jl.party_id = ${customerId} and a.code = '1210'`;
  return r!.b;
}
async function storeCredit(f: Fx, customerId: string): Promise<string> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${f.orgId} and jl.party_type = 'customer' and jl.party_id = ${customerId} and a.code = '2140'`;
  return r!.b;
}
const n = (v: string) => Number(v);

// ================================================================================================ (a) inter-entity
describe('(a) inter-entity: a shortage credit takes 620.00 off the charge, and the open list and the collection cap both know it', () => {
  it('a1. charge 3100.00, PG received 8 of 10, credit 620.00 posted: openItems shows 2480.00 (credited 620.00), equal to outstandingForCharge; a 3100.00 allocation is refused and writes nothing', async () => {
    const w = await world('a1');
    const s = await sellAndShort(w);
    await credit(w, s);
    expect(await netOf(w.f, s.chargeId)).toBe('2480.00');
    const open = (await openOf(w.f, w.customerId)).find((o) => o.chargeId === s.chargeId)!;
    expect(open, 'the charge is still open').toBeDefined();
    expect(open.outstanding, 'openItems = total - collected - written off - credited').toBe('2480.00');
    expect(open.creditedAmount).toBe('620.00');
    expect(open.totalAmount).toBe('3100.00');
    expect(open.outstanding).toBe(await netOf(w.f, s.chargeId));

    const refused = await sayOf(collectOn(w.f, w.customerId, s.chargeId, '3100.00'));
    expect(refused.message).toContain('has only ₱2480.00 outstanding');
    expect(n(await receivable(w.f, w.customerId)), 'the refused collection wrote nothing: the receivable is still the 2480.00 the franchise owes').toBe(2480);
    expect(n(await storeCredit(w.f, w.customerId))).toBe(0);
  });

  it('a2. 2480.00 settles the charge to zero: it leaves the open list, 1210 for the customer is exactly 0 (never negative), no 2140 appears', async () => {
    const w = await world('a2');
    const s = await sellAndShort(w);
    await credit(w, s);
    await collectOn(w.f, w.customerId, s.chargeId, '2480.00');
    expect((await openOf(w.f, w.customerId)).find((o) => o.chargeId === s.chargeId), 'settled: gone from the open list').toBeUndefined();
    expect(await netOf(w.f, s.chargeId)).toBe('0.00');
    expect(n(await receivable(w.f, w.customerId))).toBe(0);
    expect(n(await storeCredit(w.f, w.customerId))).toBe(0);
  });

  it('a3. the franchise pays 3100.00 but only 2480.00 can be applied: 2480.00 clears 1210 and the 620.00 surplus is store credit (2140), the existing surplus rule; 1210 is never negative', async () => {
    const w = await world('a3');
    const s = await sellAndShort(w);
    await credit(w, s);
    await collectOn(w.f, w.customerId, s.chargeId, '2480.00', '3100.00');
    expect(n(await receivable(w.f, w.customerId))).toBe(0);
    expect(n(await storeCredit(w.f, w.customerId))).toBe(620);
  });
});

// ================================================================================================ (b) ordinary return
describe('(b) ordinary: a posted customer return takes its value off the charge', () => {
  async function externalSaleAndReturn(hint: string) {
    const w = await world(hint);
    const f = w.f;
    const ext = await buyer(sql, f);
    const itemId = await mkItem(f, 'Pork belly', true);
    await stockAt(f, itemId, '10', '250.0000');
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: ext, orderDate: '2026-10-10', lines: [{ itemId, quantity: '10', rate: '310.00' }] }),
    );
    const r = await dispatch(f, f.manager, order.orderId);
    const lineId = (await sql<{ id: string }[]>`select id from trade_order_lines where order_id = ${order.orderId}`)[0]!.id;
    const back = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { tradeOrderId: order.orderId, returnedOn: '2026-10-16', reason: 'Returned.', lines: [{ tradeOrderLineId: lineId, quantity: '2' }], actor: f.manager }),
    );
    expect(back.ok, JSON.stringify(back)).toBe(true);
    return { f, ext, chargeId: r.chargeId! };
  }

  it('b1. charge 3100.00, a 620.00 return: openItems shows 2480.00 and a 3100.00 allocation is refused', async () => {
    const { f, ext, chargeId } = await externalSaleAndReturn('b1');
    const open = (await openOf(f, ext)).find((o) => o.chargeId === chargeId)!;
    expect(open.outstanding).toBe('2480.00');
    expect(open.creditedAmount).toBe('620.00');
    expect(open.outstanding).toBe(await netOf(f, chargeId));
    const refused = await sayOf(collectOn(f, ext, chargeId, '3100.00'));
    expect(refused.message).toContain('has only ₱2480.00 outstanding');
    expect(n(await receivable(f, ext))).toBe(2480);
  });

  it('b2. 2480.00 settles it to zero, the charge leaves the open list, 1210 is exactly 0', async () => {
    const { f, ext, chargeId } = await externalSaleAndReturn('b2');
    await collectOn(f, ext, chargeId, '2480.00');
    expect((await openOf(f, ext)).find((o) => o.chargeId === chargeId)).toBeUndefined();
    expect(n(await receivable(f, ext))).toBe(0);
    expect(n(await storeCredit(f, ext))).toBe(0);
  });
});

// ================================================================================================ (c) write-off
describe('(c) write-off is capped at the net open amount, never the original total', () => {
  it('c1. after a 620.00 credit a write-off of the full 3100.00 is refused naming 2480.00 and writes nothing; 2480.00 is accepted and clears the charge; 1210 ends at exactly 0', async () => {
    const w = await world('c1');
    const s = await sellAndShort(w);
    await credit(w, s);
    const refused = await sayOf(asOrg(w.f.orgId, (tx) => writeOffCharge(tx, w.f.admin, { chargeId: s.chargeId, amount: '3100.00', reason: 'Uncollectible' })));
    expect(refused.message).toContain('only ₱2480.00 is outstanding');
    expect(n(await receivable(w.f, w.customerId))).toBe(2480);
    await asOrg(w.f.orgId, (tx) => writeOffCharge(tx, w.f.admin, { chargeId: s.chargeId, amount: '2480.00', reason: 'Uncollectible' }));
    expect((await openOf(w.f, w.customerId)).find((o) => o.chargeId === s.chargeId)).toBeUndefined();
    expect(n(await receivable(w.f, w.customerId)), 'the receivable is exactly cleared, never driven negative').toBe(0);
  });
});

// ================================================================================================ (d) every other consumer
describe('(d) every other reader of the open figure sees the net', () => {
  it('d1. ageing, the charge register and the auto-allocation suggestion all show / use 2480.00, not 3100.00', async () => {
    const w = await world('d1');
    const s = await sellAndShort(w);
    await credit(w, s);

    const aging = await asOrg(w.f.orgId, (tx) => arRepo.aging(tx, w.f.orgId, '2026-10-16', w.f.storeId));
    const row = aging.find((a) => a.customerId === w.customerId)!;
    const total = n(row.current) + n(row.d1to30) + n(row.d31to60) + n(row.d61to90) + n(row.d90plus);
    expect(total, 'ageing buckets add up to the net open amount').toBe(2480);

    const list = await asOrg(w.f.orgId, (tx) => arRepo.listChargesForCustomer(tx, w.f.orgId, w.customerId));
    const reg = list.find((r) => r.chargeId === s.chargeId)!;
    expect(reg.outstanding).toBe('2480.00');
    expect(reg.creditedAmount).toBe('620.00');
    expect(reg.outstanding).toBe(await netOf(w.f, s.chargeId));

    const open = await openOf(w.f, w.customerId);
    const plan = await asOrg(w.f.orgId, (tx) =>
      suggestCollectionAllocation(
        tx, w.f.manager, w.f.storeId, '3100.00', open,
        open.map((o) => ({ chargeId: o.chargeId, dueDate: o.dueDate, chargeDate: o.chargeDate, referenceNo: o.referenceNo })),
      ),
    );
    expect(plan.allocations).toEqual([{ chargeId: s.chargeId, amountApplied: '2480.00' }]);
    expect(plan.surplus).toBe('620.00');
  });
});

// ================================================================================================ (e) F27 the charge lock
describe('(e) F27: a collection and a shortage credit on one charge serialise on the charge lock', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('e1. the COLLECTION holds the charge (uncommitted) and the credit starts: the credit WAITS, re-reads, and 1210 ends at exactly 0 with the 620.00 as store credit', async () => {
    const w = await world('e1');
    const s = await sellAndShort(w);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let holderReady!: () => void;
    const ready = new Promise<void>((r) => { holderReady = r; });
    const holder = asOrg(w.f.orgId, async (tx) => {
      await collectOn(w.f, w.customerId, s.chargeId, '3100.00', '3100.00', tx);
      holderReady();
      await gate;
    });
    await ready;
    let creditDone = false;
    const racer = credit(w, s).then((r) => { creditDone = true; return r; });
    await sleep(1500);
    expect(creditDone, 'the credit must be waiting on the charge lock while the collection is uncommitted').toBe(false);
    release();
    await holder;
    await racer;
    expect(n(await receivable(w.f, w.customerId)), 'collected 3100 against a 3100 charge; the credit found nothing open on 1210').toBe(0);
    expect(n(await storeCredit(w.f, w.customerId)), 'the whole 620.00 went to store credit, none over-credited 1210').toBe(620);
  });

  it('e2. the CREDIT holds the charge (uncommitted) and a 3100.00 collection starts: the collection WAITS, then is refused at the net 2480.00; 1210 is never negative', async () => {
    const w = await world('e2');
    const s = await sellAndShort(w);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let holderReady!: () => void;
    const ready = new Promise<void>((r) => { holderReady = r; });
    const holder = asOrg(w.f.orgId, async (tx) => {
      await credit(w, s, tx);
      holderReady();
      await gate;
    });
    await ready;
    let collectDone = false;
    const racer = sayOf(collectOn(w.f, w.customerId, s.chargeId, '3100.00').finally(() => { collectDone = true; }));
    await sleep(1500);
    expect(collectDone, 'the collection must be waiting on the charge lock while the credit is uncommitted').toBe(false);
    release();
    await holder;
    const refused = await racer;
    expect(refused.message).toContain('has only ₱2480.00 outstanding');
    expect(n(await receivable(w.f, w.customerId))).toBe(2480);
    expect(n(await storeCredit(w.f, w.customerId))).toBe(0);
  });
});
