/**
 * T-502 S1.1 (TESTER, red until built) - "a service is NEVER stocked".
 * docs/tasks/502-expense-item-catalog.md section 4 S1 point 1 and section 5 ("A service is never counted").
 *
 * ## The reader census (grep of ITEM_KINDS / items.kind across packages/ and apps/, 31 Oct 2026)
 * Every stock/count/recipe/costing reader reaches an item through ONE of these doors, so the refusal is tested at the door,
 * not once per screen:
 *   door 1  stock_movements (the ledger).  Readers behind it: stock on hand, FIFO layers, count sessions (count-sessions.ts:257,335,345
 *           builds the count sheet FROM movements), cutover opening stock, usage/wastage posting, transfers, receipts, returns.
 *   door 2  production_recipes / production_recipe_lines (recipes + costing: production.ts:42,63; inventory/production/lib.ts).
 *   door 3  itemsRepo.listUsableItems (consume / move pickers: inventory/usage, inventory/transfers, production).
 *   door 4  kind -> account maps: INVENTORY_ACCOUNT_BY_ITEM_KIND (receipt-posting.ts) and cogsCategoryForItemKind (usage-records.ts:56).
 * The remaining pickers (commissary catalogue, deliveries, pos-map, trade orders, counts, recipes) call itemsRepo.listItems; they are
 * only CENSUSED (packages/domain/tests/t502-s1-service-readers.test.ts) because listItems has no "stocked only" option yet: the
 * builder adds one (or filters kind <> 'service' in each) and the tester extends door 3 to them in the next pass.
 *
 * Assumed contract (builder may change the mechanism, not the outcome): a service item is refused at the ledger and the recipe tables
 * by the DATABASE (trigger), per RULES 6.3 "the database enforces the rules". Red now: the service item cannot even be created
 * (items_kind_check); once S1 lands the refusals below must hold too. A control (non-service) row is inserted first in every test so
 * a green result proves the refusal is about the service kind, not about a malformed fixture.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_ROLE, itemsRepo, transaction, type Tx } from '@shareat/db';

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
const stemStart = Math.floor(Math.random() * 36 ** 4);
let codeN = 0;
const code = () => `${((stemStart + ++codeN * 7919) % 36 ** 4).toString(36).toUpperCase().padStart(4, '0')}-001`;

async function world(hint: string) {
  const c = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
  const orgId = o!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${s!.id}, 'KIT', 'Kitchen', ${lt!.id}, 'operating', true, ${p!.id}) returning id`;
  const mk = async (name: string, kind: string, baseUnit: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${code()}, ${`${name} ${uid('n')}`}, ${kind}, ${baseUnit}, ${p!.id}) returning id`;
    return r!.id;
  };
  return { orgId, personId: p!.id, storeId: s!.id, locationId: loc!.id, control: await mk('Charcoal', 'supply', 'kg'), service: await mk('Electricity', 'service', 'pcs'), mk };
}
type World = Awaited<ReturnType<typeof world>>;

async function failure(fn: () => PromiseLike<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message };
  }
}

const movement = (w: World, itemId: string, kind = 'receipt') =>
  sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${w.orgId}, ${w.storeId}, ${w.locationId}, ${itemId}, now(), 5, ${kind}, 'test', uuidv7(), ${w.personId}) returning id`;

describe('door 1 - the stock ledger refuses a service item', () => {
  for (const kind of ['receipt', 'usage', 'wastage', 'count_adjustment', 'manual_adjustment', 'opening'] as const) {
    it(`no ${kind} movement can name a service item (control item is accepted)`, async () => {
      const w = await world(`led-${kind}`);
      const [ok] = await movement(w, w.control, kind);
      expect(ok!.id).toBeTruthy();
      const bad = await failure(() => movement(w, w.service, kind));
      expect(bad).not.toBeNull();
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from stock_movements where item_id = ${w.service}`;
      expect(n!.n).toBe(0);
    });
  }
});

describe('door 2 - recipes and costing refuse a service item', () => {
  const recipe = (w: World, outputItemId: string) =>
    sql`insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
        values (${w.orgId}, ${uid('Recipe')}, ${outputItemId}, 1, ${w.personId}) returning id`;

  it('a service cannot be a recipe INPUT line (control line is accepted)', async () => {
    const w = await world('rec-in');
    const out = await w.mk('Sauce', 'raw_material', 'kg');
    const [r] = await recipe(w, out);
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${w.control}, 1, 'kg')`;
    const bad = await failure(
      () => sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${w.service}, 1, 'pcs')`,
    );
    expect(bad).not.toBeNull();
  });

  it('a service cannot be a recipe OUTPUT item', async () => {
    const w = await world('rec-out');
    const [ok] = await recipe(w, await w.mk('Sauce', 'raw_material', 'kg'));
    expect(ok!.id).toBeTruthy();
    expect(await failure(() => recipe(w, w.service))).not.toBeNull();
  });
});

describe('door 3 - the consume / move picker (listUsableItems) never offers a service', () => {
  it('offers the control supply and omits the active service item', async () => {
    const w = await world('usable');
    const asOrg = <T>(fn: (tx: Tx) => Promise<T>) =>
      transaction(async (tx) => {
        await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
        await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
        await tx.execute(dsql`select set_config('app.org_id', ${w.orgId}, true)`);
        return fn(tx);
      });
    const rows = await asOrg((tx) => itemsRepo.listUsableItems(tx, w.orgId, w.storeId));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(w.control);
    expect(ids).not.toContain(w.service);
  });
});
