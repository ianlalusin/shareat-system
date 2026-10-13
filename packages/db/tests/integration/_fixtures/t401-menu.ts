/**
 * T-401 S1 shared fixture (TESTER). Raw SQL, so the DATABASE is what is proven (migration 0196).
 * Assumes the column names in docs/tasks/401-erp-menu-catalog-master.md section 3. Every column a test
 * relies on is passed explicitly (no reliance on a default the spec does not state) except
 * `effective_from`, whose now() default is itself under test (I1b) and is relied on deliberately.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

import { APP_ROLE } from '../../../src/rls/registry';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

export const sql = postgres(url, { max: 5 });
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** items_code_shape_check (0192): 4 upper-case letters or digits, a dash, 3 digits, never 000. */
const itemCode = () => `${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'A')}-${String(1 + Math.floor(Math.random() * 998)).padStart(3, '0')}`;

export type PgErr = Error & { code?: string };

/** Resolves with the error the statement raised, or undefined when it was accepted. */
export async function refusal(fn: () => PromiseLike<unknown>): Promise<PgErr | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}

class Rollback extends Error {}

/** Run fn as shareat_app with app.org_id = org, in a transaction that is ALWAYS rolled back. */
export async function asApp<T>(org: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<{ err?: PgErr; value?: T }> {
  const out: { err?: PgErr; value?: T } = {};
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${APP_ROLE}`);
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      await tx`select set_config('app.org_id', ${org}, true)`;
      try {
        await tx.savepoint(async (sp) => {
          out.value = await fn(sp as unknown as postgres.TransactionSql);
        });
      } catch (e) {
        out.err = e as PgErr;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

export type MenuFx = Awaited<ReturnType<typeof menuFixture>>;

/** One org: two stores, a person, a stock item and recipe, a category, and an a_la_carte item with its default variant. */
export async function menuFixture(hint: string) {
  const code = uid(`t401-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
  const [store2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Batangas') returning id`;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const personId = person!.id;
  const [stock] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${itemCode()}, ${uid('Pork')}, 'raw_material', 'kg', ${personId}) returning id`;
  const [recipe] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
    values (${orgId}, ${uid('Rec')}, ${stock!.id}, 1, ${personId}) returning id`;
  const [cat] = await sql<{ id: string }[]>`
    insert into menu_categories (org_id, name, sort_order, status, created_by)
    values (${orgId}, ${uid('Cat')}, 0, 'active', ${personId}) returning id`;
  const fx = { orgId, storeId: store!.id, store2Id: store2!.id, personId, stockItemId: stock!.id, recipeId: recipe!.id, categoryId: cat!.id };
  const item = await newItem(fx, 'a_la_carte');
  return { ...fx, itemId: item.itemId, variantId: item.variantId };
}

type Base = { orgId: string; personId: string; categoryId: string };

/** A menu item plus its default variant. A refill is never sold a la carte (R2). */
export async function newItem(f: Base, itemType: 'a_la_carte' | 'package' | 'refill', name?: string) {
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${f.orgId}, ${f.categoryId}, ${name ?? uid('Item')}, ${itemType}, ${itemType === 'a_la_carte'}, false, true, 0, 'active', ${f.personId})
    returning id`;
  const [variant] = await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
    values (${f.orgId}, ${item!.id}, null, true, 0, 'active', ${f.personId}) returning id`;
  return { itemId: item!.id, variantId: variant!.id };
}

type Who = { orgId: string; personId: string };

/** A direct depletion rule; `at` is an interval offset from now(), or null for the column default (now()). */
export const insRule = (f: Who & { stockItemId: string }, variantId: string, at: string | null = null) =>
  at === null
    ? sql`insert into menu_depletion_rules (org_id, variant_id, mode, item_id, quantity_per_sale, created_by)
          values (${f.orgId}, ${variantId}, 'direct', ${f.stockItemId}, 0.2, ${f.personId}) returning id`
    : sql`insert into menu_depletion_rules (org_id, variant_id, effective_from, mode, item_id, quantity_per_sale, created_by)
          values (${f.orgId}, ${variantId}, now() + ${at}::interval, 'direct', ${f.stockItemId}, 0.2, ${f.personId}) returning id`;

/** A live price offer; `at` as insRule. */
export const insOffer = (f: Who & { storeId: string }, variantId: string, amount: string | number | null, at: string | null = null, channel = 'store') =>
  at === null
    ? sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by)
          values (${f.orgId}, ${f.storeId}, ${variantId}, ${channel}, ${amount}, false, ${f.personId}) returning id`
    : sql`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, amount, withdrawn, created_by)
          values (${f.orgId}, ${f.storeId}, ${variantId}, ${channel}, now() + ${at}::interval, ${amount}, false, ${f.personId}) returning id`;

export const insWithdrawn = (f: Who & { storeId: string }, variantId: string, at: string | null = null) =>
  at === null
    ? sql`insert into menu_offers (org_id, store_id, variant_id, channel, withdrawn, created_by)
          values (${f.orgId}, ${f.storeId}, ${variantId}, 'store', true, ${f.personId}) returning id`
    : sql`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, withdrawn, created_by)
          values (${f.orgId}, ${f.storeId}, ${variantId}, 'store', now() + ${at}::interval, true, ${f.personId}) returning id`;

/** An option group with one value. */
export async function newOption(f: Who) {
  const [g] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
    values (${f.orgId}, ${uid('Grp')}, 'single', 1, 1, 'active', ${f.personId}) returning id`;
  const [v] = await sql<{ id: string }[]>`
    insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by)
    values (${f.orgId}, ${g!.id}, ${uid('Val')}, 0, 'active', ${f.personId}) returning id`;
  return { groupId: g!.id, valueId: v!.id };
}

export const insOptionOffer = (f: Who & { storeId: string }, valueId: string, delta: string | number | null, at: string | null = null, channel = 'store') =>
  at === null
    ? sql`insert into menu_option_offers (org_id, store_id, option_value_id, channel, price_delta, withdrawn, created_by)
          values (${f.orgId}, ${f.storeId}, ${valueId}, ${channel}, ${delta}, false, ${f.personId}) returning id`
    : sql`insert into menu_option_offers (org_id, store_id, option_value_id, channel, effective_from, price_delta, withdrawn, created_by)
          values (${f.orgId}, ${f.storeId}, ${valueId}, ${channel}, now() + ${at}::interval, ${delta}, false, ${f.personId}) returning id`;
