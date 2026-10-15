import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createProductionDraft, createRecipe } from '@shareat/domain';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-409 audit round, orchestrator rulings R-A, R-C, R-D (domain half). TESTER.
 * R-A: recipe output is in the output item's base unit; a non-positive or absurd (> 10,000) output is refused.
 * R-C: a recipeId on a slice / convert draft is refused with a sentence, never a raw DB error.
 * R-D: a cook whose scaled ingredient rounds to 0.000 is refused at DRAFT, naming the ingredient.
 * (editRecipe does not exist on HEAD: createRecipe is the only recipe write.)
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test/.test(url)) throw new Error('Refusing to run: the database name must contain "shareat_test".');
const sql = postgres(url, { max: 5 });
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

let orgA: string, storeA: string, adminId: string, kitchen: string;
let admin: Actor;
let slab: string, sliced: string, soup: string, saffron: string, flour: string, recipeId: string;
const item = async (name: string, kind: string, parent: string | null = null) => {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
    values (${orgA}, ${testItemCode()}, ${name}, ${kind}, 'kg', ${parent}, ${adminId}) returning id`;
  return r!.id;
};

beforeEach(async () => {
  await sql`
    truncate table production_record_lines, production_records, production_recipe_lines, production_recipes,
      stock_locations, location_types, person_store_scope, person_roles, audit_log, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [m] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Admin') returning id`;
  adminId = m!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgA}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeA})`;
  admin = { personId: adminId, orgId: orgA };
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Kitchen type') returning id`;
  const [l] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${adminId}) returning id`;
  kitchen = l!.id;
  slab = await item('Beef Slab', 'meat_slab');
  sliced = await item('Beef Sliced', 'meat_sliced', slab);
  soup = await item('Soup', 'raw_material');
  flour = await item('Flour', 'raw_material');
  saffron = await item('Saffron', 'raw_material');
  // 2 kg Soup from 1 kg Flour + 1 g Saffron (0.001 kg).
  const [rec] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
    values (${orgA}, 'Soup', ${soup}, 2, ${adminId}) returning id`;
  recipeId = rec!.id;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipeId}, ${flour}, 1, 'kg'), (${recipeId}, ${saffron}, 1, 'g')`;
});

const recipeCount = async () => Number((await sql<{ n: string }[]>`select count(*)::text n from production_recipes`)[0]!.n);
const recordCount = async () => Number((await sql<{ n: string }[]>`select count(*)::text n from production_records`)[0]!.n);
const mkRecipe = (outputQuantity: string) =>
  asOrg(orgA, (tx) => createRecipe(tx, admin, {
    orgId: orgA, name: `R ${outputQuantity}`, outputItemId: soup, outputQuantity,
    lines: [{ itemId: flour, quantity: '1', unit: 'kg' }],
  }));
const draft = (over: Record<string, unknown>) =>
  asOrg(orgA, (tx) => createProductionDraft(tx, admin, {
    orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10', labourCost: '0',
    inputs: [{ itemId: slab, quantity: '10', unit: 'kg' }], outputs: [{ itemId: sliced, quantity: '9', unit: 'kg' }], ...over,
  } as Parameters<typeof createProductionDraft>[2]));

describe('R-A - recipe output quantity is sane, in the output item base unit', () => {
  it('control: 2 and exactly 10000 are accepted', async () => {
    expect((await mkRecipe('2')).ok).toBe(true);
    expect((await mkRecipe('10000')).ok).toBe(true);
  });
  for (const bad of ['0', '-1', '10000.001', '10001', '5000000']) {
    it(`output ${bad} is refused with a sentence and no row. Mutant: upper bound dropped`, async () => {
      const before = await recipeCount();
      const r = await mkRecipe(bad);
      expect(r.ok, `output ${bad} was accepted`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/output/i);
      expect(await recipeCount()).toBe(before);
    });
  }
  it('the refusal for an absurd output names the base unit (kg), so the cook knows what the limit is in. Mutant: generic sentence', async () => {
    const r = await mkRecipe('50000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/kg|base unit/i);
  });
});

describe('R-C - a recipeId on a slice or convert draft is a sentence, not a DB error', () => {
  for (const kind of ['slice', 'convert'] as const) {
    it(`${kind} + recipeId -> ok:false with a recipe sentence; zero rows. Mutant: recipeId passed through to the insert`, async () => {
      const over: Record<string, unknown> = { kind, recipeId };
      if (kind === 'convert') {
        const sl2 = await item('Beef Sliced 2', 'meat_sliced', slab);
        over.inputs = [{ itemId: sliced, quantity: '5', unit: 'kg' }];
        over.outputs = [{ itemId: sl2, quantity: '5', unit: 'kg' }];
      }
      const r = await draft(over).catch((e: unknown) => { throw new Error(`threw instead of refusing: ${String(e)}`); });
      expect(r.ok, 'a recipeId on a non-cook was accepted').toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/recipe/i);
        expect(r.reason).not.toMatch(/constraint|violates|check_|SQLSTATE|23\d{3}/i);
      }
      expect(await recordCount()).toBe(0);
    });
  }
});

describe('R-D - a cook whose scaled ingredient rounds to 0.000 is refused at draft', () => {
  it('control: cook 2 kg -> Flour 1.000, Saffron 0.001 -> accepted', async () => {
    const r = await draft({ kind: 'cook', recipeId, inputs: [], outputs: [{ itemId: soup, quantity: '2', unit: 'kg' }] });
    expect(r.ok).toBe(true);
  });
  it('cook 0.1 kg -> Saffron 0.00005 kg rounds to 0.000 -> refused naming Saffron; zero rows. Mutant: zero-quantity line stored', async () => {
    const r = await draft({ kind: 'cook', recipeId, inputs: [], outputs: [{ itemId: soup, quantity: '0.1', unit: 'kg' }] });
    expect(r.ok, 'a 0.000 ingredient line was drafted').toBe(false);
    if (!r.ok) expect(r.reason).toContain('Saffron');
    expect(await recordCount()).toBe(0);
  });
});
