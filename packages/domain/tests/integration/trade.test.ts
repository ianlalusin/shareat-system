import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-132 — wholesale orders. `docs/tasks/132-wholesale-orders.md`.
 *
 * ⭐ The test that carries the design is *"editing the price list afterwards leaves the order
 * untouched"*. Everything else here is arithmetic and gating; that one is the reason
 * `trade_order_lines.rate` is a captured column rather than a join, and it is the difference
 * between an agreed price and a live quote.
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
  createSupplier,
  createItem,
  createPriceList,
  createTradeOrder,
  confirmTradeOrder,
  dispatchTradeOrder,
  receiveTradeOrder,
  branchPriceFor,
  setItemPricing,
  setCostBasisItem,
  recordInvoice,
  verifyInvoice,
  setPrice,
  setStoreSellability,
  voidTradeOrder,
  WHOLESALE_REVENUE_CODE,
  listFindings,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

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
  const code = uid(`ws-${hint}`);
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
  // T-148 made adding an item super-admin only, so the fixture needs one.
  const superAdminId = await mkPerson('Super', 'super_admin');
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staff', 'staff');

  // ⭐ T-165. Both dispatch (a real sale OR a real transfer) and receipt now move REAL stock —
  // every store needs somewhere for it to sit, and a proof photo to receive it in the first place.
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

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: staffEmployment!.id, personId: staffId, setBy: managerId,
  });

  return {
    orgId,
    storeId,
    otherStoreId,
    locationId,
    otherLocationId,
    fileId,
    superAdmin: actor(orgId, superAdminId),
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * ⭐ T-165. Stock a store for real via `receiveDelivery` — the same path a real receipt takes,
 * not a raw insert — so a dispatch has something real to relieve.
 */
async function stock(
  f: Fixture,
  storeId: string,
  locationId: string,
  itemId: string,
  qty: string,
  unitCost = '50.0000',
): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{
        lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty),
        conversionFactor: '1', unitCost, locationId,
      }],
    }),
  );
}

/**
 * ⭐ T-165/T-171. `receiveTradeOrder`'s `commissary_item_map` lookup is required, not optional —
 * every internal-transfer test uses ONE item at both ends, so the map is the identity.
 */
async function mapSelf(f: Fixture, itemId: string): Promise<void> {
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
}

/** An item this store sells wholesale. */
async function wholesaleItem(f: Fixture, name: string, storeId?: string): Promise<string> {
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, {
      code: testItemCode(),
      name: `${name} ${uid('n')}`,
      kind: 'raw_material',
      baseUnit: 'kg',
      sellableWholesale: storeId ? false : true,
    }),
  );
  if (storeId) {
    await asOrg(f.orgId, (tx) =>
      setStoreSellability(tx, f.superAdmin, { storeId, itemId: item.id, sellableWholesale: true }),
    );
  }
  return item.id;
}

async function buyer(
  f: Fixture,
  opts: { group?: 'wholesale' | 'franchise' | 'internal'; priceListId?: string; creditLimit?: string } = {},
): Promise<string> {
  const c = await asOrg(f.orgId, (tx) =>
    createCustomer(tx, f.admin, {
      name: `Buyer ${uid('b')}`,
      customerGroup: opts.group ?? 'wholesale',
      priceListId: opts.priceListId ?? null,
      ...(opts.group === 'internal' ? { counterpartyStoreId: f.otherStoreId } : {}),
    }),
  );
  if (opts.creditLimit !== undefined) {
    await sql`update customers set credit_limit = ${opts.creditLimit} where id = ${c.id}`;
  }
  return c.id;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// The captured rate — the test the design exists for
// =========================================================================================

describe('the rate is captured, not live-joined', () => {
  it('⭐ editing the price list afterwards leaves an existing order untouched', async () => {
    const f = await fixture('captured');
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));
    const itemId = await wholesaleItem(f, 'Beef premium');
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, { priceListId: list.id, itemId, rate: '450.00', unit: 'kg' }),
    );
    const customerId = await buyer(f, { priceListId: list.id });

    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId,
        customerId,
        orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '10' }],
      }),
    );
    expect(order.totalAmount).toBe('4500.00');

    // The price list moves. The order must not.
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, { priceListId: list.id, itemId, rate: '999.00', unit: 'kg' }),
    );

    const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.rate)).toBe(450);
    const reread = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, order.orderId));
    expect(reread!.totalAmount).toBe('4500.00');
  });

  it('an item the customer’s price list does not quote is refused, and says so', async () => {
    const f = await fixture('unquoted');
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));
    const itemId = await wholesaleItem(f, 'Unquoted');
    const customerId = await buyer(f, { priceListId: list.id });
    await expect(
      asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId, quantity: '1' }],
        }),
      ),
    ).rejects.toThrow(/does not quote it/);
  });

  it('a stated rate overrides the price list, and is what gets captured', async () => {
    const f = await fixture('override');
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));
    const itemId = await wholesaleItem(f, 'Negotiated');
    await asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId, rate: '100.00' }));
    const customerId = await buyer(f, { priceListId: list.id });
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '2', rate: '80.00' }],
      }),
    );
    expect(order.totalAmount).toBe('160.00');
  });
});

// =========================================================================================
// What may go on a wholesale line
// =========================================================================================

