import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createProductionDraft, editPostedProduction, postProduction } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-409 S1 (integration half) - invariants 3, 5, 6, 7, 8, 9 (+ 1, 2, 4 reaching the real draft / post / edit doors).
 * `docs/tasks/409-production-slice-pickers.md` R1-R3. Built with Q1 = (a) block, Q2 = (a).
 *
 * TESTER. Every refusal leg is red on HEAD because HEAD accepts the run (no category rule, no recipe rule, no re-derivation);
 * the cook legs that expect a DRAFT to succeed with no typed inputs are red because HEAD says "a production run needs at
 * least one input". Controls (the everyday slice, a lineage-mismatch slice) are green on HEAD - they prove the fixture works, so a red
 * refusal leg is red for the rule, not for a broken fixture.
 *
 * Fixture: slab 'Beef Slab' (kg), sliced 'Beef Sliced' (kg, parent = slab), 'Pork Sliced' (parent = another slab), raw items
 * 'Flour' / 'Stock' (kg) for cooks, cooked output 'Soup' (kg). Recipe 'Soup': 2 kg out from 500 g Flour + 1.5 kg Stock.
 * Recipes are inserted by SQL (their config is T-403's, not under test). Everything acts as a manager.
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

let orgA: string, storeA: string, managerId: string, fileA: string, kitchen: string;
let manager: Actor;
let slab: string, sliced: string, porkSlab: string, porkSliced: string;
let flour: string, stock: string, soup: string, otherDish: string;
let recipeId: string;

const locations = (): LocationLike[] => [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];
const item = async (name: string, kind: string, parent: string | null = null) => {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
    values (${orgA}, ${testItemCode()}, ${name}, ${kind}, 'kg', ${parent}, ${managerId}) returning id`;
  return r!.id;
};

beforeEach(async () => {
  await sql`
    truncate table
      production_record_lines, production_records, production_recipe_lines, production_recipes,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types,
      person_store_scope, person_roles,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [m] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Manager') returning id`;
  managerId = m!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgA}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeA})`;
  manager = { personId: managerId, orgId: orgA };
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Kitchen type') returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${managerId}) returning id`;
  kitchen = r2!.id;

  slab = await item('Beef Slab', 'meat_slab');
  sliced = await item('Beef Sliced', 'meat_sliced', slab);
  porkSlab = await item('Pork Slab', 'meat_slab');
  porkSliced = await item('Pork Sliced', 'meat_sliced', porkSlab);
  flour = await item('Flour', 'raw_material');
  stock = await item('Stock', 'raw_material');
  soup = await item('Soup', 'raw_material');
  otherDish = await item('Other Dish', 'raw_material');

  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgA}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;

  // Recipe: 2 kg Soup from 500 g Flour + 1.5 kg Stock.
  const [rec] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
    values (${orgA}, 'Soup', ${soup}, 2, ${managerId}) returning id`;
  recipeId = rec!.id;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipeId}, ${flour}, 500, 'g'), (${recipeId}, ${stock}, 1.5, 'kg')`;
});

async function receive(itemId: string, kind: string, qty: string, cost = '100.0000') {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${storeA},'purchase','2026-08-01',${fileA},${managerId}) returning id`;
  const result = await asOrg(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: locations(), receivedBy: managerId,
      lines: [{ lineId: '1', itemId, itemKind: kind, receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId: kitchen }],
    }),
  );
  if (!result.ok) throw new Error(`receive failed: ${result.reason}`);
}
const onHand = async (itemId: string): Promise<string> =>
  (await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and location_id = ${kitchen}`)[0]!.t;

const counts = async () => [
  Number((await sql<{ n: string }[]>`select count(*)::text as n from production_records where org_id = ${orgA}`)[0]!.n),
  Number((await sql<{ n: string }[]>`select count(*)::text as n from production_record_lines l join production_records r on r.id = l.record_id where r.org_id = ${orgA}`)[0]!.n),
];

const draft = (over: Record<string, unknown> = {}) =>
  asOrg(orgA, (tx) =>
    createProductionDraft(tx, manager, {
      orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10', labourCost: '0',
      inputs: [{ itemId: slab, quantity: '10', unit: 'kg' }],
      outputs: [{ itemId: sliced, quantity: '9', unit: 'kg' }],
      ...over,
    } as Parameters<typeof createProductionDraft>[2]),
  );
