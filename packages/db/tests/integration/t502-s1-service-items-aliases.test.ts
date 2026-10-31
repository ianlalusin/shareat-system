/**
 * T-502 S1 (TESTER, red until built) - docs/tasks/502-expense-item-catalog.md section 4 S1.
 * Real Postgres, any `*_test` database (never pinned to a lane DB).
 *
 * Contract under test (migration 0224, hand-authored):
 *   1. items.kind accepts 'service' (items_kind_check widened). A service item is base_unit 'pcs', purchasable, never sold.
 *   2. items.expense_category_id uuid NULL -> expense_categories, SAME-ORG composite FK (cross-org id refused with 23503).
 *   3. item_aliases (id, org_id, item_id, alias, created_by, created_at):
 *        unique (org_id, lower(trim(alias)));  alias may not equal any item NAME in the org (trigger or check);
 *        same-org composite FKs (cross-org item refused); RLS by org (the app role sees only its own org).
 *
 * Assumptions a builder may legitimately change (tell the tester): the service-shape rules in S1.1b are written
 * as DB refusals; if the builder chooses domain-only enforcement those tests move to the domain suite.
 * Red now: the first insert of a kind 'service' item fails items_kind_check; every alias test fails
 * "relation item_aliases does not exist".
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { ITEM_KINDS, itemKindLabel } from '@shareat/db/schema';

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
// Item-code shape: 4 alphanumerics, dash, 3 digits, never 000. A fresh stem per call (36^4 space, stepped by a prime).
const stemStart = Math.floor(Math.random() * 36 ** 4);
let codeN = 0;
const code = () => `${((stemStart + ++codeN * 7919) % 36 ** 4).toString(36).toUpperCase().padStart(4, '0')}-001`;

async function org(hint: string) {
  const c = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Admin') returning id`;
  const [cat] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category) values (${o!.id}, 'OPEX', ${`Utilities ${c}`}) returning id`;
  return { orgId: o!.id, personId: p!.id, categoryId: cat!.id };
}
type Org = Awaited<ReturnType<typeof org>>;

const item = async (o: Org, name: string, kind = 'supply', baseUnit = 'pcs') => {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${o.orgId}, ${code()}, ${name}, ${kind}, ${baseUnit}, ${o.personId}) returning id`;
  return r!.id;
};

/** Run `fn` and return the Postgres SQLSTATE it failed with, or null if it succeeded. */
async function sqlstate(fn: () => PromiseLike<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const state = (e as { code?: string }).code;
    return state ?? `non-pg-error: ${(e as Error).message}`;
  }
}

describe('S1.1 - the service kind', () => {
  it('ITEM_KINDS includes service and its label is "Service"', () => {
    expect(ITEM_KINDS as readonly string[]).toContain('service');
    expect(itemKindLabel('service')).toBe('Service');
  });

  it('an item of kind service can be created (base unit pcs, purchasable, not sold)', async () => {
    const o = await org('svc');
    const id = await item(o, `Electricity ${uid('e')}`, 'service', 'pcs');
    const [row] = await sql`select kind, base_unit, is_purchasable, sellable_retail, sellable_wholesale from items where id = ${id}`;
    expect(row).toMatchObject({ kind: 'service', base_unit: 'pcs', is_purchasable: true, sellable_retail: false, sellable_wholesale: false });
  });
});

