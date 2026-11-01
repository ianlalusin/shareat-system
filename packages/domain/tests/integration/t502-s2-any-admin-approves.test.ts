/**
 * T-502 S2 (TESTER, red until built) - docs/tasks/502-expense-item-catalog.md section 4 S2 ("2A, Ian 31 Oct").
 * Real Postgres. Any `*_test` database.
 *
 * Contract under test:
 *   - approveItemRequest / rejectItemRequest are allowed to ANY holder of the admin role in the org (a capability, not a role-name
 *     check; the builder adds it to CAPABILITY-MATRIX). Super-admin keeps it. Manager and staff ("cashier") are refused with
 *     AuthorizationError and nothing is written.
 *   - A requester never approves their own request (the spec says this "stays"; see the report: no such check exists today).
 *   - Approving a PURCHASABLE item with no expense category (none on the request, none typed at approval) is refused with a plain
 *     sentence that names the category; the request stays `requested` and no item exists.
 *   - The request carries `expenseCategoryId`; approval copies it onto items.expense_category_id; an approver may override it.
 *   - The rest of `approve_item` stays super-admin only: an admin still cannot createItem or mergeItems (no widening).
 *
 * Assumed input names (builder may rename; tell the tester):
 *   requestItem(tx, actor, { ..., expenseCategoryId? })     approveItemRequest(tx, actor, { requestId, expenseCategoryId? })
 *
 * Red now: admin is refused at approve/reject (`approve_item` is super-admin only), and expenseCategoryId is not an input.
 * NOTE for the builder: items.test.ts "an ADMIN cannot approve - only a super-admin" (~line 718) states the OLD rule and must be
 * rewritten with this change (bible row: 2A supersedes 2026-08-28).
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError, type Actor } from '@shareat/auth';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { approveItemRequest, createItem, mergeItems, rejectItemRequest, requestItem } from '@shareat/domain';

import { testItemCode } from './_fixtures/item-code';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: database name must contain "_test".');

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function world(hint: string) {
  const c = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
  const orgId = o!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const person = async (name: string, role: 'super_admin' | 'admin' | 'manager' | 'staff'): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return { personId: p!.id, orgId };
  };
  const category = async (label: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into expense_categories (org_id, "group", category) values (${orgId}, 'COGS', ${`${label} ${c}`}) returning id`;
    return r!.id;
  };
  return {
    orgId,
    storeId: store!.id,
    superAdmin: await person('Super', 'super_admin'),
    admin: await person('Admin', 'admin'),
    admin2: await person('Admin Two', 'admin'),
    manager: await person('Manager', 'manager'),
    cashier: await person('Cashier', 'staff'),
    category,
    categoryId: await category('Supplies'),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Inputs carry the NEW field; cast so the file compiles before the feature exists. */
type Asked = Parameters<typeof requestItem>[2];
type Approve = Parameters<typeof approveItemRequest>[2];
const ask = (w: World, who: Actor, over: Record<string, unknown> = {}) =>
  asOrg(w.orgId, (tx) =>
    requestItem(tx, who, { name: `Dish soap ${uid('n')}`, kind: 'supply', baseUnit: 'ltr', expenseCategoryId: w.categoryId, ...over } as unknown as Asked),
  );
const approve = (w: World, who: Actor, requestId: string, over: Record<string, unknown> = {}) =>
  asOrg(w.orgId, (tx) => approveItemRequest(tx, who, { requestId, ...over } as unknown as Approve));
const reject = (w: World, who: Actor, requestId: string, note = 'We already have it.') =>
  asOrg(w.orgId, (tx) => rejectItemRequest(tx, who, { requestId, note }));

const reqRow = async (id: string) =>
  (await sql<{ status: string; decided_by: string | null; created_item_id: string | null }[]>`
    select status, decided_by, created_item_id from item_requests where id = ${id}`)[0]!;
const itemRow = async (id: string) =>
  (await sql<{ name: string; expense_category_id: string | null; kind: string }[]>`
    select name, expense_category_id, kind from items where id = ${id}`)[0]!;
const itemCount = async (orgId: string) => Number((await sql<{ n: number }[]>`select count(*)::int as n from items where org_id = ${orgId}`)[0]!.n);

describe('S2 - an org admin (not super-admin) decides item requests', () => {
  it('an admin approves a manager request: the item exists, linked to the request, with the category copied', async () => {
    const w = await world('adm-ok');
    const r = await ask(w, w.manager);
    const out = await approve(w, w.admin, r.requestId);
    expect((await reqRow(r.requestId)).status).toBe('approved');
    expect((await reqRow(r.requestId)).decided_by).toBe(w.admin.personId);
    expect((await reqRow(r.requestId)).created_item_id).toBe(out.itemId);
    expect((await itemRow(out.itemId)).expense_category_id).toBe(w.categoryId);
  });

  it('an admin rejects a request (with a reason) and the request closes', async () => {
    const w = await world('adm-rej');
    const r = await ask(w, w.manager);
    await reject(w, w.admin, r.requestId);
    expect(await reqRow(r.requestId)).toMatchObject({ status: 'rejected', decided_by: w.admin.personId, created_item_id: null });
  });

  it('a super-admin still approves and rejects', async () => {
    const w = await world('adm-super');
    const a = await ask(w, w.manager);
    const b = await ask(w, w.manager);
    await approve(w, w.superAdmin, a.requestId);
    await reject(w, w.superAdmin, b.requestId);
    expect((await reqRow(a.requestId)).status).toBe('approved');
    expect((await reqRow(b.requestId)).status).toBe('rejected');
  });

  it('a requester cannot approve their own request (an admin asks, ANOTHER admin approves)', async () => {
    const w = await world('adm-self');
    const r = await ask(w, w.admin);
    const own = await approve(w, w.admin, r.requestId).then(() => null, (e: unknown) => e);
    expect(own).toBeInstanceOf(Error);
    expect((own as Error).message).toMatch(/own request|your own|someone else|another (admin|person)/i);
    expect((await reqRow(r.requestId)).status).toBe('requested');
    expect(await itemCount(w.orgId)).toBe(0);
    await approve(w, w.admin2, r.requestId);
    expect((await reqRow(r.requestId)).status).toBe('approved');
  });
});