const cookDraft = (over: Record<string, unknown> = {}) =>
  draft({ kind: 'cook', recipeId, inputs: [], outputs: [{ itemId: soup, quantity: '4', unit: 'kg' }], ...over });
const post = (recordId: string) => asOrg(orgA, (tx) => postProduction(tx, manager, { recordId }));
const edit = (recordId: string, over: Record<string, unknown> = {}) =>
  asOrg(orgA, (tx) => editPostedProduction(tx, manager, { recordId, inputs: [], outputs: [], ...over } as Parameters<typeof editPostedProduction>[2]));

const linesOf = (recordId: string, revision = 1) =>
  sql<{ direction: string; item_id: string; q: string; unit: string }[]>`
    select direction, item_id, quantity::text as q, unit from production_record_lines
    where record_id = ${recordId} and revision = ${revision} order by direction, item_id`;
const statusOf = async (recordId: string) =>
  (await sql<{ status: string }[]>`select status from production_records where id = ${recordId}`)[0]!.status;
const revisionOf = async (recordId: string) =>
  (await sql<{ revision: number }[]>`select revision from production_records where id = ${recordId}`)[0]!.revision;
const refused = (r: { ok: boolean }): r is { ok: false; reason: string } => r.ok === false;

describe('invariants 1, 2 - slice category at draft save: refused in a sentence naming the item, no record row', () => {
  it('invariant 1: a raw_material input is refused; the sentence names the item; zero rows. Mutant: R1 input leg removed', async () => {
    const before = await counts();
    const r = await draft({ inputs: [{ itemId: flour, quantity: '10', unit: 'kg' }] });
    expect(r.ok, 'a slice from a raw_material was accepted').toBe(false);
    if (refused(r)) {
      expect(r.reason).toContain('Flour');
      expect(r.reason).toMatch(/slab/i);
    }
    expect(await counts()).toEqual(before);
  });

  it('invariant 1: the spec example - a SLICED item as input is refused with the Convert hint. Mutant: R1 input leg removed', async () => {
    const r = await draft({ inputs: [{ itemId: sliced, quantity: '10', unit: 'kg' }], outputs: [{ itemId: porkSliced, quantity: '9', unit: 'kg' }] });
    expect(r.ok).toBe(false);
    if (refused(r)) {
      expect(r.reason).toContain('Beef Sliced');
      expect(r.reason).toMatch(/convert/i);
    }
  });

  it('invariant 2: a meat_slab output is refused and named; zero rows. Mutant: R1 output leg removed', async () => {
    const before = await counts();
    const r = await draft({ outputs: [{ itemId: porkSlab, quantity: '9', unit: 'kg' }] });
    expect(r.ok, 'a slice into a slab was accepted').toBe(false);
    if (refused(r)) expect(r.reason).toContain('Pork Slab');
    expect(await counts()).toEqual(before);
  });

  it('invariant 2: a raw_material output is refused too', async () => {
    const r = await draft({ outputs: [{ itemId: flour, quantity: '9', unit: 'kg' }] });
    expect(r.ok).toBe(false);
  });
});

describe('invariant 4 - the everyday slice still posts; a lineage mismatch still posts WITH its warning', () => {
  it('slab -> sliced drafts and posts (control)', async () => {
    await receive(slab, 'meat_slab', '50');
    const d = await draft();
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const p = await post(d.recordId);
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect(await onHand(slab)).toBe('40.000');
  });

  it('a slice whose output belongs to ANOTHER slab posts with the soft warning, never blocked. Mutant: warning promoted to a block', async () => {
    await receive(slab, 'meat_slab', '50');
    const d = await draft({ outputs: [{ itemId: porkSliced, quantity: '9', unit: 'kg' }] });
    expect(d.ok, 'a lineage mismatch was blocked at save').toBe(true);
    if (!d.ok) return;
    const p = await post(d.recordId);
    expect(p.ok, `a lineage mismatch was blocked at post: ${JSON.stringify(p)}`).toBe(true);
    if (p.ok) expect(p.warnings.join(' ')).toMatch(/source slab differs/i);
  });
});

