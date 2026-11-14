/**
 * T-502 section 11 (Ian, 1 Nov: "yes"): sub-categories, set on the item. Real Postgres, any `*_test` database.
 * Contract: expense_subcategories (unique per category ignoring case/space; vague names refused; same-org FKs; RLS); items and item_requests
 * carry expense_subcategory_id whose category must equal the row's expense_category_id (trigger); an admin manages the list
 * (manage_chart_of_accounts); approval REQUIRES a sub-category when the chosen category has an active one, and is optional otherwise.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError, type Actor } from '@shareat/auth';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import {
  approveItemRequest,
  createSubcategory,
  renameSubcategory,
  requestItem,
  setItemExpenseCategory,
  setSubcategoryActive,
} from '@shareat/domain';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error('Refusing to run: database name must contain "_test".');
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const code = ((s) => () => `${((s + ++seq * 7919) % 36 ** 4).toString(36).toUpperCase().padStart(4, '0')}-001`)(Math.floor(Math.random() * 36 ** 4));

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
  const person = async (name: string, role: string): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return { personId: p!.id, orgId };
  };
  const cat = async (label: string) =>
    (await sql<{ id: string }[]>`insert into expense_categories (org_id, "group", category) values (${orgId}, 'COGS', ${`${label} ${c}`}) returning id`)[0]!.id;
  const admin = await person('Admin', 'admin');
  const admin2 = await person('Admin Two', 'admin');
  const manager = await person('Manager', 'manager');
  const meat = await cat('Meat');
  const sides = await cat('Sides');
  const sub = async (categoryId: string, name: string) =>
    (await sql<{ id: string }[]>`insert into expense_subcategories (org_id, category_id, name, created_by) values (${orgId}, ${categoryId}, ${name}, ${admin.personId}) returning id`)[0]!.id;
  const item = async (name: string, over: { categoryId?: string; subId?: string } = {}) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id, expense_subcategory_id)
      values (${orgId}, ${code()}, ${name}, 'supply', 'pcs', ${admin.personId}, ${over.categoryId ?? null}, ${over.subId ?? null}) returning id`)[0]!.id;
  return { orgId, admin, admin2, manager, meat, sides, sub, item, cat };
}
type W = Awaited<ReturnType<typeof world>>;

async function constraintOf(fn: () => PromiseLike<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { constraint_name?: string }).constraint_name ?? `other:${(e as Error).message}`;
  }
}

describe('database: expense_subcategories', () => {
  it('one name per category ignoring case and spaces; the same name under another category is fine', async () => {
    const w = await world('db-uniq');
    await w.sub(w.meat, 'Pork');
    expect(await constraintOf(() => w.sub(w.meat, '  PORK '))).toBe('expense_subcategories_org_name_key');
    await w.sub(w.sides, 'Pork');
  });

  it('refuses vague names (please specify / specify / other / others), any case or spacing', async () => {
    const w = await world('db-vague');
    for (const bad of ['Please Specify', 'specify', ' OTHER ', 'Others']) {
      expect(await constraintOf(() => w.sub(w.meat, bad))).toBe('expense_subcategories_name_not_vague_check');
    }
    expect(await constraintOf(() => w.sub(w.meat, '   '))).not.toBeNull();
    await w.sub(w.meat, 'Other cuts'); // only the bare words are refused
  });

  it('refuses a category of another org (same-org composite FK)', async () => {
    const a = await world('db-xa');
    const b = await world('db-xb');
    expect(await constraintOf(() => a.sub(b.meat, 'Pork'))).toBe('expense_subcategories_category_same_org_fk');
  });

  it('RLS: the app role sees only its own org sub-categories', async () => {
    const a = await world('db-rls-a');
    const b = await world('db-rls-b');
    await a.sub(a.meat, 'Pork');
    await b.sub(b.meat, 'Beef');
    const seen = await asOrg(b.orgId, async (tx) => (await tx.execute(dsql`select name from expense_subcategories`)) as unknown as { name: string }[]);
    expect([...seen].map((r) => r.name)).toEqual(['Beef']);
  });

  it('an item or a request cannot carry a sub-category of a different category (trigger)', async () => {
    const w = await world('db-trg');
    const pork = await w.sub(w.meat, 'Pork');
    await w.item('Pork belly', { categoryId: w.meat, subId: pork });
    expect(await constraintOf(() => w.item('Bad one', { categoryId: w.sides, subId: pork }))).toBe('items_subcategory_matches_category');
    expect(await constraintOf(() => w.item('No category', { subId: pork }))).toBe('items_subcategory_matches_category');
    const asked = (cat: string) => sql`
      insert into item_requests (org_id, name, code, kind, base_unit, expense_category_id, expense_subcategory_id, requested_by)
      values (${w.orgId}, ${uid('n')}, ${uid('C')}, 'supply', 'pcs', ${cat}, ${pork}, ${w.admin.personId})`;
    await asked(w.meat);
    expect(await constraintOf(() => asked(w.sides))).toBe('items_subcategory_matches_category');
  });
});

describe('domain: managing sub-categories (manage_chart_of_accounts)', () => {
  it('an admin adds, renames and retires; the manager is refused; a duplicate and a vague name are refused in plain words', async () => {
    const w = await world('dm-mgr');
    const { subcategoryId } = await asOrg(w.orgId, (tx) => createSubcategory(tx, w.admin, { categoryId: w.meat, name: 'Pork' }));
    await expect(asOrg(w.orgId, (tx) => createSubcategory(tx, w.manager, { categoryId: w.meat, name: 'Beef' }))).rejects.toBeInstanceOf(AuthorizationError);
    const dupe = await asOrg(w.orgId, (tx) => createSubcategory(tx, w.admin, { categoryId: w.meat, name: ' pork ' })).then(() => null, (e: Error) => e);
    expect(dupe!.message).toMatch(/already/i);
    expect(dupe!.message).not.toMatch(/violates|constraint|expense_/i);
    const vague = await asOrg(w.orgId, (tx) => createSubcategory(tx, w.admin, { categoryId: w.meat, name: 'Others' })).then(() => null, (e: Error) => e);
    expect(vague!.message).toMatch(/specific|name/i);
    expect(vague!.message).not.toMatch(/violates|constraint|expense_/i);
    await asOrg(w.orgId, (tx) => renameSubcategory(tx, w.admin, { subcategoryId, name: 'Pork cuts' }));
    await asOrg(w.orgId, (tx) => setSubcategoryActive(tx, w.admin, { subcategoryId, isActive: false }));
    const [row] = await sql`select name, is_active from expense_subcategories where id = ${subcategoryId}`;
    expect(row).toMatchObject({ name: 'Pork cuts', is_active: false });
    const audited = await sql`select action from audit_log where org_id = ${w.orgId} and entity_id = ${subcategoryId} order by recorded_at`;
    expect(audited.length).toBe(3);
  });
});

describe('domain: approval needs a sub-category when the category has one', () => {
  const ask = (w: W, over: Record<string, unknown> = {}) =>
    asOrg(w.orgId, (tx) => requestItem(tx, w.manager, { name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', expenseCategoryId: w.meat, ...over } as never));
  const approve = (w: W, requestId: string, over: Record<string, unknown> = {}) =>
    asOrg(w.orgId, (tx) => approveItemRequest(tx, w.admin, { requestId, ...over } as never));
  const itemSub = async (id: string) => (await sql<{ s: string | null }[]>`select expense_subcategory_id as s from items where id = ${id}`)[0]!.s;

  it('a category with NO sub-category: approval works without one', async () => {
    const w = await world('ap-none');
    const r = await ask(w);
    const out = await approve(w, r.requestId);
    expect(await itemSub(out.itemId)).toBeNull();
  });

  it('a category WITH an active sub-category: refused without one (plain), allowed with it, and the item gets it', async () => {
    const w = await world('ap-req');
    const pork = await w.sub(w.meat, 'Pork');
    const r = await ask(w);
    const err = await approve(w, r.requestId).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/sub-category/i);
    expect(err!.message).not.toMatch(/violates|constraint|expense_/i);
    expect((await sql`select status from item_requests where id = ${r.requestId}`)[0]!.status).toBe('requested');
    const out = await approve(w, r.requestId, { expenseSubcategoryId: pork });
    expect(await itemSub(out.itemId)).toBe(pork);
  });

  it('the request carries its sub-category to the item', async () => {
    const w = await world('ap-carry');
    const pork = await w.sub(w.meat, 'Pork');
    const r = await ask(w, { expenseSubcategoryId: pork });
    expect(await itemSub((await approve(w, r.requestId)).itemId)).toBe(pork);
  });

  it('a retired sub-category does not count, and cannot be chosen', async () => {
    const w = await world('ap-retired');
    const old = await w.sub(w.meat, 'Old');
    await sql`update expense_subcategories set is_active = false where id = ${old}`;
    const r = await ask(w);
    await approve(w, r.requestId); // no ACTIVE sub-category: optional
    const bad = await ask(w, { expenseSubcategoryId: old }).then(() => null, (e: Error) => e);
    expect(bad).toBeInstanceOf(Error);
  });

  it('a sub-category of another category is refused in plain words, at request and at approval', async () => {
    const w = await world('ap-mismatch');
    const pork = await w.sub(w.meat, 'Pork');
    await w.sub(w.sides, 'Greens');
    const bad = await ask(w, { expenseCategoryId: w.sides, expenseSubcategoryId: pork }).then(() => null, (e: Error) => e);
    expect(bad!.message).toMatch(/sub-category/i);
    expect(bad!.message).not.toMatch(/violates|constraint|expense_|items_/i);
    const r = await ask(w, { expenseCategoryId: w.sides });
    const err = await approve(w, r.requestId, { expenseSubcategoryId: pork }).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/sub-category/i);
  });

  it('changing the category at approval drops a sub-category that belongs to the old one, then requires one of the new', async () => {
    const w = await world('ap-switch');
    const pork = await w.sub(w.meat, 'Pork');
    const greens = await w.sub(w.sides, 'Greens');
    const r = await ask(w, { expenseSubcategoryId: pork });
    const err = await approve(w, r.requestId, { expenseCategoryId: w.sides }).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/sub-category/i);
    const out = await approve(w, r.requestId, { expenseCategoryId: w.sides, expenseSubcategoryId: greens });
    expect(await itemSub(out.itemId)).toBe(greens);
  });
});

describe('domain: the item page sets category and sub-category together', () => {
  it('requires the sub-category when the new category has one; clears it when the category changes to one without', async () => {
    const w = await world('it-set');
    const pork = await w.sub(w.meat, 'Pork');
    const id = await w.item('Pork belly', { categoryId: w.meat, subId: pork });
    const err = await asOrg(w.orgId, (tx) => setItemExpenseCategory(tx, w.admin, { itemId: id, expenseCategoryId: w.meat, expenseSubcategoryId: null })).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/sub-category/i);
    const other = await w.cat('Packaging');
    await asOrg(w.orgId, (tx) => setItemExpenseCategory(tx, w.admin, { itemId: id, expenseCategoryId: other, expenseSubcategoryId: null }));
    const [row] = await sql`select expense_category_id, expense_subcategory_id from items where id = ${id}`;
    expect(row).toMatchObject({ expense_category_id: other, expense_subcategory_id: null });
  });
});