describe('S2 x - the capability refuses manager and cashier, and writes nothing', () => {
  for (const [label, pick] of [
    ['manager', (w: World) => w.manager],
    ['cashier (staff)', (w: World) => w.cashier],
  ] as const) {
    it(`a ${label} cannot approve (AuthorizationError; request stays requested; no item)`, async () => {
      const w = await world(`x-app-${label[0]}`);
      const r = await ask(w, w.admin);
      await expect(approve(w, pick(w), r.requestId)).rejects.toBeInstanceOf(AuthorizationError);
      expect((await reqRow(r.requestId)).status).toBe('requested');
      expect(await itemCount(w.orgId)).toBe(0);
    });
    it(`a ${label} cannot reject (AuthorizationError; request stays requested)`, async () => {
      const w = await world(`x-rej-${label[0]}`);
      const r = await ask(w, w.admin);
      await expect(reject(w, pick(w), r.requestId)).rejects.toBeInstanceOf(AuthorizationError);
      expect((await reqRow(r.requestId)).status).toBe('requested');
    });
  }

  it('GUARD: an admin still cannot createItem or mergeItems directly (approve_item stays super-admin only)', async () => {
    const w = await world('x-guard');
    await expect(
      asOrg(w.orgId, (tx) => createItem(tx, w.admin, { code: testItemCode(), name: `Direct ${uid('d')}`, kind: 'supply', baseUnit: 'pcs' })),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      asOrg(w.orgId, (tx) => mergeItems(tx, w.admin, { loserId: w.categoryId, winnerId: w.categoryId })),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('S2 - the expense category on a request and on the item', () => {
  const PLAIN = /categor/i;
  const TECHNICAL = /violates|constraint|null value|not-null|23\d{3}|items_/i;

  it('approving a purchasable item with NO category is refused in plain words; request stays open; no item', async () => {
    const w = await world('cat-none');
    const r = await ask(w, w.manager, { expenseCategoryId: undefined });
    const err = await approve(w, w.admin, r.requestId).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(PLAIN);
    expect(err!.message).not.toMatch(TECHNICAL);
    expect((await reqRow(r.requestId)).status).toBe('requested');
    expect(await itemCount(w.orgId)).toBe(0);
  });

  it('a category typed at approval satisfies the rule, and is the one the item gets (overrides the request)', async () => {
    const w = await world('cat-override');
    const other = await w.category('Cleaning');
    const none = await ask(w, w.manager, { expenseCategoryId: undefined });
    const a = await approve(w, w.admin, none.requestId, { expenseCategoryId: other });
    expect((await itemRow(a.itemId)).expense_category_id).toBe(other);
    const some = await ask(w, w.manager);
    const b = await approve(w, w.admin, some.requestId, { expenseCategoryId: other });
    expect((await itemRow(b.itemId)).expense_category_id).toBe(other);
  });

  it('a NON-purchasable item may be approved without a category (the rule is for purchasable items)', async () => {
    const w = await world('cat-nonbuy');
    const r = await ask(w, w.manager, { expenseCategoryId: undefined, isPurchasable: false, sellableRetail: true, kind: 'retail', baseUnit: 'pcs' });
    const out = await approve(w, w.admin, r.requestId);
    expect((await itemRow(out.itemId)).expense_category_id).toBeNull();
  });

  it('a service item (always purchasable) also needs a category at approval', async () => {
    const w = await world('cat-svc');
    const r = await ask(w, w.manager, { kind: 'service', baseUnit: 'pcs', expenseCategoryId: undefined, name: `Internet ${uid('i')}` });
    const err = await approve(w, w.admin, r.requestId).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(PLAIN);
    const ok = await ask(w, w.manager, { kind: 'service', baseUnit: 'pcs', name: `Water ${uid('w')}` });
    const out = await approve(w, w.admin, ok.requestId);
    expect(await itemRow(out.itemId)).toMatchObject({ kind: 'service', expense_category_id: w.categoryId });
  });

  it('a category from ANOTHER org is refused at request time, in plain words', async () => {
    const a = await world('cat-xorg-a');
    const b = await world('cat-xorg-b');
    const err = await ask(a, a.manager, { expenseCategoryId: b.categoryId }).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(TECHNICAL);
  });

  it('a retired (inactive) category cannot be chosen for a new request', async () => {
    const w = await world('cat-retired');
    const dead = await w.category('Old');
    await sql`update expense_categories set is_active = false where id = ${dead}`;
    const err = await ask(w, w.manager, { expenseCategoryId: dead }).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
  });
});