describe('what may be sold wholesale, and to whom', () => {
  it('⛔ a retail-only item — the bento box — is refused', async () => {
    const f = await fixture('bento');
    const bento = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Bento ${uid('n')}`, kind: 'retail', baseUnit: 'pcs',
        sellableRetail: true, sellableWholesale: false,
      }),
    );
    const customerId = await buyer(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId, customerId, orderDate: '2026-01-10',
          lines: [{ itemId: bento.id, quantity: '1', rate: '250' }],
        }),
      ),
    ).rejects.toThrow(/does not sell wholesale/);
  });

  it('⭐ the bulgogi case from the selling side — sellable at ONE store only', async () => {
    const f = await fixture('bulgogi');
    // Org default says no; this store says yes.
    const itemId = await wholesaleItem(f, 'Bulgogi sauce', f.storeId);
    const customerId = await buyer(f);

    // Accepted at the store that makes it.
    const ok = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '5', rate: '120' }],
      }),
    );
    expect(ok.totalAmount).toBe('600.00');

    // Refused at the store that merely buys it in.
    await expect(
      asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.otherStoreId, customerId, orderDate: '2026-01-10',
          lines: [{ itemId, quantity: '5', rate: '120' }],
        }),
      ),
    ).rejects.toThrow(/does not sell wholesale/);
  });

  // ⭐ T-132 REFUSED an internal counterparty here and named T-133 in the message. T-133 is what
  // makes it work, so the refusal is gone and this test now pins the opposite. Kept rather than
  // deleted: the sale path and the transfer path share ONE function, and the thing worth proving
  // is that they diverge on the derived treatment and nowhere else.
  it('⭐ an internal counterparty is ACCEPTED now, and takes the transfer treatment', async () => {
    const f = await fixture('internal');
    const itemId = await wholesaleItem(f, 'Transfer stock');
    await stock(f, f.storeId, f.locationId, itemId, '5');
    const customerId = await buyer(f, { group: 'internal' });
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '1', rate: '10' }],
      }),
    );
    const result = await asOrg(f.orgId, (tx) =>
      dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }),
    );
    expect(result.treatment).toBe('internal');
    expect(result.chargeId).toBeNull();
  });

  it('an order whose stated total disagrees with its lines is refused', async () => {
    const f = await fixture('total');
    const itemId = await wholesaleItem(f, 'Anything');
    const customerId = await buyer(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId, customerId, orderDate: '2026-01-10',
          lines: [{ itemId, quantity: '2', rate: '50' }],
          totalAmount: '150.00',
        }),
      ),
    ).rejects.toThrow(/One of the two is wrong/);
  });

  it('an order with no lines is refused — that is the lump sum this replaces', async () => {
    const f = await fixture('empty');
    const customerId = await buyer(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [],
        }),
      ),
    ).rejects.toThrow(/no lines/);
  });
});

// =========================================================================================
// Dispatch — the billing event
// =========================================================================================

describe('dispatch is the billing event', () => {
  async function anOrder(f: Fixture, opts: { creditLimit?: string } = {}) {
    const itemId = await wholesaleItem(f, 'Beef');
    await stock(f, f.storeId, f.locationId, itemId, '20');
    const customerId = await buyer(f, opts.creditLimit !== undefined ? { creditLimit: opts.creditLimit } : {});
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '4', rate: '250' }],
      }),
    );
    return { ...order, customerId, itemId };
  }

  it('⭐ posts a balanced entry to 1210 / 4300, with the customer as party', async () => {
    const f = await fixture('post');
    const o = await anOrder(f);
    await asOrg(f.orgId, (tx) => confirmTradeOrder(tx, f.manager, { orderId: o.orderId }));
    const result = await asOrg(f.orgId, (tx) =>
      dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }),
    );

    const legs = await sql<{ code: string; debit: string; credit: string; party_id: string | null }[]>`
      select a.code, jl.debit::text, jl.credit::text, jl.party_id
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId}
      order by a.code`;
    expect(legs).toHaveLength(2);
    expect(legs[0]!.code).toBe('1210');
    expect(Number(legs[0]!.debit)).toBe(1000);
    expect(legs[0]!.party_id).toBe(o.customerId);
    expect(legs[1]!.code).toBe(WHOLESALE_REVENUE_CODE);
    expect(Number(legs[1]!.credit)).toBe(1000);

    // ⭐ T-165/DEF-125. A SECOND entry, its own document: 4 kg at ₱50 leaves 1310 into 5100 (the
    // 'food' catch-all — no per-item COGS category exists yet, T-165's own header names why).
    const cogs = await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, jl.debit::text, jl.credit::text
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.source_type = 'trade_order_dispatch' and je.source_id = ${`${o.orderId}:1310`}
      order by a.code`;
    expect(cogs).toHaveLength(2);
    expect(cogs[0]!.code).toBe('1310');
    expect(Number(cogs[0]!.credit)).toBe(200);
    expect(cogs[1]!.code).toBe('5100');
    expect(Number(cogs[1]!.debit)).toBe(200);

    const reread = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(reread!.status).toBe('dispatched');
    expect(reread!.arChargeId).toBe(result.chargeId);
  });

  it('dispatching twice posts once', async () => {
    const f = await fixture('idem');
    const o = await anOrder(f);
    const first = await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    const second = await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    expect(second.chargeId).toBe(first.chargeId);
    expect(second.entryId).toBe(first.entryId);

    const [charges] = await sql<{ count: string }[]>`
      select count(*)::text from ar_charges where org_id = ${f.orgId} and customer_id = ${o.customerId}`;
    expect(charges!.count).toBe('1');
  });

  it('void reverses the receivable rather than deleting it', async () => {
    const f = await fixture('void');
    const o = await anOrder(f);
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    const { reversedEntryId } = await asOrg(f.orgId, (tx) =>
      voidTradeOrder(tx, f.admin, { orderId: o.orderId, reason: 'Buyer cancelled before pickup.' }),
    );
    expect(reversedEntryId).not.toBeNull();

    const [position] = await sql<{ balance: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as balance
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and a.code = '1210' and jl.party_id = ${o.customerId}
        and je.status <> 'draft'`;
    expect(Number(position!.balance)).toBe(0);

    const reread = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(reread!.status).toBe('void');
  });

  it('a void order cannot be voided again', async () => {
    const f = await fixture('revoid');
    const o = await anOrder(f);
    await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: o.orderId, reason: 'Mistake.' }));
    await expect(
      asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: o.orderId, reason: 'Again.' })),
    ).rejects.toThrow(/already void/);
  });
});

// =========================================================================================
// The credit gate — one gate, at dispatch
// =========================================================================================

describe('the credit limit', () => {
  async function orderWorth(f: Fixture, customerId: string, amount: string) {
    const itemId = await wholesaleItem(f, 'Credit stock');
    await stock(f, f.storeId, f.locationId, itemId, '5');
    return asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '1', rate: amount }],
      }),
    );
  }

  it('⛔ a breach with no reason given is refused, and the message shows the arithmetic', async () => {
    const f = await fixture('breach');
    const customerId = await buyer(f, { creditLimit: '500.00' });
    const o = await orderWorth(f, customerId, '900.00');
    await expect(
      asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId })),
    ).rejects.toThrow(/limit of ₱500.00/);
  });

  it('⚠️ staff cannot dispatch at all, so the credit gate never even runs for them', async () => {
    // Worth pinning: `approve_buyer` is manager+, and EVERY role that clears it also holds
    // `override_credit_limit`. So the limit is not a wall between ranks — it is a demand for a
    // recorded reason. Same shape as write-off, where Ian chose identity over rank.
    const f = await fixture('staffgate');
    const customerId = await buyer(f, { creditLimit: '500.00' });
    const o = await orderWorth(f, customerId, '900.00');
    await expect(
      asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.staff, { orderId: o.orderId })),
    ).rejects.toThrow(/may not 'approve_buyer'/);
  });

  it('a manager may dispatch anyway by saying why, and the reason is kept', async () => {
    const f = await fixture('overrode');
    const customerId = await buyer(f, { creditLimit: '500.00' });
    const o = await orderWorth(f, customerId, '900.00');
    const result = await asOrg(f.orgId, (tx) =>
      dispatchTradeOrder(tx, f.manager, {
        orderId: o.orderId,
        creditOverrideReason: 'Paying on delivery, agreed with the owner.',
      }),
    );
    expect(result.creditOverridden).toBe(true);
    const reread = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(reread!.creditOverrideReason).toMatch(/agreed with the owner/);
  });

  it('⛔ an override with no reason is refused even from a manager', async () => {
    const f = await fixture('noreason');
    const customerId = await buyer(f, { creditLimit: '100.00' });
    const o = await orderWorth(f, customerId, '900.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        dispatchTradeOrder(tx, f.manager, { orderId: o.orderId, creditOverrideReason: '   ' }),
      ),
    ).rejects.toThrow(/limit of/);
  });

  it('⚠️ a NULL limit never blocks — that is not the same as a limit of zero', async () => {
    const f = await fixture('nolimit');
    const customerId = await buyer(f);
    const o = await orderWorth(f, customerId, '99999.00');
    const result = await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    expect(result.creditOverridden).toBe(false);
  });

  it('the limit counts what is ALREADY owed, not just this order', async () => {
    const f = await fixture('cumulative');
    const customerId = await buyer(f, { creditLimit: '1000.00' });
    const first = await orderWorth(f, customerId, '700.00');
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: first.orderId }));

    // 700 already owed + 500 more = 1200, past the 1000 limit.
    const second = await orderWorth(f, customerId, '500.00');
    await expect(
      asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: second.orderId })),
    ).rejects.toThrow(/owes ₱700.00/);
  });
});

// =========================================================================================
// T-133 — the OTHER treatment: an internal transfer, which eliminates
// =========================================================================================

describe('an internal transfer is not a sale', () => {
  /** A customer that IS one of our own stores. Treatment is derived from the link (ADR-008 §2). */
  async function ownStore(f: Fixture, storeId: string, creditLimit?: string): Promise<string> {
    const c = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, {
        name: `Branch ${uid('br')}`,
        customerGroup: 'internal',
        counterpartyStoreId: storeId,
      }),
    );
    if (creditLimit) await sql`update customers set credit_limit = ${creditLimit} where id = ${c.id}`;
    return c.id;
  }

  /** An item with NO wholesale flag at all — a transfer must not need one. */
  async function plainItem(f: Fixture): Promise<string> {
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Prepped ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg',
        sellableWholesale: false,
      }),
    );
    return item.id;
  }

  async function transferOrder(f: Fixture, customerId: string, amount = '18000') {
    const itemId = await plainItem(f);
    await stock(f, f.storeId, f.locationId, itemId, '10', '300.0000');
    await mapSelf(f, itemId);
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '1', rate: amount }],
      }),
    );
    return { ...order, itemId };
  }

  it('⭐ DISPATCH moves real cost into 1340, at ONE store only', async () => {
    const f = await fixture('transfer');
    const customerId = await ownStore(f, f.otherStoreId);
    const o = await transferOrder(f, customerId);
    const result = await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    expect(result.treatment).toBe('internal');
    expect(result.chargeId).toBeNull();

    const legs = await sql<{ code: string; store_id: string; debit: string; credit: string }[]>`
      select a.code, jl.store_id, jl.debit::text, jl.credit::text
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId}
      order by a.code`;
    expect(legs).toHaveLength(2);
    // 1 kg relieved at its real FIFO cost (₱300), never at the ₱18,000 transfer rate.
    expect(legs.find((l) => l.code === '1340')).toMatchObject({ store_id: f.storeId, debit: '300.00' });
    expect(legs.find((l) => l.code === '1310')).toMatchObject({ store_id: f.storeId, credit: '300.00' });
    expect(legs.filter((l) => ['1250', '2150', '5170', '5175'].includes(l.code))).toHaveLength(0);
  });

  it('⭐ RECEIPT posts the four core legs across two stores, plus the margin — each party the OTHER store code', async () => {
    const f = await fixture('receipt4leg');
    const customerId = await ownStore(f, f.otherStoreId);
    const o = await transferOrder(f, customerId);
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: o.orderId, receivedOn: '2026-01-15' }));
    expect(received.entryId).not.toBeNull();

    const legs = await sql<
      { code: string; store_id: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]
    >`
      select a.code, jl.store_id, jl.debit::text, jl.credit::text, jl.party_type, jl.party_id
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${received.entryId}
      order by a.code, jl.store_id`;
    expect(legs).toHaveLength(5); // 4 core legs + the margin (5175), since the rate here exceeds cost

    const codes = await sql<{ id: string; code: string }[]>`
      select id, code from stores where id in (${f.storeId}, ${f.otherStoreId})`;
    const codeOf = new Map(codes.map((r) => [r.id, r.code]));

    const dueFrom = legs.find((l) => l.code === '1250')!;
    expect(dueFrom.store_id).toBe(f.storeId);
    expect(Number(dueFrom.debit)).toBe(18000);
    expect(dueFrom.party_type).toBe('store');
    expect(dueFrom.party_id).toBe(codeOf.get(f.otherStoreId));

    const dueTo = legs.find((l) => l.code === '2150')!;
    expect(dueTo.store_id).toBe(f.otherStoreId);
    expect(Number(dueTo.credit)).toBe(18000);
    expect(dueTo.party_id).toBe(codeOf.get(f.storeId));

    // ⭐ T-165. Real INVENTORY moves now, not cost through the P&L — 1340 relieved at COST
    // (₱300), the branch's new layer valued at the TRANSFER rate (₱18,000), and 5175 carries
    // exactly the margin between the two, never the whole value.
    const branchInv = legs.find((l) => l.code === '1310' && l.store_id === f.otherStoreId)!;
    expect(Number(branchInv.debit)).toBe(18000);
    const inTransit = legs.find((l) => l.code === '1340')!;
    expect(inTransit.store_id).toBe(f.storeId);
    expect(Number(inTransit.credit)).toBe(300);
    const margin = legs.find((l) => l.code === '5175')!;
    expect(margin.store_id).toBe(f.storeId);
    expect(Number(margin.credit)).toBe(17700);
    // ⛔ And no 5170 — that leg belonged to the periodic shape T-165 retired.
    expect(legs.filter((l) => l.code === '5170')).toHaveLength(0);

    // ⭐ T-165's own Done-when lesson: prove this GREEN on a POPULATED, TIED fixture, not
    // vacuously on an empty one (T-134's lesson) — real stock moved at both stores above.
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-01' }));
    expect(feed.findings.some((x) => x.kind === 'inventoryControlDoesNotMatchValuation')).toBe(false);
  });

  it("⭐ Ian's case, on the perpetual shape: Lipa buys at 300, ships to Malvar at 310 — Malvar's P&L stays at ZERO until it consumes", async () => {
    const f = await fixture('processing');
    const branch = await ownStore(f, f.otherStoreId);
    // 100 kg transferred at ₱310/kg — the slab's ₱300 plus Lipa's ₱10/kg of processing.
    const itemId = await plainItem(f);
    await stock(f, f.storeId, f.locationId, itemId, '100', '300.0000');
    await mapSelf(f, itemId);
    const o = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId: branch, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '100', rate: '310' }],
      }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: o.orderId, receivedOn: '2026-01-15' }));

    const byStore = await sql<{ code: string; store_id: string; amount: string }[]>`
      select a.code, jl.store_id, (jl.debit - jl.credit)::text as amount
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${received.entryId}`;

    // ⭐ T-165. Under perpetual, buying and receiving are BALANCE-SHEET events — Lipa's P&L
    // footprint from the transfer itself is exactly the ₱1,000 margin (5175's own comment: it
    // "must ELIMINATE against" whatever Lipa's payroll expensed for the processing work,
    // separately, not modelled here). It is NOT the whole ₱31,000 the periodic shape moved.
    const lipaPnl = byStore
      .filter((l) => l.store_id === f.storeId && l.code.startsWith('5'))
      .reduce((n, l) => n + Number(l.amount), 0);
    expect(lipaPnl).toBe(-1000);

    // ⭐ Malvar's P&L is untouched — the ₱31,000 landed in ITS inventory (1310), an asset, not
    // an expense. "The buyer's COGS appears only when it consumes" (T-165 test 4) — asserted by
    // absence here, since nothing has consumed it yet.
    const malvarPnl = byStore
      .filter((l) => l.store_id === f.otherStoreId && l.code.startsWith('5'))
      .reduce((n, l) => n + Number(l.amount), 0);
    expect(malvarPnl).toBe(0);
  });

  it('⛔ raises no receivable at all, and books no revenue', async () => {
    const f = await fixture('noar');
    const customerId = await ownStore(f, f.otherStoreId);
    const o = await transferOrder(f, customerId);
    const result = await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));

    const [charges] = await sql<{ count: string }[]>`
      select count(*)::text from ar_charges where org_id = ${f.orgId}`;
    expect(charges!.count).toBe('0');

    const [revenue] = await sql<{ count: string }[]>`
      select count(*)::text from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} and a.code = ${WHOLESALE_REVENUE_CODE}`;
    expect(revenue!.count).toBe('0');
  });

  it('⚠️ a credit limit on our own branch is ignored — a branch is not extended credit', async () => {
    const f = await fixture('nocredit');
    const customerId = await ownStore(f, f.otherStoreId, '1.00');
    const o = await transferOrder(f, customerId, '50000');
    const result = await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    expect(result.creditOverridden).toBe(false);
    expect(result.chargeId).toBeNull();
  });

  it('a transfer needs no wholesale flag — the item here has none', async () => {
    const f = await fixture('noflag');
    const customerId = await ownStore(f, f.otherStoreId);
    const o = await transferOrder(f, customerId);
    expect(Number(o.totalAmount)).toBe(18000);
  });

  it('⛔ a store cannot transfer to itself', async () => {
    const f = await fixture('self');
    const customerId = await ownStore(f, f.storeId);
    const itemId = await plainItem(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId, customerId, orderDate: '2026-01-10',
          lines: [{ itemId, quantity: '1', rate: '100' }],
        }),
      ),
    ).rejects.toThrow(/cannot transfer to itself/);
  });

  it('⭐ void BEFORE receipt reverses the dispatch, and gives the stock back', async () => {
    const f = await fixture('voidtransfer');
    const customerId = await ownStore(f, f.otherStoreId);
    const o = await transferOrder(f, customerId);
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    const { reversedEntryId } = await asOrg(f.orgId, (tx) =>
      voidTradeOrder(tx, f.admin, { orderId: o.orderId, reason: 'Crate never left the dock.' }),
    );
    expect(reversedEntryId).not.toBeNull();

    const [net] = await sql<{ in_transit: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as in_transit
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and a.code = '1340' and je.status <> 'draft'`;
    expect(Number(net!.in_transit)).toBe(0);

    const [onHand] = await sql<{ t: string }[]>`
      select coalesce(sum(quantity), 0)::text as t from stock_movements
      where item_id = ${o.itemId} and location_id = ${f.locationId}`;
    expect(onHand!.t).toBe('10.000'); // the whole 10 kg is back — none left in transit
  });

  it('⛔ void AFTER receipt is refused — a two-store reverse-transfer is not built (T-165)', async () => {
    const f = await fixture('voidafterreceipt');
    const customerId = await ownStore(f, f.otherStoreId);
    const o = await transferOrder(f, customerId);
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
    await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: o.orderId, receivedOn: '2026-01-15' }));
    await expect(
      asOrg(f.orgId, (tx) =>
        voidTradeOrder(tx, f.admin, { orderId: o.orderId, reason: 'Wrong item entirely.' }),
      ),
    ).rejects.toThrow(/reverse-transfer that is not built/);
  });

  it('⭐ T-165. receipt records who signed for it AND is now the event where both stores post', async () => {
    const f = await fixture('received');
    const customerId = await ownStore(f, f.otherStoreId);
    const o = await transferOrder(f, customerId);
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));

    const [before] = await sql<{ count: string }[]>`
      select count(*)::text from journal_entries where org_id = ${f.orgId}`;
    const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: o.orderId, receivedOn: '2026-01-15' }));
    const [after] = await sql<{ count: string }[]>`
      select count(*)::text from journal_entries where org_id = ${f.orgId}`;
    // ⭐ Under the old periodic shape this posted nothing. Under perpetual, this IS the one
    // event where both stores' books move (commissary/transfer.ts's header rule) — a real entry.
    expect(Number(after!.count)).toBe(Number(before!.count) + 1);
    expect(received.entryId).not.toBeNull();

    const reread = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(reread!.status).toBe('received');
    expect(reread!.receivedBy).toBe(f.manager.personId);
    expect(reread!.receivedAt).not.toBeNull();
  });

  it('⭐ across the org, total 1250 equals total 2150 after a mix of transfers and a sale', async () => {
    const f = await fixture('reciprocal');
    const branch = await ownStore(f, f.otherStoreId);
    for (const amount of ['1000', '2500', '750']) {
      const o = await transferOrder(f, branch, amount);
      await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: o.orderId }));
      // ⭐ T-165. 1250/2150 now post at RECEIPT, not dispatch.
      await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: o.orderId, receivedOn: '2026-01-15' }));
    }
    // A real sale alongside, to prove it does not disturb the pair.
    const itemId = await wholesaleItem(f, 'Sold outside');
    await stock(f, f.storeId, f.locationId, itemId, '10');
    const outside = await buyer(f);
    const sale = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId: outside, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '2', rate: '500' }],
      }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: sale.orderId }));

    const [net] = await sql<{ due_from: string; due_to: string }[]>`
      select
        coalesce(sum(case when a.code = '1250' then jl.debit - jl.credit end), 0)::text as due_from,
        coalesce(sum(case when a.code = '2150' then jl.credit - jl.debit end), 0)::text as due_to
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.status <> 'draft'`;
    expect(Number(net!.due_from)).toBe(4250);
    expect(Number(net!.due_from)).toBe(Number(net!.due_to));
  });

  it('T-398 S5c: an inter-entity customer (another ORG) can now be ordered for; nothing ships until dispatch', async () => {
    const f = await fixture('interorg');
    const [otherOrg] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Other ${uid('o')}`}, ${uid('oc')}) returning id`;
    // DEF-747 (T-398 S7d): linking to another company needs a franchise agreement; written as the owner, like onboarding does.
    const [otherPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${otherOrg!.id}, 'Franchisor person') returning id`;
    await sql`
      insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from)
      values (${otherOrg!.id}, ${f.orgId}, ${otherPerson!.id}, '2026-01-01')`;
    const c = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, {
        name: `Franchise ${uid('fr')}`, customerGroup: 'franchise', counterpartyOrgId: otherOrg!.id,
      }),
    );
    const itemId = await wholesaleItem(f, 'Franchise goods');
    const created = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId: c.id, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '1', rate: '100' }],
      }),
    );
    expect(created.totalAmount).toBe('100.00');
    const order = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, created.orderId));
    expect(order!.status).toBe('draft');
    expect(order!.customerId).toBe(c.id);
    // a draft order has moved nothing: no shipment note, no receivable, no entry
    const [n] = await sql<{ shipments: number; charges: number }[]>`
      select (select count(*)::int from inter_entity_shipments where trade_order_id = ${created.orderId}) as shipments,
             (select count(*)::int from ar_charges where org_id = ${f.orgId}) as charges`;
    expect(n).toEqual({ shipments: 0, charges: 0 });
  });
});

// =========================================================================================
// T-151 — landed cost and the branch price. Ian, 2026-08-28:
//   "delivery fee from supplier to Lipa is added to price.
//    delivery fee on top of that is the fee from Lipa to Malvar."
// =========================================================================================

describe('two delivery fees, two different treatments', () => {
  async function supplierFor(f: Fixture): Promise<string> {
    const s = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `Supplier ${uid('s')}` }));
    return s.id;
  }

  async function evidenceFile(f: Fixture): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/receipt_photo/${uid('f')}.jpg`},
              'image/jpeg', 1024, ${uid('sum')}, ${f.manager.personId})
      returning id`;
    return row!.id;
  }

  /** A verified invoice: `goods` of line value, plus an inbound delivery fee. */
  async function buy(
    f: Fixture,
    supplierId: string,
    itemId: string,
    opts: { qty: string; unitPrice: string; deliveryFee?: string; date?: string },
  ) {
    const lineTotal = (Number(opts.qty) * Number(opts.unitPrice)).toFixed(2);
    const fee = opts.deliveryFee ?? '0';
    const fileId = await evidenceFile(f);
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId,
        supplierId,
        invoiceDate: opts.date ?? '2026-01-10',
        totalAmount: (Number(lineTotal) + Number(fee)).toFixed(2),
        deliveryFee: fee,
        receiptFileId: fileId,
        lines: [{
          itemId, quantity: opts.qty, purchaseUnit: 'kg', conversionFactor: '1',
          unitPrice: opts.unitPrice, lineTotal,
        }],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }),
    );
    return created.id;
  }

  it('⭐ inbound freight is added to the PRICE — a ₱500 fee on ₱10,000 of goods lifts cost 5%', async () => {
    const f = await fixture('landed');
    const supplierId = await supplierFor(f);
    const itemId = await wholesaleItem(f, 'Slab');
    // 100 kg at ₱100 = ₱10,000, plus a ₱500 delivery fee.
    await buy(f, supplierId, itemId, { qty: '100', unitPrice: '100', deliveryFee: '500' });

    const history = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, itemId));
    expect(history).toHaveLength(1);
    // The raw line says ₱100/kg...
    expect(Number(history[0]!.basePrice)).toBeCloseTo(100, 4);
    // ...but what it cost to HAVE is ₱105/kg.
    expect(Number(history[0]!.landedBasePrice)).toBeCloseTo(105, 4);
  });

  it('a branch price is built on the landed cost, not the raw line', async () => {
    const f = await fixture('bprice');
    const supplierId = await supplierFor(f);
    const itemId = await wholesaleItem(f, 'Slab');
    await buy(f, supplierId, itemId, { qty: '100', unitPrice: '100', deliveryFee: '500' });
    await asOrg(f.orgId, (tx) =>
      setItemPricing(tx, f.superAdmin, { itemId, pricingMode: 'percent_markup', markupPercent: '10' }),
    );
    const bp = await asOrg(f.orgId, (tx) => branchPriceFor(tx, f.orgId, itemId));
    // ⭐ 105 landed × 1.10 = 115.50. On the raw ₱100 line it would have been ₱110 — the fee would
    // have been quietly absorbed by the commissary.
    expect(bp!.price).toBe('115.50');
  });

  it('⭐ the basis is max of the last TWO receives — a cheap lot cannot drop it', async () => {
    const f = await fixture('maxtwo');
    const supplierId = await supplierFor(f);
    const itemId = await wholesaleItem(f, 'Slab');
    await buy(f, supplierId, itemId, { qty: '10', unitPrice: '300', date: '2026-01-05' });
    await buy(f, supplierId, itemId, { qty: '10', unitPrice: '200', date: '2026-01-20' });
    await asOrg(f.orgId, (tx) =>
      setItemPricing(tx, f.superAdmin, { itemId, pricingMode: 'percent_markup', markupPercent: '0' }),
    );
    const bp = await asOrg(f.orgId, (tx) => branchPriceFor(tx, f.orgId, itemId));
    // The expensive lot is still in stock, so it still sets the floor.
    expect(bp!.price).toBe('300.00');
  });

  it('⭐ a poisoned line stops poisoning once corrected — v1 needed a forced recompute', async () => {
    const f = await fixture('poison');
    const supplierId = await supplierFor(f);
    const itemId = await wholesaleItem(f, 'Chopsticks');
    await asOrg(f.orgId, (tx) =>
      setItemPricing(tx, f.superAdmin, { itemId, pricingMode: 'percent_markup', markupPercent: '8' }),
    );
    // The classic bad entry: a 1,000-piece lot billed at ₱1,350 total, keyed as qty 1 @ ₱1,350.
    const bad = await buy(f, supplierId, itemId, { qty: '1', unitPrice: '1350', date: '2026-01-05' });
    const poisoned = await asOrg(f.orgId, (tx) => branchPriceFor(tx, f.orgId, itemId));
    expect(Number(poisoned!.price)).toBeCloseTo(1458, 0); // v1's frozen ₱1,458

    // Correct the line to what it really was: 1,000 pieces at ₱1.35.
    await sql`
      update supplier_invoice_lines
      set quantity = 1000, unit_price = 1.35
      where supplier_invoice_id = ${bad} and item_id = ${itemId}`;

    const healed = await asOrg(f.orgId, (tx) => branchPriceFor(tx, f.orgId, itemId));
    // ⭐ Right on the next read. v1 stayed at ₱1,458 until someone forced a recompute by hand.
    expect(Number(healed!.price)).toBeCloseTo(1.46, 2);
  });

  it('sliced meat prices off its source slab, and falls back to its own history', async () => {
    const f = await fixture('slab');
    const supplierId = await supplierFor(f);
    const slabId = await wholesaleItem(f, 'Beef slab');
    const slicedId = await wholesaleItem(f, 'Beef sliced');
    await buy(f, supplierId, slabId, { qty: '10', unitPrice: '400' });
    await asOrg(f.orgId, (tx) => setCostBasisItem(tx, f.superAdmin, { itemId: slicedId, costBasisItemId: slabId }));
    await asOrg(f.orgId, (tx) =>
      setItemPricing(tx, f.superAdmin, { itemId: slicedId, pricingMode: 'percent_markup', markupPercent: '25' }),
    );
    const bp = await asOrg(f.orgId, (tx) => branchPriceFor(tx, f.orgId, slicedId));
    expect(bp!.basisFrom).toBe('linked');
    expect(bp!.price).toBe('500.00'); // 400 × 1.25 — the sliced item was never bought itself
  });

  it('⛔ a cost-basis link may not point at itself or form a cycle', async () => {
    const f = await fixture('cycle');
    const a = await wholesaleItem(f, 'A');
    const b = await wholesaleItem(f, 'B');
    await expect(
      asOrg(f.orgId, (tx) => setCostBasisItem(tx, f.superAdmin, { itemId: a, costBasisItemId: a })),
    ).rejects.toThrow(/cannot price off itself/);

    await asOrg(f.orgId, (tx) => setCostBasisItem(tx, f.superAdmin, { itemId: a, costBasisItemId: b }));
    await expect(
      asOrg(f.orgId, (tx) => setCostBasisItem(tx, f.superAdmin, { itemId: b, costBasisItemId: a })),
    ).rejects.toThrow(/cycle/);
  });

  it('⭐ outbound freight is captured on the order, and posts at receipt as its own entry (T-372/DEF-127)', async () => {
    const f = await fixture('outbound');
    const c = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, {
        name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId,
      }),
    );
    const itemId = await wholesaleItem(f, 'Prepped');
    await stock(f, f.storeId, f.locationId, itemId, '5', '300.0000');
    await mapSelf(f, itemId);
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId: c.id, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '1', rate: '18000' }],
        deliveryFee: '1000',
      }),
    );
    // ⭐ The order still captures the fee, on top of the priced goods.
    expect(order.totalAmount).toBe('19000.00');

    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-15' }));

    // ⛔ The GOODS entry (received.entryId) moves the transfer value only, ₱18,000 — never ₱19,000.
    // T-372/DEF-127: the freight is a SEPARATE entry beside it, never folded in — this scan is
    // scoped to the goods entry specifically, so it stays a valid guard once that second entry
    // exists too (it would not, if the freight leg were merged into this one instead).
    const goodsLegs = await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, jl.debit::text, jl.credit::text
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${received.entryId}`;
    expect(Number(goodsLegs.find((l) => l.code === '1250')!.debit)).toBe(18000);
    expect(Number(goodsLegs.find((l) => l.code === '2150')!.credit)).toBe(18000);
    expect(goodsLegs.some((l) => Number(l.debit) === 1000 || Number(l.credit) === 1000)).toBe(false);

    // ⛔ And it did NOT touch the item's cost: the price history still says what the goods cost.
    const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
    expect(Number(lines[0]!.rate)).toBe(18000);

    // T-372/DEF-127 (R9) — the positive twin of t372-internal-freight.test.ts's F1: the ₱1,000
    // freight posts as its OWN entry at receipt, Dr 6630 / Cr 2150 on the branch (f.otherStoreId),
    // Dr 1250 / Cr 6630 on the commissary (f.storeId) — never folded into the goods entry above.
    // ⛔ TESTER, not BUILDER — `postInternalFreight` does not exist yet, so this is red today.
    const [freightEntry] = await sql<{ id: string }[]>`
      select id from journal_entries where org_id = ${f.orgId} and idempotency_key = ${`trade_order:${order.orderId}:receipt-freight`}`;
    expect(freightEntry, 'today: postInternalFreight does not exist, so no such entry posts').toBeDefined();
    const freightLegs = await sql<{ code: string; store_id: string; debit: string; credit: string }[]>`
      select a.code, jl.store_id, jl.debit::text, jl.credit::text
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${freightEntry!.id}`;
    expect(Number(freightLegs.find((l) => l.code === '6630' && l.store_id === f.otherStoreId)!.debit)).toBe(1000);
    expect(Number(freightLegs.find((l) => l.code === '2150' && l.store_id === f.otherStoreId)!.credit)).toBe(1000);
    expect(Number(freightLegs.find((l) => l.code === '1250' && l.store_id === f.storeId)!.debit)).toBe(1000);
    expect(Number(freightLegs.find((l) => l.code === '6630' && l.store_id === f.storeId)!.credit)).toBe(1000);
  });

  it('an internal order with no stated rate takes the branch price as its default', async () => {
    const f = await fixture('default');
    const supplierId = await supplierFor(f);
    const itemId = await wholesaleItem(f, 'Prepped');
    await buy(f, supplierId, itemId, { qty: '10', unitPrice: '100', deliveryFee: '100' });
    await asOrg(f.orgId, (tx) =>
      setItemPricing(tx, f.superAdmin, { itemId, pricingMode: 'fixed_markup', fixedMarkupAmount: '10' }),
    );
    const c = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, {
        name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId,
      }),
    );
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId: c.id, orderDate: '2026-01-15',
        lines: [{ itemId, quantity: '2' }],
      }),
    );
    // landed 110 + 10 markup = 120, × 2.
    expect(order.totalAmount).toBe('240.00');
  });
});

