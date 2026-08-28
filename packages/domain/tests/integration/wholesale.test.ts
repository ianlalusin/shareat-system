import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-132 — wholesale orders. `docs/tasks/132-wholesale-orders.md`.
 *
 * ⭐ The test that carries the design is *"editing the price list afterwards leaves the order
 * untouched"*. Everything else here is arithmetic and gating; that one is the reason
 * `wholesale_order_lines.rate` is a captured column rather than a join, and it is the difference
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
import { closeDb, transaction, wholesaleRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createCustomer,
  createItem,
  createPriceList,
  createWholesaleOrder,
  confirmWholesaleOrder,
  dispatchWholesaleOrder,
  setPrice,
  setStoreSellability,
  voidWholesaleOrder,
  WHOLESALE_REVENUE_CODE,
} from '@shareat/domain';

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

  return {
    orgId,
    storeId,
    otherStoreId,
    superAdmin: actor(orgId, superAdminId),
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An item this store sells wholesale. */
async function wholesaleItem(f: Fixture, name: string, storeId?: string): Promise<string> {
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, {
      code: uid('WS'),
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
      createWholesaleOrder(tx, f.manager, {
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

    const lines = await asOrg(f.orgId, (tx) => wholesaleRepo.linesFor(tx, f.orgId, order.orderId));
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.rate)).toBe(450);
    const reread = await asOrg(f.orgId, (tx) => wholesaleRepo.getOrderById(tx, f.orgId, order.orderId));
    expect(reread!.totalAmount).toBe('4500.00');
  });

  it('an item the customer’s price list does not quote is refused, and says so', async () => {
    const f = await fixture('unquoted');
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));
    const itemId = await wholesaleItem(f, 'Unquoted');
    const customerId = await buyer(f, { priceListId: list.id });
    await expect(
      asOrg(f.orgId, (tx) =>
        createWholesaleOrder(tx, f.manager, {
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
      createWholesaleOrder(tx, f.manager, {
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
        code: uid('BENTO'), name: `Bento ${uid('n')}`, kind: 'retail', baseUnit: 'pcs',
        sellableRetail: true, sellableWholesale: false,
      }),
    );
    const customerId = await buyer(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        createWholesaleOrder(tx, f.manager, {
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
      createWholesaleOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '5', rate: '120' }],
      }),
    );
    expect(ok.totalAmount).toBe('600.00');

    // Refused at the store that merely buys it in.
    await expect(
      asOrg(f.orgId, (tx) =>
        createWholesaleOrder(tx, f.manager, {
          storeId: f.otherStoreId, customerId, orderDate: '2026-01-10',
          lines: [{ itemId, quantity: '5', rate: '120' }],
        }),
      ),
    ).rejects.toThrow(/does not sell wholesale/);
  });

  it('⛔ an internal counterparty is refused, and the message names T-133', async () => {
    const f = await fixture('internal');
    const itemId = await wholesaleItem(f, 'Transfer stock');
    const customerId = await buyer(f, { group: 'internal' });
    await expect(
      asOrg(f.orgId, (tx) =>
        createWholesaleOrder(tx, f.manager, {
          storeId: f.storeId, customerId, orderDate: '2026-01-10',
          lines: [{ itemId, quantity: '1', rate: '10' }],
        }),
      ),
    ).rejects.toThrow(/T-133/);
  });

  it('an order whose stated total disagrees with its lines is refused', async () => {
    const f = await fixture('total');
    const itemId = await wholesaleItem(f, 'Anything');
    const customerId = await buyer(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        createWholesaleOrder(tx, f.manager, {
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
        createWholesaleOrder(tx, f.manager, {
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
    const customerId = await buyer(f, opts.creditLimit !== undefined ? { creditLimit: opts.creditLimit } : {});
    const order = await asOrg(f.orgId, (tx) =>
      createWholesaleOrder(tx, f.manager, {
        storeId: f.storeId, customerId, orderDate: '2026-01-10',
        lines: [{ itemId, quantity: '4', rate: '250' }],
      }),
    );
    return { ...order, customerId, itemId };
  }

  it('⭐ posts exactly one balanced entry to 1210 / 4300, with the customer as party', async () => {
    const f = await fixture('post');
    const o = await anOrder(f);
    await asOrg(f.orgId, (tx) => confirmWholesaleOrder(tx, f.manager, { orderId: o.orderId }));
    const result = await asOrg(f.orgId, (tx) =>
      dispatchWholesaleOrder(tx, f.manager, { orderId: o.orderId }),
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

    const reread = await asOrg(f.orgId, (tx) => wholesaleRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(reread!.status).toBe('dispatched');
    expect(reread!.arChargeId).toBe(result.chargeId);
  });

  it('dispatching twice posts once', async () => {
    const f = await fixture('idem');
    const o = await anOrder(f);
    const first = await asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.manager, { orderId: o.orderId }));
    const second = await asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.manager, { orderId: o.orderId }));
    expect(second.chargeId).toBe(first.chargeId);
    expect(second.entryId).toBe(first.entryId);

    const [charges] = await sql<{ count: string }[]>`
      select count(*)::text from ar_charges where org_id = ${f.orgId} and customer_id = ${o.customerId}`;
    expect(charges!.count).toBe('1');
  });

  it('void reverses the receivable rather than deleting it', async () => {
    const f = await fixture('void');
    const o = await anOrder(f);
    await asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.manager, { orderId: o.orderId }));
    const { reversedEntryId } = await asOrg(f.orgId, (tx) =>
      voidWholesaleOrder(tx, f.admin, { orderId: o.orderId, reason: 'Buyer cancelled before pickup.' }),
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

    const reread = await asOrg(f.orgId, (tx) => wholesaleRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(reread!.status).toBe('void');
  });

  it('a void order cannot be voided again', async () => {
    const f = await fixture('revoid');
    const o = await anOrder(f);
    await asOrg(f.orgId, (tx) => voidWholesaleOrder(tx, f.manager, { orderId: o.orderId, reason: 'Mistake.' }));
    await expect(
      asOrg(f.orgId, (tx) => voidWholesaleOrder(tx, f.manager, { orderId: o.orderId, reason: 'Again.' })),
    ).rejects.toThrow(/already void/);
  });
});

// =========================================================================================
// The credit gate — one gate, at dispatch
// =========================================================================================

describe('the credit limit', () => {
  async function orderWorth(f: Fixture, customerId: string, amount: string) {
    const itemId = await wholesaleItem(f, 'Credit stock');
    return asOrg(f.orgId, (tx) =>
      createWholesaleOrder(tx, f.manager, {
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
      asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.manager, { orderId: o.orderId })),
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
      asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.staff, { orderId: o.orderId })),
    ).rejects.toThrow(/may not 'approve_buyer'/);
  });

  it('a manager may dispatch anyway by saying why, and the reason is kept', async () => {
    const f = await fixture('overrode');
    const customerId = await buyer(f, { creditLimit: '500.00' });
    const o = await orderWorth(f, customerId, '900.00');
    const result = await asOrg(f.orgId, (tx) =>
      dispatchWholesaleOrder(tx, f.manager, {
        orderId: o.orderId,
        creditOverrideReason: 'Paying on delivery, agreed with the owner.',
      }),
    );
    expect(result.creditOverridden).toBe(true);
    const reread = await asOrg(f.orgId, (tx) => wholesaleRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(reread!.creditOverrideReason).toMatch(/agreed with the owner/);
  });

  it('⛔ an override with no reason is refused even from a manager', async () => {
    const f = await fixture('noreason');
    const customerId = await buyer(f, { creditLimit: '100.00' });
    const o = await orderWorth(f, customerId, '900.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        dispatchWholesaleOrder(tx, f.manager, { orderId: o.orderId, creditOverrideReason: '   ' }),
      ),
    ).rejects.toThrow(/limit of/);
  });

  it('⚠️ a NULL limit never blocks — that is not the same as a limit of zero', async () => {
    const f = await fixture('nolimit');
    const customerId = await buyer(f);
    const o = await orderWorth(f, customerId, '99999.00');
    const result = await asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.manager, { orderId: o.orderId }));
    expect(result.creditOverridden).toBe(false);
  });

  it('the limit counts what is ALREADY owed, not just this order', async () => {
    const f = await fixture('cumulative');
    const customerId = await buyer(f, { creditLimit: '1000.00' });
    const first = await orderWorth(f, customerId, '700.00');
    await asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.manager, { orderId: first.orderId }));

    // 700 already owed + 500 more = 1200, past the 1000 limit.
    const second = await orderWorth(f, customerId, '500.00');
    await expect(
      asOrg(f.orgId, (tx) => dispatchWholesaleOrder(tx, f.manager, { orderId: second.orderId })),
    ).rejects.toThrow(/owes ₱700.00/);
  });
});