describe('S1.1b - a service is never sold, always "each", always purchasable (assumed DB rule)', () => {
  it('refuses a service whose base unit is not pcs', async () => {
    const o = await org('svc-unit');
    await item(o, `Valid service ${uid('v')}`, 'service', 'pcs'); // precondition: a valid service exists, so the refusal below is about the RULE, not the unknown kind
    expect(await sqlstate(() => item(o, `Water ${uid('w')}`, 'service', 'kg'))).toBe('23514');
  });
  it('refuses a service marked sellable at retail', async () => {
    const o = await org('svc-retail');
    await item(o, `Valid service ${uid('v')}`, 'service', 'pcs'); // precondition: a valid service exists, so the refusal below is about the RULE, not the unknown kind
    const state = await sqlstate(
      () => sql`insert into items (org_id, code, name, kind, base_unit, sellable_retail, created_by)
                values (${o.orgId}, ${code()}, ${`Rent ${uid('r')}`}, 'service', 'pcs', true, ${o.personId})`,
    );
    expect(state).toBe('23514');
  });
  it('refuses a service marked sellable wholesale', async () => {
    const o = await org('svc-whole');
    await item(o, `Valid service ${uid('v')}`, 'service', 'pcs'); // precondition: a valid service exists, so the refusal below is about the RULE, not the unknown kind
    const state = await sqlstate(
      () => sql`insert into items (org_id, code, name, kind, base_unit, sellable_wholesale, created_by)
                values (${o.orgId}, ${code()}, ${`Rent ${uid('r')}`}, 'service', 'pcs', true, ${o.personId})`,
    );
    expect(state).toBe('23514');
  });
  it('refuses a service that is not purchasable', async () => {
    const o = await org('svc-buy');
    await item(o, `Valid service ${uid('v')}`, 'service', 'pcs'); // precondition: a valid service exists, so the refusal below is about the RULE, not the unknown kind
    const state = await sqlstate(
      () => sql`insert into items (org_id, code, name, kind, base_unit, is_purchasable, created_by)
                values (${o.orgId}, ${code()}, ${`Rent ${uid('r')}`}, 'service', 'pcs', false, ${o.personId})`,
    );
    expect(state).toBe('23514');
  });
});

describe('S1.2 - items.expense_category_id', () => {
  it('the column exists and is nullable (existing rows stay NULL)', async () => {
    const [col] = await sql<{ is_nullable: string; data_type: string }[]>`
      select is_nullable, data_type from information_schema.columns
      where table_name = 'items' and column_name = 'expense_category_id'`;
    expect(col).toMatchObject({ is_nullable: 'YES', data_type: 'uuid' });
    const o = await org('cat-null');
    const id = await item(o, `Plain ${uid('p')}`);
    const [row] = await sql`select expense_category_id from items where id = ${id}`;
    expect(row!.expense_category_id).toBeNull();
  });

  it('accepts a category of the same org', async () => {
    const o = await org('cat-ok');
    const id = await item(o, `Soap ${uid('s')}`);
    await sql`update items set expense_category_id = ${o.categoryId} where id = ${id}`;
    const [row] = await sql`select expense_category_id from items where id = ${id}`;
    expect(row!.expense_category_id).toBe(o.categoryId);
  });

  it('refuses a category from ANOTHER org (same-org composite FK, 23503)', async () => {
    const a = await org('cat-a');
    const b = await org('cat-b');
    const id = await item(a, `Soap ${uid('s')}`);
    const state = await sqlstate(() => sql`update items set expense_category_id = ${b.categoryId} where id = ${id}`);
    expect(state).toBe('23503');
    const [row] = await sql`select expense_category_id from items where id = ${id}`;
    expect(row!.expense_category_id).toBeNull();
  });

  it('the cross-org guard is a composite (org_id, expense_category_id) FK, not a single-column one', async () => {
    const rows = await sql<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'items'::regclass and contype = 'f' and pg_get_constraintdef(oid) ilike '%expense_categories%'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.def).toMatch(/FOREIGN KEY \(org_id, expense_category_id\)/);
  });
});

