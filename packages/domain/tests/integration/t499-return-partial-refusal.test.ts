import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@shareat/db/schema';

/**
 * T-499 (DEF-798) — a customer return refused partway leaves nothing behind. Fixtures copied from
 * `customer-returns.test.ts`. Every call runs through `asOrg`, which COMMITS when the callback
 * returns (even `{ ok: false }`) and rolls back only when it throws — exactly what the ERP's
 * `withOrgPrincipal` does — so a refusal that returns after stock moved leaves the stock moved.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, RefusalError, transaction, tradeRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createCustomer,
  createItem,
  createTradeOrder,
  dispatchTradeOrder,
  receiveTradeOrder,
  recordCustomerReturn,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
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
    createItem(tx, f.superAdmin, { code: testItemCode(), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
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


const RETURN_SOURCES = ['customer_return', 'customer_return_unsellable'];

/** Everything a half-posted return would leave behind, counted after commit. */
async function snapshot(f: Fixture, itemIds: string[]) {
  const [m] = await sql<{ n: number }[]>`
    select count(*)::int as n from stock_movements where org_id = ${f.orgId} and source_type in ${sql(RETURN_SOURCES)}`;
  const layers = await sql<{ item_id: string; remaining: string }[]>`
    select item_id, remaining_quantity::text as remaining from stock_layers
    where org_id = ${f.orgId} and item_id in ${sql(itemIds)} order by item_id, received_at, id`;
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from customer_returns where org_id = ${f.orgId}`;
  const [j] = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries where org_id = ${f.orgId} and source_type = 'customer_return'`;
  return { movements: m!.n, layers, returns: r!.n, journals: j!.n };
}

/** drizzle over an open postgres.js transaction/savepoint handle (it reads the parent client's `options` to pick its parsers). */
function asDrizzle(handle: postgres.TransactionSql): Tx {
  (handle as unknown as { options?: unknown }).options ??= sql.options;
  return drizzle(handle as unknown as postgres.Sql, { schema }) as unknown as Tx;
}

/** The same counts as `snapshot`, read inside an open transaction (as its owner) instead of through the plain client. */
async function snapshotIn(tx: Tx, f: Fixture, itemIds: string[]) {
  const ids = dsql.join(itemIds.map((id) => dsql`${id}::uuid`), dsql`, `);
  const m = await tx.execute(dsql`select count(*)::int as n from stock_movements where org_id = ${f.orgId} and source_type in ('customer_return', 'customer_return_unsellable')`);
  const layers = await tx.execute(dsql`select item_id, remaining_quantity::text as remaining from stock_layers where org_id = ${f.orgId} and item_id in (${ids}) order by item_id, received_at, id`);
  const r = await tx.execute(dsql`select count(*)::int as n from customer_returns where org_id = ${f.orgId}`);
  const j = await tx.execute(dsql`select count(*)::int as n from journal_entries where org_id = ${f.orgId} and source_type = 'customer_return'`);
  return { movements: m[0]!.n, layers: [...layers], returns: r[0]!.n, journals: j[0]!.n };
}

/** An external order with the given items, one line each (an item may repeat), dispatched. */
async function aMultiLineSale(f: Fixture, itemIds: string[], qty = '10') {
  for (const id of new Set(itemIds)) await stock(f, f.storeId, f.locationId, id, '40', '90.0000');
  const customerId = await buyer(f);
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, {
      storeId: f.storeId, customerId, orderDate: '2026-01-10',
      lines: itemIds.map((itemId) => ({ itemId, quantity: qty, rate: '500' })),
    }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  return { orderId: order.orderId, lineIds: lines.map((l) => l.id) };
}

