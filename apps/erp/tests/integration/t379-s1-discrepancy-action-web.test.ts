import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-379 S1 (DEF-575) - `resolveDiscrepancyAction` turns every refusal into a banner on the same page, never an uncaught throw
 * and never a uuid in the URL. `docs/tasks/379-erp-small-follow-ups.md` S1 A1-A3. Harness from `t376-s1-action-forward-web.test.ts`
 * (RedirectSignal, mocked session, real domain, real DB); fixture from `t374-s6-branch-recount-action.test.ts`.
 * TESTER, not BUILDER.
 *
 *   A1  closed January, short row, loss -> redirect to /commissary/discrepancies?store=<id>&error=<the month sentence>.
 *       Red on HEAD: postEntry throws and nothing catches it (the test sees the raw Error, not a RedirectSignal).
 *   A2  a second resolve of the same row: the domain reason carries the row uuid; the redirect error must not.
 *       Red on HEAD (`back(storeId, result.reason)`). Mutant: `back(storeId, result.reason)` -> red.
 *   A3  a staff actor: authorize throws -> a redirect carrying a sentence, not a throw. Red on HEAD (the throw escapes).
 *       Mutant: drop the try/catch -> A1 and A3 red.
 *   C1  (control, green on HEAD) an open-month loss by a manager -> redirect with no error; the entry is posted.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { closeDb, transaction, tradeRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createTradeOrder, dispatchTradeOrder, receiveTradeOrder } from '@shareat/domain';
import { receiveDelivery } from '../../../../packages/domain/src/deliveries/receive';
import { quantity } from '../../../../packages/domain/src/stock/quantity';
import { resolveDiscrepancyAction } from '../../src/app/commissary/discrepancies/actions';
import { urlOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// -----------------------------------------------------------------------------------------------
// Fixture — t372-receipt-discrepancy.test.ts's, with TWO branches (br, bq) and per-store people.
// `storeId` is the commissary (dispatching store); `branchId` the branch that RECEIVES and miscounts.
// -----------------------------------------------------------------------------------------------
async function fixture(hint: string) {
  const code = uid(`t374s6-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}${++seq}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('com');
  const branchId = await mkStore('br');
  const branch2Id = await mkStore('bq');

  const mkPerson = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const all = [storeId, branchId, branch2Id];
  const superAdminId = await mkPerson('Super', 'super_admin', all);
  const adminId = await mkPerson('Admin', 'admin', all);
  const managerId = await mkPerson('Commissary Manager', 'manager', all);
  const branchManagerId = await mkPerson('Branch Manager', 'manager', [branchId]);
  const branchStaffId = await mkPerson('Branch Staff', 'staff', [branchId]);

  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLocation = async (sId: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId}) returning id`;
    return row!.id;
  };
  const locationId = await mkLocation(storeId);
  await mkLocation(branchId);
  await mkLocation(branch2Id);
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${superAdminId}) returning id`;
  const [names] = await sql<{ com: string; br: string }[]>`
    select (select name from stores where id = ${storeId}) as com, (select name from stores where id = ${branchId}) as br`;

  return {
    orgId, storeId, branchId, branch2Id, locationId, fileId: file!.id, comName: names!.com, brName: names!.br,
    superAdmin: actor(orgId, superAdminId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
    branchManager: actor(orgId, branchManagerId), branchStaff: actor(orgId, branchStaffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stock(f: Fixture, itemId: string, qty: string): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: '300.0000', locationId: f.locationId }],
    }),
  );
}

/** A dispatched 20-unit order from the commissary to `branch`, received as `received` of 20. Returns the order and its discrepancy row (if any). */
async function orderTo(f: Fixture, branch: string, received: string) {
  const itemId = (await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: uid('WS'), name: `Prepped ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }))).id;
  await stock(f, itemId, '30');
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${branch}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('c')}`, customerGroup: 'internal', counterpartyStoreId: branch }));
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '20', rate: '500' }] }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const [line] = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  await asOrg(f.orgId, (tx) =>
    receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-15', lines: [{ lineId: line!.id, receivedQuantity: received, ...(Number(received) < 20 ? { shortageReason: 'damaged_in_transit' } : {}) } as never] }),
  );
  const rows = await sql<{ id: string; direction: string; status: string; disposition: string | null; store_id: string }[]>`
    select id, direction, status, disposition, store_id from trade_discrepancies where order_id = ${order.orderId}`;
  return { orderId: order.orderId, itemId, rows, row: rows[0] };
}
const overTo = async (f: Fixture, branch: string) => {
  const o = await orderTo(f, branch, '22');
  if (!o.row || o.row.direction !== 'over') throw new Error('fixture: the over-receipt raised no OVER row');
  return { ...o, row: o.row };
};
const shortTo = async (f: Fixture, branch: string) => {
  const o = await orderTo(f, branch, '15');
  if (!o.row || o.row.direction !== 'short') throw new Error('fixture: the short receipt raised no SHORT row');
  return { ...o, row: o.row };
};
const rowState = async (id: string) =>
  (await sql<{ status: string; disposition: string | null }[]>`select status, disposition from trade_discrepancies where id = ${id}`)[0]!;
const entriesFor = async (id: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where idempotency_key like ${`trade_discrepancy:${id}:%`}`)[0]!.n);
const closeJanuary = (f: Fixture) => sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-01-01'`;