describe('invariant 3 - the rule is in the SHARED preparation, not only in createProductionDraft', () => {
  /** A slice draft written straight into the tables, as old data or another door could. */
  async function rawSliceDraft(inputItem: string, outputItem: string) {
    const [rec] = await sql<{ id: string }[]>`
      insert into production_records (org_id, store_id, location_id, kind, produced_on, created_by)
      values (${orgA}, ${storeA}, ${kitchen}, 'slice', '2026-08-10', ${managerId}) returning id`;
    await sql`insert into production_record_lines (record_id, direction, item_id, quantity, unit, revision) values
      (${rec!.id}, 'out', ${inputItem}, 10, 'kg', 1), (${rec!.id}, 'in', ${outputItem}, 9, 'kg', 1)`;
    return rec!.id;
  }

  it('post of a raw_material-input slice draft is refused in a slab sentence; record stays draft; stock untouched. Mutant: rule only in createProductionDraft', async () => {
    await receive(flour, 'raw_material', '50');
    const id = await rawSliceDraft(flour, sliced);
    const p = await post(id);
    expect(p.ok, 'post let a non-slab slice through').toBe(false);
    if (refused(p)) expect(p.reason).toMatch(/slab/i);
    expect(await statusOf(id)).toBe('draft');
    expect(await onHand(flour)).toBe('50.000');
  });

  it('post of a slice draft with a meat_slab OUTPUT is refused. Mutant: output leg only at draft', async () => {
    await receive(slab, 'meat_slab', '50');
    const id = await rawSliceDraft(slab, porkSlab);
    const p = await post(id);
    expect(p.ok).toBe(false);
    expect(await statusOf(id)).toBe('draft');
  });

  it('editPostedProduction of a posted slice into a raw_material input is refused; revision stays 1; stock unchanged. Mutant: edit has its own unguarded preparation', async () => {
    await receive(slab, 'meat_slab', '50');
    await receive(flour, 'raw_material', '50');
    const d = await draft();
    if (!d.ok) throw new Error(d.reason);
    expect((await post(d.recordId)).ok).toBe(true);
    const e = await edit(d.recordId, {
      inputs: [{ itemId: flour, quantity: '10', unit: 'kg' }],
      outputs: [{ itemId: sliced, quantity: '9', unit: 'kg' }],
    });
    expect(e.ok, 'an edit swapped the slab for flour').toBe(false);
    if (!e.ok) expect(e.reason).toMatch(/slab/i);
    expect(await revisionOf(d.recordId)).toBe(1);
    expect(await onHand(flour)).toBe('50.000');
    expect(await onHand(slab)).toBe('40.000');
  });
});