/** An internal transfer of the given items to the other store, dispatched and received. */
async function aMultiLineTransfer(f: Fixture, itemIds: string[], qty = '10') {
  for (const id of itemIds) {
    await stock(f, f.storeId, f.locationId, id, '40', '90.0000');
    await mapSelf(f, id);
  }
  const customerId = await asOrg(f.orgId, (tx) =>
    createCustomer(tx, f.admin, { name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId }),
  ).then((c) => c.id);
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, {
      storeId: f.storeId, customerId, orderDate: '2026-01-10',
      lines: itemIds.map((itemId) => ({ itemId, quantity: qty, rate: '100' })),
    }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-11' }));
  const lines = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  return { orderId: order.orderId, lineIds: lines.map((l) => l.id) };
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-499 — a refused return leaves nothing behind', () => {
  it('(a) refund to a money account that does not exist: refused, nothing moved on either line', async () => {
    const f = await fixture('t499a');
    const [a, b] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B')] as [string, string];
    const s = await aMultiLineSale(f, [a, b]);
    const before = await snapshot(f, [a, b]);
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong goods.', refund: true, moneyAccountId: randomUUID(),
        lines: [{ tradeOrderLineId: s.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: s.lineIds[1]!, quantity: '4' }], actor: f.manager,
      }),
    );
    expect(res).toEqual({ ok: false, reason: 'that money account does not exist.' });
    expect(await snapshot(f, [a, b])).toEqual(before);
  });

  it('(b) refund with no money account: refused, nothing moved', async () => {
    const f = await fixture('t499b');
    const [a, b] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B')] as [string, string];
    const s = await aMultiLineSale(f, [a, b]);
    const before = await snapshot(f, [a, b]);
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong goods.', refund: true, moneyAccountId: null,
        lines: [{ tradeOrderLineId: s.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: s.lineIds[1]!, quantity: '4' }], actor: f.manager,
      }),
    );
    expect(res).toEqual({ ok: false, reason: 'a cash refund needs a money account.' });
    expect(await snapshot(f, [a, b])).toEqual(before);
  });

  it('(c) line 2 has no dispatch movement: refused with the same sentence, line 1 did not move', async () => {
    const f = await fixture('t499c');
    const [a, b, c] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B'), await wholesaleItem(f, 'C')] as [string, string, string];
    const s = await aMultiLineSale(f, [a, b]);
    // Line 2 now names an item the dispatch never moved (C), so there is no dispatch movement to reverse for it.
    await sql`update trade_order_lines set item_id = ${c} where id = ${s.lineIds[1]!}`;
    const cName = (await sql<{ name: string }[]>`select name from items where id = ${c}`)[0]!.name;
    const before = await snapshot(f, [a, b, c]);
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong goods.',
        lines: [{ tradeOrderLineId: s.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: s.lineIds[1]!, quantity: '4' }], actor: f.manager,
      }),
    );
    expect(res).toEqual({ ok: false, reason: `no dispatch movement found for ${cName} on this order — that is a bug.` });
    expect(await snapshot(f, [a, b, c])).toEqual(before);
  });

  it('(d) a late refusal: line 2 cannot reverse its sale (already reversed elsewhere) after line 1 moved -> the call throws, the rollback leaves nothing', async () => {
    const f = await fixture('t499d');
    const [a, b] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B')] as [string, string];
    const s = await aMultiLineSale(f, [a, b]);
    // ⚠️ A narrow seam, not a product path: no reachable fixture state lets line 2's stock write refuse after line 1's
    // (the order's cap and the dispatch movement are pre-checked; one dispatch cannot repeat an item). So the SALE's own
    // consumption of B is marked as already given back, as if another path had reversed it: line 2 then has nothing to reverse.
    const [mv] = await sql<{ id: string }[]>`
      select id from stock_movements where source_type = 'trade_order_dispatch' and source_id = ${s.orderId} and item_id = ${b}`;
    const [other] = await sql<{ id: string }[]>`
      select id from stock_movements where source_type = 'trade_order_dispatch' and source_id = ${s.orderId} and item_id = ${a}`;
    await sql.begin(async (t) => {
      await t`update stock_layers l set remaining_quantity = l.remaining_quantity + c.quantity
        from stock_layer_consumptions c where c.layer_id = l.id and c.movement_id = ${mv!.id}`;
      await t`update stock_layer_consumptions set reversed_by_movement_id = ${other!.id} where movement_id = ${mv!.id}`;
    });
    const before = await snapshot(f, [a, b]);
    const err = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong goods.',
        lines: [{ tradeOrderLineId: s.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: s.lineIds[1]!, quantity: '4' }], actor: f.manager,
      }),
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe('only 0.000 was consumed, 4.000 requested — a reversal cannot exceed it');
    expect(await snapshot(f, [a, b])).toEqual(before);
  });

  it('(e) internal transfer, line 2 fails a pre-check (its item kind has no inventory account): nothing moved', async () => {
    const f = await fixture('t499e');
    const [a, b] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B')] as [string, string];
    const t = await aMultiLineTransfer(f, [a, b]);
    const [orig] = await sql<{ kind: string }[]>`select kind from items where id = ${b}`;
    // ⚠️ A narrow seam, and it NEVER commits. The database's own items_kind_check (and the same-org foreign keys) make every
    // per-line internal pre-check unreachable with real rows, so inside ONE outer transaction on the OWNER connection (the
    // runner role `transaction()` uses is not the table owner and cannot run DDL) the check is dropped and the kind changed,
    // the return runs in a nested savepoint exactly as asOrg runs it (released, i.e. committed, on `{ ok: false }`), the counts
    // are read back in the outer transaction, and a sentinel throw rolls the whole thing back: the DDL, the kind change and the
    // return never reach any other connection.
    const ROLLBACK = new Error('t499 (e): roll back the seam');
    const seen: { res?: unknown; before?: Awaited<ReturnType<typeof snapshotIn>>; after?: Awaited<ReturnType<typeof snapshotIn>> } = {};
    await sql
      .begin(async (outer) => {
        const tx = asDrizzle(outer);
        await tx.execute(dsql.raw('alter table items drop constraint items_kind_check'));
        await tx.execute(dsql`update items set kind = 'no_such_kind' where id = ${b}`);
        seen.before = await snapshotIn(tx, f, [a, b]);
        seen.res = await outer.savepoint(async (sp) => {
          const inner = asDrizzle(sp);
          await inner.execute(dsql.raw(`set local role ${APP_ROLE}`));
          await inner.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
          await inner.execute(dsql`select set_config('app.org_id', ${f.orgId}, true)`);
          return recordCustomerReturn(inner, {
            tradeOrderId: t.orderId, returnedOn: '2026-01-15', reason: 'Overstocked.',
            lines: [{ tradeOrderLineId: t.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: t.lineIds[1]!, quantity: '4' }], actor: f.manager,
          });
        });
        await tx.execute(dsql.raw('reset role'));
        seen.after = await snapshotIn(tx, f, [a, b]);
        throw ROLLBACK;
      })
      .then(
        () => { throw new Error('the seam transaction must roll back'); },
        (e: unknown) => { if (e !== ROLLBACK) throw e; },
      );
    expect(seen.res).toEqual({ ok: false, reason: 'item kind has no inventory account in COA-ALIGNMENT §4.1.' });
    expect(seen.after).toEqual(seen.before);
    // Nothing of the seam survived the rollback.
    const [chk] = await sql<{ n: number }[]>`select count(*)::int as n from pg_constraint where conname = 'items_kind_check' and conrelid = 'items'::regclass`;
    expect(chk!.n).toBe(1);
    expect((await sql<{ kind: string }[]>`select kind from items where id = ${b}`)[0]!.kind).toBe(orig!.kind);
  });

  it('(f1) control: a valid two-line external return, line 2 unsellable, posts exactly as before', async () => {
    const f = await fixture('t499f1');
    const [a, b] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B')] as [string, string];
    const s = await aMultiLineSale(f, [a, b]);
    const before = await snapshot(f, [a, b]);
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong goods.',
        lines: [{ tradeOrderLineId: s.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: s.lineIds[1]!, quantity: '3', saleable: false }], actor: f.manager,
      }),
    );
    expect(res.ok).toBe(true);
    const after = await snapshot(f, [a, b]);
    expect(after.movements - before.movements).toBe(3); // two reversals + one wastage
    expect(after.returns - before.returns).toBe(1);
    expect(after.journals - before.journals).toBe(2); // the return entry + the unsellable wastage entry
  });

  it('(f2) control: a valid two-line external cash refund posts exactly as before', async () => {
    const f = await fixture('t499f2');
    const [a, b] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B')] as [string, string];
    const s = await aMultiLineSale(f, [a, b]);
    const before = await snapshot(f, [a, b]);
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId: s.orderId, returnedOn: '2026-01-15', reason: 'Wrong goods.', refund: true, moneyAccountId: f.cashAccountId,
        lines: [{ tradeOrderLineId: s.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: s.lineIds[1]!, quantity: '3' }], actor: f.manager,
      }),
    );
    expect(res.ok && res.settlement).toBe('cash_refund');
    const after = await snapshot(f, [a, b]);
    expect(after.movements - before.movements).toBe(2);
    expect(after.returns - before.returns).toBe(1);
    expect(after.journals - before.journals).toBe(1);
  });

  it('(f3) control: a valid two-line internal return posts exactly as before', async () => {
    const f = await fixture('t499f3');
    const [a, b] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B')] as [string, string];
    const t = await aMultiLineTransfer(f, [a, b]);
    const before = await snapshot(f, [a, b]);
    const res = await asOrg(f.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId: t.orderId, returnedOn: '2026-01-15', reason: 'Overstocked.',
        lines: [{ tradeOrderLineId: t.lineIds[0]!, quantity: '4' }, { tradeOrderLineId: t.lineIds[1]!, quantity: '4' }], actor: f.manager,
      }),
    );
    expect(res.ok && res.settlement).toBe('reverse_transfer');
    const after = await snapshot(f, [a, b]);
    expect(after.movements - before.movements).toBe(4); // two transfer_out + two transfer_in
    expect(after.returns - before.returns).toBe(1);
    expect(after.journals - before.journals).toBe(1);
  });
});
