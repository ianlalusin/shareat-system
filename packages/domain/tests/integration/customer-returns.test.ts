import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-179 — customer returns. Sibling of T-170's `supplier-returns.test.ts`, pointing the other
 * way. Built on T-165's rewiring: a wholesale dispatch now really relieves stock, so a return has
 * something real to reverse.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, itemsRepo, transaction, tradeRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createCustomer,
  createItem,
  createTradeOrder,
  dispatchTradeOrder,
  receiveTradeOrder,
  setStoreSellability,
  recordCustomerReturn,
  voidCustomerReturn,
  customerReturnableQuantity,
  customerCreditBalance,
  applyCredit,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`cr-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('lipa');
  const otherStoreId = await mkStore('other');

  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const superAdminId = await mkPerson('Super', 'super_admin');
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staff', 'staff');

  const [locType] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLocation = async (sId: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId})
      returning id`;
    return row!.id;
  };
  const locationId = await mkLocation(storeId);
  const otherLocationId = await mkLocation(otherStoreId);
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${superAdminId})
    returning id`;
  const fileId = file!.id;
  const [cashAccount] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, custodian, instrument, gl_account_code, is_active)
    values (${orgId}, ${storeId}, 'Cash drawer', 'cashier', 'cash', '1110', true) returning id`;

  return {
    orgId, storeId, otherStoreId, locationId, otherLocationId, fileId, cashAccountId: cashAccount!.id,
    superAdmin: actor(orgId, superAdminId),
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
    manager2: actor(orgId, (await mkPerson('Manager2', 'manager'))),
    staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stock(f: Fixture, storeId: string, locationId: string, itemId: string, qty: string, unitCost = '90.0000'): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost, locationId }],
    }),
  );
}

async function mapSelf(f: Fixture, itemId: string): Promise<void> {
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
}

async function wholesaleItem(f: Fixture, name: string): Promise<string> {
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: uid('WS'), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  );
  return item.id;
}

async function buyer(f: Fixture): Promise<string> {
  const c = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
  return c.id;
}

/** A dispatched (not yet received-by-us — externals never get a receive step) sale, ready to return. */
async function aSale(f: Fixture, opts: { qty?: string; rate?: string; stockQty?: string; unitCost?: string } = {}) {
  const itemId = await wholesaleItem(f, 'Beef');
  await stock(f, f.storeId, f.locationId, itemId, opts.stockQty ?? '50', opts.unitCost ?? '90.0000');
  const customerId = await buyer(f);
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, {
      storeId: f.storeId, customerId, orderDate: '2026-01-10',
      lines: [{ itemId, quantity: opts.qty ?? '10', rate: opts.rate ?? '500' }],
    }),
  );
  const dispatched = await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  return { orderId: order.orderId, arChargeId: dispatched.chargeId!, customerId, itemId, lineId: lines[0]!.id };
}