describe('S1.3 - item_aliases', () => {
  const alias = (o: Org, itemId: string, text: string) =>
    sql`insert into item_aliases (org_id, item_id, alias, created_by) values (${o.orgId}, ${itemId}, ${text}, ${o.personId}) returning id`;

  it('adds an alias to an item', async () => {
    const o = await org('al-ok');
    const id = await item(o, `Siling Labuyo ${uid('x')}`);
    const [a] = await alias(o, id, 'chili');
    expect(a!.id).toBeTruthy();
    const [row] = await sql`select org_id, item_id, alias, created_by, created_at from item_aliases where id = ${a!.id}`;
    expect(row).toMatchObject({ org_id: o.orgId, item_id: id, alias: 'chili', created_by: o.personId });
    expect(row!.created_at).toBeInstanceOf(Date);
  });

  it('refuses a duplicate alias that differs only in case or surrounding spaces (23505), even on another item', async () => {
    const o = await org('al-dup');
    const one = await item(o, `Siling Labuyo ${uid('x')}`);
    const two = await item(o, `Bell Pepper ${uid('y')}`);
    await alias(o, one, 'chili');
    for (const dup of ['CHILI', '  chili  ', 'Chili']) {
      expect(await sqlstate(() => alias(o, two, dup))).toBe('23505');
    }
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from item_aliases where org_id = ${o.orgId}`;
    expect(n!.n).toBe(1);
  });

  it('the same alias text is allowed in a different org', async () => {
    const a = await org('al-iso-a');
    const b = await org('al-iso-b');
    await alias(a, await item(a, `Chili ${uid('x')}`), 'sili');
    await alias(b, await item(b, `Chili ${uid('y')}`), 'sili');
  });

  it('refuses an alias equal to an existing item NAME in the same org (case/space-insensitive)', async () => {
    const o = await org('al-name');
    const target = await item(o, 'Pork Belly');
    await item(o, 'Bacon');
    for (const clash of ['Bacon', 'bacon', '  BACON ']) {
      expect(await sqlstate(() => alias(o, target, clash))).not.toBeNull();
    }
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from item_aliases where org_id = ${o.orgId}`;
    expect(n!.n).toBe(0);
  });

  it('an alias equal to an item name of ANOTHER org is fine (names are per org)', async () => {
    const a = await org('al-name-a');
    const b = await org('al-name-b');
    await item(a, 'Bacon');
    await alias(b, await item(b, 'Pork Belly'), 'Bacon');
  });

  it('refuses an item from another org (same-org composite FK, 23503)', async () => {
    const a = await org('al-x-a');
    const b = await org('al-x-b');
    const foreign = await item(b, `Chili ${uid('f')}`);
    expect(await sqlstate(() => alias(a, foreign, 'sili'))).toBe('23503');
  });

  it('refuses created_by from another org (same-org composite FK, 23503)', async () => {
    const a = await org('al-p-a');
    const b = await org('al-p-b');
    const id = await item(a, `Chili ${uid('c')}`);
    const state = await sqlstate(
      () => sql`insert into item_aliases (org_id, item_id, alias, created_by) values (${a.orgId}, ${id}, 'sili', ${b.personId})`,
    );
    expect(state).toBe('23503');
  });

  it('refuses a blank alias (23514)', async () => {
    const o = await org('al-blank');
    const id = await item(o, `Chili ${uid('c')}`);
    for (const blank of ['', '   ']) expect(await sqlstate(() => alias(o, id, blank))).toBe('23514');
  });

  it('RLS: the app role in org B sees none of org A aliases, and cannot insert one for org A', async () => {
    const a = await org('al-rls-a');
    const b = await org('al-rls-b');
    const ia = await item(a, `Chili ${uid('a')}`);
    const ib = await item(b, `Garlic ${uid('b')}`);
    await alias(a, ia, 'sili');
    await alias(b, ib, 'bawang');
    const asOrg = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) =>
      transaction(async (tx) => {
        await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
        await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
        await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
        return fn(tx);
      });
    const seen = await asOrg(b.orgId, async (tx) => (await tx.execute(dsql`select alias, org_id from item_aliases`)) as unknown as { alias: string; org_id: string }[]);
    expect([...seen].map((r) => r.alias)).toEqual(['bawang']);
    await expect(
      asOrg(b.orgId, (tx) => tx.execute(dsql`insert into item_aliases (org_id, item_id, alias, created_by) values (${a.orgId}, ${ia}, 'spy', ${a.personId})`)),
    ).rejects.toThrow();
  });

  it('the unique index on (org_id, lower(trim(alias))) exists', async () => {
    const [idx] = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes
      where tablename = 'item_aliases' and indexdef ilike '%unique%' and indexdef ilike '%lower%' and indexdef ilike '%trim%'`;
    expect(idx).toBeTruthy();
    expect(idx!.def).toMatch(/org_id/);
  });

  // Spec gap, proposed: the mirror image of "alias != item name". If an item may be created or renamed to a name that an
  // alias already uses, the picker has two answers for one word. Decide in the spec, then turn this into a real test.
  it.todo('PROPOSED: creating or renaming an item to a name an alias already uses is refused');
});