// =========================================================================================
// ⭐ DEF-138 — what the trade-orders SCREEN reads. Built 2026-09-03; until then no screen existed.
// =========================================================================================

describe('the trade-orders screen’s reads (DEF-138)', () => {
  it('⭐ listOrders shows an order from BOTH ends — the selling store and the receiving branch', async () => {
    const f = await fixture('list');
    const branch = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, {
        name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId,
      }),
    );
    const itemId = await wholesaleItem(f, 'Listed');
    const internal = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId: branch.id, orderDate: '2026-01-12',
        lines: [{ itemId, quantity: '2', rate: '100' }, { itemId, quantity: '1', rate: '50' }],
        deliveryFee: '25',
      }),
    );
    const outsideBuyer = await buyer(f);
    const external = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, {
        storeId: f.storeId, customerId: outsideBuyer, orderDate: '2026-01-11',
        lines: [{ itemId, quantity: '1', rate: '10' }],
      }),
    );

    // The selling store sees both.
    const atSeller = await asOrg(f.orgId, (tx) => tradeRepo.listOrders(tx, f.orgId, f.storeId));
    const ids = atSeller.map((o) => o.id);
    expect(ids).toContain(internal.orderId);
    expect(ids).toContain(external.orderId);
    // Newest order date first.
    expect(ids.indexOf(internal.orderId)).toBeLessThan(ids.indexOf(external.orderId));

    const row = atSeller.find((o) => o.id === internal.orderId)!;
    expect(row).toMatchObject({
      status: 'draft', lineCount: 2, totalAmount: '275.00', counterpartyStoreId: f.otherStoreId,
    });
    expect(row.customerName).toMatch(/^Branch /);

    // ⭐ The BRANCH sees the internal order coming its way — and NOT the external sale, which is
    // none of its business.
    const atBranch = await asOrg(f.orgId, (tx) => tradeRepo.listOrders(tx, f.orgId, f.otherStoreId));
    expect(atBranch.map((o) => o.id)).toEqual([internal.orderId]);

    // And the header row now exposes the fees the screen renders.
    const head = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, internal.orderId));
    expect(head).toMatchObject({ deliveryFee: '25.00', otherFees: '0.00' });
  });

  it('listItemPricing returns only the items that carry a rule — what the form needs to show a default', async () => {
    const f = await fixture('pricinglist');
    const ruled = await wholesaleItem(f, 'Ruled');
    const plain = await wholesaleItem(f, 'Plain');
    await asOrg(f.orgId, (tx) =>
      setItemPricing(tx, f.superAdmin, { itemId: ruled, pricingMode: 'fixed', fixedAmount: '120' }),
    );
    const rules = await asOrg(f.orgId, (tx) => itemsRepo.listItemPricing(tx, f.orgId));
    expect(rules.map((r) => r.itemId)).toContain(ruled);
    expect(rules.map((r) => r.itemId)).not.toContain(plain);
    expect(rules.find((r) => r.itemId === ruled)).toMatchObject({ pricingMode: 'fixed', fixedAmount: '120.00' });
  });
});