async function balances(orgId: string): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgId} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('external return — §3, the full posting', () => {
  it('1. a full resaleable return: Dr 4950/Cr 1210, Dr 1310/Cr 5100, on-hand rises, trial balance ties', async () => {
    const f = await fixture('full');
    const s = await aSale(f, { qty: '10', rate: '500', stockQty: '50', unitCost: '90' });

    const before = await onHand(s.itemId, f.locationId);
    expect(before).toBe('40.000'); // 50 stocked - 10 sold

    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong item shipped.',
        lines: [{ tradeOrderLineId: s.lineId, quantity: '10' }], actor: f.manager,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.settlement).toBe('reduce_ar');

    const legs = await sql<{ code: string; debit: string; credit: string; party_id: string | null }[]>`
      select a.code, jl.debit::text, jl.credit::text, jl.party_id from journal_lines jl
      join accounts a on a.id = jl.account_id where jl.entry_id = ${res.journalEntryId} order by a.code`;
    expect(legs.find((l) => l.code === '4950')).toMatchObject({ debit: '5000.00' });
    expect(legs.find((l) => l.code === '1210')).toMatchObject({ credit: '5000.00', party_id: s.customerId });
    expect(legs.find((l) => l.code === '1310')).toMatchObject({ debit: '900.00' });
    expect(legs.find((l) => l.code === '5100')).toMatchObject({ credit: '900.00' });

    const after = await onHand(s.itemId, f.locationId);
    expect(after).toBe('50.000');

    const [tb] = await sql<{ total: string }[]>`
      select coalesce(sum(debit - credit), 0)::text as total from journal_lines jl
      join journal_entries je on je.id = jl.entry_id where je.org_id = ${f.orgId}`;
    expect(Number(tb!.total)).toBe(0);
  });

  it('2. ⭐ the cost reversed is the SALE\'s cost, not today\'s — a cheaper lot arrives between sale and return', async () => {
    const f = await fixture('costfixed');
    const s = await aSale(f, { qty: '5', rate: '500', stockQty: '20', unitCost: '90' });

    // A much cheaper lot arrives after the sale.
    await stock(f, f.storeId, f.locationId, s.itemId, '20', '10.0000');

    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-16', reason: 'Not needed.',
        lines: [{ tradeOrderLineId: s.lineId, quantity: '5' }], actor: f.manager,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const legs = await sql<{ code: string; debit: string }[]>`
      select a.code, jl.debit::text from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${res.journalEntryId} and a.code = '1310'`;
    // 5 kg at the ORIGINAL ₱90, never the ₱10 lot that arrived since.
    expect(legs[0]!.debit).toBe('450.00');
  });

  it('3. ⭐ a partial return across two consumed layers reverses in reverse order, and two partials sum to the full reversal', async () => {
    const f = await fixture('partial2layers');
    const itemId = await wholesaleItem(f, 'Chicken');
    await stock(f, f.storeId, f.locationId, itemId, '5', '100.0000');
    await stock(f, f.storeId, f.locationId, itemId, '5', '200.0000');
    const customerId = await buyer(f);
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId, quantity: '8', rate: '500' }] }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
    const lineId = lines[0]!.id;
    // Sale consumed 5@100 + 3@200 = 500+600 = 1100.

    const first = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: order.orderId, returnedOn: '2026-01-15', reason: 'Partial 1.', lines: [{ tradeOrderLineId: lineId, quantity: '2' }], actor: f.manager }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Reverse order of consumption — the LAST layer consumed (the 200 one) is first returned.
    const legs1 = await sql<{ code: string; debit: string }[]>`select a.code, jl.debit::text from journal_lines jl join accounts a on a.id=a.id and jl.account_id=a.id where jl.entry_id=${first.journalEntryId} and a.code='1310'`;
    expect(legs1[0]!.debit).toBe('400.00'); // 2 @ 200

    const second = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: order.orderId, returnedOn: '2026-01-15', reason: 'Partial 2.', lines: [{ tradeOrderLineId: lineId, quantity: '6' }], actor: f.manager }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const legs2 = await sql<{ code: string; debit: string }[]>`select jl.debit::text from journal_lines jl join accounts a on a.id=jl.account_id where jl.entry_id=${second.journalEntryId} and a.code='1310'`;
    // Remaining 1 @ 200 + 5 @ 100 = 200 + 500 = 700. First (400) + second (700) = 1100 = the full sale cost.
    expect(legs2[0]!.debit).toBe('700.00');
  });

  it('4. ⭐ returned goods reopen their original layers and are consumed BEFORE newer stock — the FIFO-position assertion', async () => {
    const f = await fixture('fifoposition');
    const s = await aSale(f, { qty: '3', rate: '500', stockQty: '10', unitCost: '90' });
    await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-11', reason: 'Return.', lines: [{ tradeOrderLineId: s.lineId, quantity: '3' }], actor: f.manager }),
    );
    // A NEW, more expensive lot arrives after the return.
    await stock(f, f.storeId, f.locationId, s.itemId, '10', '500.0000');
    // A fresh sale of 3 should draw from the REOPENED (old, cheap) layer first.
    const customer2 = await buyer(f);
    const order2 = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer2, orderDate: '2026-01-20', lines: [{ itemId: s.itemId, quantity: '3', rate: '999' }] }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order2.orderId }));
    const [cogsEntry] = await sql<{ id: string }[]>`
      select id from journal_entries where org_id = ${f.orgId} and source_type = 'trade_order_dispatch' and source_id = ${`${order2.orderId}:1310`}`;
    // ⚠️ A dispatch CREDITS 1310 (inventory leaving), never debits it.
    const legs = await sql<{ credit: string }[]>`
      select jl.credit::text from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${cogsEntry!.id} and a.code = '1310'`;
    // 3 kg at the OLD ₱90 (the reopened layer), never the ₱500 new lot.
    expect(legs[0]!.credit).toBe('270.00');
  });
});