/** Run the action as `who`; return the redirect it threw, or the raw error if it threw anything else. */
async function run(f: Fixture, who: Actor, fields: Record<string, string>): Promise<{ to: URL } | { thrown: unknown }> {
  ACTOR_HOLDER.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await resolveDiscrepancyAction(fd);
    return { thrown: new Error('the action returned without redirecting') };
  } catch (e) {
    if (e instanceof RedirectSignal) return { to: urlOf(e.to) };
    return { thrown: e };
  }
}
const form = (f: Fixture, id: string, disposition: string, more: Record<string, string> = {}) => ({
  id, storeId: f.storeId, disposition, resolvedOn: '2026-01-20', ...more,
});
function redirected(r: { to: URL } | { thrown: unknown }): URL {
  if ('thrown' in r) {
    throw new Error(`the action THREW instead of redirecting: ${r.thrown instanceof Error ? r.thrown.message : String(r.thrown)}`);
  }
  return r.to;
}

describe('A1 - a closed month comes back as a banner, not a throw', () => {
  it('short row, loss, closed January -> /commissary/discrepancies?store=<id>&error=<the month sentence>; nothing written - red on HEAD (uncaught throw)', async () => {
    const f = await fixture('a1');
    const { row } = await shortTo(f, f.branchId);
    await closeJanuary(f);
    const to = redirected(await run(f, f.manager, form(f, row.id, 'loss')));
    expect(to.pathname).toBe('/commissary/discrepancies');
    expect(to.searchParams.get('store')).toBe(f.storeId);
    expect(to.searchParams.get('error')).toMatch(/^January 2026 is closed, so this can't be booked on .+\. Nothing was saved\.$/);
    expect(to.searchParams.get('error')).not.toMatch(UUID);
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect(await entriesFor(row.id)).toBe(0);
  });
});

describe('A2 - no uuid in the URL when the domain refuses with one', () => {
  it('resolve the same row twice: the second redirect carries a sentence with no uuid - red on HEAD (the reason names the row)', async () => {
    const f = await fixture('a2');
    const { row } = await overTo(f, f.branchId);
    const first = redirected(await run(f, f.manager, form(f, row.id, 'return', { note: 'went back on the truck' })));
    expect(first.searchParams.get('error'), 'control: the first resolve succeeds').toBeNull();
    expect(await rowState(row.id)).toMatchObject({ status: 'resolved', disposition: 'return' });

    const second = redirected(await run(f, f.manager, form(f, row.id, 'return', { note: 'again' })));
    const error = second.searchParams.get('error');
    expect(error, 'the second attempt must show the manager why').toBeTruthy();
    expect(error).not.toMatch(UUID);
    expect(second.search).not.toContain(row.id);
  });
});

describe('A3 - a thrown authorization refusal is a redirect, not a throw', () => {
  it('a branch STAFF actor resolving at the commissary -> a redirect carrying a sentence - red on HEAD (the throw escapes); the row is untouched', async () => {
    const f = await fixture('a3');
    const { row } = await shortTo(f, f.branchId);
    const to = redirected(await run(f, f.branchStaff, form(f, row.id, 'loss')));
    expect(to.pathname).toBe('/commissary/discrepancies');
    const error = to.searchParams.get('error');
    expect(error).toBeTruthy();
    expect(error).not.toMatch(UUID);
    expect(await rowState(row.id)).toMatchObject({ status: 'open', disposition: null });
    expect(await entriesFor(row.id)).toBe(0);
  });
});

describe('C1 (control, green on HEAD) - the happy path still posts and redirects clean', () => {
  it('open January, short row, loss, manager -> redirect with no error; the entry is posted', async () => {
    const f = await fixture('c1');
    const { row } = await shortTo(f, f.branchId);
    const to = redirected(await run(f, f.manager, form(f, row.id, 'loss')));
    expect(to.searchParams.get('error')).toBeNull();
    expect(await rowState(row.id)).toMatchObject({ status: 'resolved', disposition: 'loss' });
    expect(await entriesFor(row.id)).toBe(1);
  });
});