describe('invariant 5 - a cook needs a usable recipe of THIS org', () => {
  it('control: the valid cook drafts (no typed inputs)', async () => {
    const r = await cookDraft();
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('no recipeId is refused in a recipe sentence; zero rows. Mutant: recipeId required check dropped', async () => {
    const before = await counts();
    const r = await cookDraft({ recipeId: null, inputs: [{ itemId: flour, quantity: '1', unit: 'kg' }] });
    expect(r.ok, 'a cook with no recipe was accepted').toBe(false);
    if (refused(r)) expect(r.reason).toMatch(/recipe/i);
    expect(await counts()).toEqual(before);
  });

  it('an INACTIVE recipe is refused. Mutant: active check dropped', async () => {
    await sql`update production_recipes set status = 'inactive' where id = ${recipeId}`;
    const before = await counts();
    const r = await cookDraft();
    expect(r.ok, 'an inactive recipe was used').toBe(false);
    if (refused(r)) expect(r.reason).toMatch(/recipe/i);
    expect(await counts()).toEqual(before);
  });

  it("ANOTHER org's recipe is refused, as a sentence, not a database error. Mutant: same-org check dropped", async () => {
    const [ob] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org B','org-b') returning id`;
    const [pb] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${ob!.id},'B') returning id`;
    const [ib] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${ob!.id}, ${testItemCode()}, 'Soup B', 'raw_material', 'kg', ${pb!.id}) returning id`;
    const [rb] = await sql<{ id: string }[]>`insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${ob!.id}, 'Soup B', ${ib!.id}, 2, ${pb!.id}) returning id`;
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${rb!.id}, ${ib!.id}, 1, 'kg')`;
    const before = await counts();
    let text: string | null = null;
    try {
      const r = await cookDraft({ recipeId: rb!.id });
      text = r.ok ? null : r.reason;
    } catch (err) {
      text = `THROWN: ${(err as Error).message}`;
    }
    expect(text, "another org's recipe was accepted").not.toBeNull();
    expect(text).not.toMatch(/THROWN/);
    expect(text).toMatch(/recipe/i);
    expect(await counts()).toEqual(before);
  });
});

describe('invariant 6 - cook output must be the recipe output; the caller sends no inputs', () => {
  it("an output item other than the recipe's is refused. Mutant: output-item check dropped", async () => {
    const before = await counts();
    const r = await cookDraft({ outputs: [{ itemId: otherDish, quantity: '4', unit: 'kg' }] });
    expect(r.ok, 'a cook of a different item than its recipe was accepted').toBe(false);
    // The sentence must be about the recipe: HEAD also refuses (for lack of typed inputs), which is the wrong reason.
    if (refused(r)) expect(r.reason).toMatch(/recipe/i);
    expect(await counts()).toEqual(before);
  });

  it('two output lines are refused (exactly one). Mutant: single-output check dropped', async () => {
    const r = await cookDraft({ outputs: [{ itemId: soup, quantity: '2', unit: 'kg' }, { itemId: soup, quantity: '2', unit: 'kg' }] });
    expect(r.ok).toBe(false);
    // About the recipe, not HEAD's "needs at least one input".
    if (refused(r)) expect(r.reason).toMatch(/recipe/i);
  });

  it('caller-sent inputs are refused, even ones that match the recipe exactly. Mutant: inputs-must-be-empty check dropped', async () => {
    const before = await counts();
    const r = await cookDraft({ inputs: [{ itemId: flour, quantity: '1', unit: 'kg' }, { itemId: stock, quantity: '3', unit: 'kg' }] });
    expect(r.ok, 'typed cook inputs were accepted').toBe(false);
    expect(await counts()).toEqual(before);
  });
});

describe('invariant 7 - the inputs are the recipe scaled, in each ingredient base unit', () => {
  it('2 kg recipe (500 g Flour + 1.5 kg Stock), cook 4 kg -> stored inputs exactly 1.000 kg Flour and 3.000 kg Stock; output 4.000 Soup. Mutants: unscaled (0.500 / 1.500); unit not converted (Flour 1000.000)', async () => {
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    const lines = await linesOf(r.recordId);
    const key = (l: { direction: string; item_id: string; q: string; unit: string }) => `${l.direction}|${l.item_id}|${l.q}|${l.unit}`;
    expect(lines.map(key).sort()).toEqual([`out|${flour}|1.000|kg`, `out|${stock}|3.000|kg`, `in|${soup}|4.000|kg`].sort());
  });

  it('the recipe is stored on the record', async () => {
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    expect((await sql<{ recipe_id: string }[]>`select recipe_id from production_records where id = ${r.recordId}`)[0]!.recipe_id).toBe(recipeId);
  });

  it('a cook of the recipe posts and moves exactly the derived stock: Flour -1.000, Stock -3.000, Soup +4.000', async () => {
    await receive(flour, 'raw_material', '10');
    await receive(stock, 'raw_material', '10');
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    const p = await post(r.recordId);
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect(await onHand(flour)).toBe('9.000');
    expect(await onHand(stock)).toBe('7.000');
    expect(await onHand(soup)).toBe('4.000');
  });
});

describe('invariant 8 - post re-derives the inputs from the record recipe and refuses a mismatch', () => {
  it('a stored input quantity tampered (Flour 1.000 -> 2.000) -> post refused; stays draft; stock untouched. Mutant: R3 re-derivation skipped', async () => {
    await receive(flour, 'raw_material', '10');
    await receive(stock, 'raw_material', '10');
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    await sql`update production_record_lines set quantity = 2 where record_id = ${r.recordId} and item_id = ${flour}`;
    const p = await post(r.recordId);
    expect(p.ok, 'a tampered cook posted').toBe(false);
    expect(await statusOf(r.recordId)).toBe('draft');
    expect(await onHand(flour)).toBe('10.000');
  });

  it('the input ITEM SET tampered (Stock line swapped for Other Dish) -> post refused. Mutant: re-derivation compares quantities only', async () => {
    await receive(flour, 'raw_material', '10');
    await receive(stock, 'raw_material', '10');
    await receive(otherDish, 'raw_material', '10');
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    await sql`update production_record_lines set item_id = ${otherDish} where record_id = ${r.recordId} and item_id = ${stock}`;
    const p = await post(r.recordId);
    expect(p.ok, 'a cook with a swapped ingredient posted').toBe(false);
    expect(await statusOf(r.recordId)).toBe('draft');
  });

  it('an EXTRA input line added -> post refused. Mutant: only listed recipe lines checked', async () => {
    await receive(flour, 'raw_material', '10');
    await receive(stock, 'raw_material', '10');
    await receive(otherDish, 'raw_material', '10');
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    await sql`insert into production_record_lines (record_id, direction, item_id, quantity, unit, revision) values (${r.recordId}, 'out', ${otherDish}, 1, 'kg', 1)`;
    expect((await post(r.recordId)).ok).toBe(false);
    expect(await statusOf(r.recordId)).toBe('draft');
  });

  it('editPostedProduction on a cook takes the new OUTPUT quantity and derives the inputs: 2 kg -> Flour 0.500, Stock 1.500 at revision 2. Mutant: edit keeps the old inputs', async () => {
    await receive(flour, 'raw_material', '10');
    await receive(stock, 'raw_material', '10');
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    expect((await post(r.recordId)).ok).toBe(true);
    const e = await edit(r.recordId, { outputs: [{ itemId: soup, quantity: '2', unit: 'kg' }] });
    expect(e.ok, JSON.stringify(e)).toBe(true);
    const rev2 = await sql<{ direction: string; item_id: string; q: string }[]>`
      select direction, item_id, quantity::text as q from production_record_lines
      where record_id = ${r.recordId} and revision = 2 and reversed_at is null`;
    const key = (l: { direction: string; item_id: string; q: string }) => `${l.direction}|${l.item_id}|${l.q}`;
    expect(rev2.map(key).sort()).toEqual([`out|${flour}|0.500`, `out|${stock}|1.500`, `in|${soup}|2.000`].sort());
    expect(await onHand(flour)).toBe('9.500');
    expect(await onHand(stock)).toBe('8.500');
    expect(await onHand(soup)).toBe('2.000');
  });

  it('editPostedProduction on a cook with CALLER inputs is refused; revision stays 1. Mutant: edit accepts typed inputs', async () => {
    await receive(flour, 'raw_material', '10');
    await receive(stock, 'raw_material', '10');
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    expect((await post(r.recordId)).ok).toBe(true);
    const e = await edit(r.recordId, {
      inputs: [{ itemId: flour, quantity: '5', unit: 'kg' }],
      outputs: [{ itemId: soup, quantity: '4', unit: 'kg' }],
    });
    expect(e.ok, 'an edit with typed cook inputs was accepted').toBe(false);
    expect(await revisionOf(r.recordId)).toBe(1);
  });
});

describe('invariant 9 - an old cook record with no recipe cannot be posted or edited', () => {
  const SENTENCE = 'This cook record has no recipe. Void it and record it again from a recipe.';

  it('post of a null-recipe cook draft is refused with the exact R3 sentence; stays draft. Mutant: null recipe passes', async () => {
    await receive(flour, 'raw_material', '10');
    const [rec] = await sql<{ id: string }[]>`
      insert into production_records (org_id, store_id, location_id, kind, produced_on, created_by)
      values (${orgA}, ${storeA}, ${kitchen}, 'cook', '2026-08-10', ${managerId}) returning id`;
    await sql`insert into production_record_lines (record_id, direction, item_id, quantity, unit, revision) values
      (${rec!.id}, 'out', ${flour}, 1, 'kg', 1), (${rec!.id}, 'in', ${soup}, 1, 'kg', 1)`;
    const p = await post(rec!.id);
    expect(p.ok, 'a recipe-less cook posted').toBe(false);
    if (refused(p)) expect(p.reason).toBe(SENTENCE);
    expect(await statusOf(rec!.id)).toBe('draft');
    expect(await onHand(flour)).toBe('10.000');
  });

  it('edit of a POSTED cook whose recipe is gone is refused with the same sentence; revision stays 1. Mutant: null recipe passes at edit', async () => {
    await receive(flour, 'raw_material', '10');
    await receive(stock, 'raw_material', '10');
    const r = await cookDraft();
    if (!r.ok) throw new Error(r.reason);
    expect((await post(r.recordId)).ok).toBe(true);
    // Simulates a record written before T-409. If the table forbids touching a posted row this throws: a fixture gap to report.
    await sql`update production_records set recipe_id = null where id = ${r.recordId}`;
    const e = await edit(r.recordId, { outputs: [{ itemId: soup, quantity: '2', unit: 'kg' }] });
    expect(e.ok, 'a recipe-less posted cook was edited').toBe(false);
    if (!e.ok) expect(e.reason).toBe(SENTENCE);
    expect(await revisionOf(r.recordId)).toBe(1);
  });
});