describe('settlement — §3\'s table and invariant 9\'s split', () => {
  it('5a. a customer who still owes: return reduces 1210', async () => {
    const f = await fixture('unpaid');
    const s = await aSale(f, { qty: '2', rate: '500' });
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Return.', lines: [{ tradeOrderLineId: s.lineId, quantity: '1' }], actor: f.manager }),
    );
    expect(res.ok && res.settlement).toBe('reduce_ar');
  });

  it('5b. a paid customer: return credits 2140 with the customer as party', async () => {
    const f = await fixture('paid');
    const s = await aSale(f, { qty: '2', rate: '500' });
    // Pay the charge off in full first.
    await asOrg(f.orgId, (tx) => import('@shareat/domain').then((m) =>
      m.recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: s.customerId, collectionDate: '2026-01-12', amount: '1000.00',
        moneyAccountId: f.cashAccountId, allocations: [{ chargeId: s.arChargeId, amountApplied: '1000.00' }],
      }),
    ));
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Return.', lines: [{ tradeOrderLineId: s.lineId, quantity: '1' }], actor: f.manager }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.settlement).toBe('store_credit');
    const balance = await asOrg(f.orgId, (tx) => customerCreditBalance(tx, f.orgId, s.customerId));
    expect(balance).toBe('500.00');
  });

  it('5c. ⭐ a return exceeding the open balance splits reduce_ar + store_credit IN ONE ENTRY', async () => {
    const f = await fixture('split');
    const s = await aSale(f, { qty: '4', rate: '500' }); // 2000 total
    // Pay only half.
    await asOrg(f.orgId, (tx) => import('@shareat/domain').then((m) =>
      m.recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: s.customerId, collectionDate: '2026-01-12', amount: '1000.00',
        moneyAccountId: f.cashAccountId, allocations: [{ chargeId: s.arChargeId, amountApplied: '1000.00' }],
      }),
    ));
    // Return the whole thing — 2000. Only 1000 is still outstanding.
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Full return.', lines: [{ tradeOrderLineId: s.lineId, quantity: '4' }], actor: f.manager }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.settlement).toBe('mixed');
    const legs = await sql<{ code: string; credit: string }[]>`
      select a.code, jl.credit::text from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${res.journalEntryId} and a.code in ('1210','2140')`;
    expect(legs.find((l) => l.code === '1210')!.credit).toBe('1000.00');
    expect(legs.find((l) => l.code === '2140')!.credit).toBe('1000.00');
  });

  it('6. a cash refund credits cash and creates no 2140 balance', async () => {
    const f = await fixture('refund');
    const s = await aSale(f, { qty: '2', rate: '500' });
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Refund requested.',
        lines: [{ tradeOrderLineId: s.lineId, quantity: '1' }], refund: true, moneyAccountId: f.cashAccountId,
        actor: f.manager,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.settlement).toBe('cash_refund');
    const legs = await sql<{ code: string; credit: string }[]>`select a.code, jl.credit::text from journal_lines jl join accounts a on a.id=jl.account_id where jl.entry_id=${res.journalEntryId} and a.code='1110'`;
    expect(legs[0]!.credit).toBe('500.00');
    const balance = await asOrg(f.orgId, (tx) => customerCreditBalance(tx, f.orgId, s.customerId));
    expect(balance).toBe('0.00');
  });
});

describe('the credit is spendable — Ian\'s actual requirement', () => {
  it('7. redeeming credit against a later order posts Dr 2140/Cr 1210, and the balance returns to zero', async () => {
    const f = await fixture('spend');
    const s = await aSale(f, { qty: '2', rate: '500' });
    await asOrg(f.orgId, (tx) => import('@shareat/domain').then((m) =>
      m.recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: s.customerId, collectionDate: '2026-01-12', amount: '1000.00',
        moneyAccountId: f.cashAccountId, allocations: [{ chargeId: s.arChargeId, amountApplied: '1000.00' }],
      }),
    ));
    await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Return.', lines: [{ tradeOrderLineId: s.lineId, quantity: '2' }], actor: f.manager }),
    );
    const before = await asOrg(f.orgId, (tx) => customerCreditBalance(tx, f.orgId, s.customerId));
    expect(before).toBe('1000.00');

    const s2 = await aSale(f, { qty: '1', rate: '600', stockQty: '5' });
    // Reuse the SAME customer for the second order.
    await sql`update trade_orders set customer_id = ${s.customerId} where id = ${s2.orderId}`;
    await sql`update ar_charges set customer_id = ${s.customerId} where id = ${s2.arChargeId}`;

    const applied = await asOrg(f.orgId, (tx) =>
      applyCredit(tx, f.manager, { orgId: f.orgId, tradeOrderId: s2.orderId, amount: '600.00', collectionDate: '2026-01-20', moneyAccountId: f.cashAccountId }),
    );
    expect(applied.ok).toBe(true);

    const after = await asOrg(f.orgId, (tx) => customerCreditBalance(tx, f.orgId, s.customerId));
    expect(after).toBe('400.00');
  });

  it('8. redeeming more than the balance is refused', async () => {
    const f = await fixture('overspend');
    const s = await aSale(f, { qty: '1', rate: '500' });
    await expect(
      asOrg(f.orgId, (tx) => applyCredit(tx, f.manager, { orgId: f.orgId, tradeOrderId: s.orderId, amount: '999999.00', collectionDate: '2026-01-20', moneyAccountId: f.cashAccountId })),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('unsaleable goods — §5, two events', () => {
  it('9. an unsaleable return reopens the layer AND posts a 5300 wastage — two movements', async () => {
    const f = await fixture('unsellable');
    const s = await aSale(f, { qty: '3', rate: '500', stockQty: '10', unitCost: '90' });
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Damaged.',
        lines: [{ tradeOrderLineId: s.lineId, quantity: '3', saleable: false }], actor: f.manager,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const movements = await sql<{ kind: string; quantity: string }[]>`
      select kind, quantity::text from stock_movements
      where item_id = ${s.itemId} and source_type in ('customer_return', 'customer_return_unsellable') and source_id = ${res.returnId}
      order by created_at`;
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({ kind: 'usage', quantity: '3.000' });
    expect(movements[1]).toMatchObject({ kind: 'wastage', quantity: '-3.000' });

    const [wastage] = await sql<{ debit: string }[]>`
      select jl.debit::text from journal_lines jl join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id
      where je.org_id = ${f.orgId} and je.source_type = 'customer_return' and a.code = '5300'`;
    expect(Number(wastage!.debit)).toBe(270); // 3 @ 90
  });
});

describe('internal — §4, T-173 backwards', () => {
  async function transferAndReceive(f: Fixture, opts: { qty?: string; rate?: string; stockQty?: string; unitCost?: string } = {}) {
    const itemId = await wholesaleItem(f, 'Prepped');
    await stock(f, f.storeId, f.locationId, itemId, opts.stockQty ?? '20', opts.unitCost ?? '90.0000');
    await mapSelf(f, itemId);
    const customerId = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId })).then((c) => c.id);
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId, quantity: opts.qty ?? '10', rate: opts.rate ?? '100' }] }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-11' }));
    const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
    return { orderId: order.orderId, itemId, lineId: lines[0]!.id };
  }

  it('10. ⭐ an internal return posts the four-leg reverse transfer — no 4950, no 2140, no refund at all', async () => {
    const f = await fixture('internalreturn');
    const t = await transferAndReceive(f, { qty: '10', rate: '100' });

    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: t.orderId, returnedOn: '2026-01-15', reason: 'Overstocked.', lines: [{ tradeOrderLineId: t.lineId, quantity: '4' }], actor: f.manager }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.settlement).toBe('reverse_transfer');

    const legs = await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, jl.debit::text, jl.credit::text from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${res.journalEntryId}`;
    expect(legs.find((l) => l.code === '2150')).toMatchObject({ debit: '400.00' }); // 4 @ 100 (branch's own layer cost = the transfer rate it received at)
    expect(legs.find((l) => l.code === '1250')).toMatchObject({ credit: '400.00' });
    // ⛔ Asserted by absence — the tempting implementation treats every return the same way.
    expect(legs.filter((l) => ['4950', '2140', '1110', '1140'].includes(l.code))).toHaveLength(0);
  });

  it('11. ⛔ a store_credit settlement on an internal return is refused BY THE DATABASE', async () => {
    const f = await fixture('dbcheck');
    await expect(
      sql`insert into customer_returns (org_id, store_id, trade_order_id, customer_id, treatment, returned_on, reason, settlement, journal_entry_id, created_by)
          select ${f.orgId}, ${f.storeId}, id, customer_id, 'internal', '2026-01-01', 'x', 'store_credit', journal_entry_id, ${f.manager.personId}
          from trade_orders limit 1`,
    ).rejects.toThrow();
  });
});

describe('caps and refusals', () => {
  it('12. returning more than was sold on the line is refused', async () => {
    const f = await fixture('overreturn');
    const s = await aSale(f, { qty: '2', rate: '500' });
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'x', lines: [{ tradeOrderLineId: s.lineId, quantity: '3' }], actor: f.manager }),
    );
    expect(res.ok).toBe(false);
  });

  it('returnableQuantity caps at what was sold, minus what is already returned', async () => {
    const f = await fixture('capcheck');
    const s = await aSale(f, { qty: '5', rate: '500' });
    const cap1 = await asOrg(f.orgId, (tx) => customerReturnableQuantity(tx, f.orgId, s.lineId));
    expect(cap1).toBe('5.000');
    await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'x', lines: [{ tradeOrderLineId: s.lineId, quantity: '2' }], actor: f.manager }),
    );
    const cap2 = await asOrg(f.orgId, (tx) => customerReturnableQuantity(tx, f.orgId, s.lineId));
    expect(cap2).toBe('3.000');
  });
});

describe('void', () => {
  it('13. void reverses everything — balances return to prior values', async () => {
    const f = await fixture('voidfull');
    const s = await aSale(f, { qty: '3', rate: '500', stockQty: '20', unitCost: '90' });
    const before = await balances(f.orgId);
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong item.', lines: [{ tradeOrderLineId: s.lineId, quantity: '3' }], actor: f.manager }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const voided = await asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, res.returnId, 'Recorded in error.'));
    expect(voided.ok).toBe(true);

    const after = await balances(f.orgId);
    for (const code of ['4950', '1210', '1310', '5100']) {
      expect(Number(after[code] ?? 0)).toBeCloseTo(Number(before[code] ?? 0), 2);
    }
    const onHandAfter = await onHand(s.itemId, f.locationId);
    // 20 stocked − 3 sold = 17; the return gave 3 back (→20); voiding it takes the 3 back out again.
    expect(onHandAfter).toBe('17.000');
  });

  it('void after redemption is refused', async () => {
    const f = await fixture('voidafterspend');
    const s = await aSale(f, { qty: '2', rate: '500' });
    await asOrg(f.orgId, (tx) => import('@shareat/domain').then((m) =>
      m.recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: s.customerId, collectionDate: '2026-01-12', amount: '1000.00',
        moneyAccountId: f.cashAccountId, allocations: [{ chargeId: s.arChargeId, amountApplied: '1000.00' }],
      }),
    ));
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, { orgId: f.orgId, tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'x', lines: [{ tradeOrderLineId: s.lineId, quantity: '2' }], actor: f.manager }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const s2 = await aSale(f, { qty: '1', rate: '900', stockQty: '5' });
    await sql`update trade_orders set customer_id = ${s.customerId} where id = ${s2.orderId}`;
    await sql`update ar_charges set customer_id = ${s.customerId} where id = ${s2.arChargeId}`;
    await asOrg(f.orgId, (tx) => applyCredit(tx, f.manager, { orgId: f.orgId, tradeOrderId: s2.orderId, amount: '900.00', collectionDate: '2026-01-20', moneyAccountId: f.cashAccountId }));

    const voided = await asOrg(f.orgId, (tx) => voidCustomerReturn(tx, f.manager, res.returnId, 'Too late.'));
    expect(voided.ok).toBe(false);
  });
});
