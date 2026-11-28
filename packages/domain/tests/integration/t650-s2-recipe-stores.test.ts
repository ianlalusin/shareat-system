import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-650 S2 - a product recipe is made only at the stores it is listed for; a recipe may carry a standard labour cost per batch. MIGRATION 0290.
 * Against real Postgres.
 *
 * MUTANTS (each goes red): `recipeStoreRefusal` not called by `createProductionDraft` (the "refused at a store not listed" test); not called by `postProduction`
 * (the post-time test); the empty-list rule flipped so an empty list means "no store" (the "empty list = every store" test); the standard labour not scaled
 * by the batches cooked (the 1.5 batches test); a typed labour figure overwritten by the standard (the typed-wins test); the standard applied when the recipe
 * has none (the no-standard test); the half-up rounding replaced by truncation (the half-centavo test). The cross-org rule is the database's own composite
 * FK (0290): proven with a raw INSERT, and the domain's own "store does not exist" refusal is proven separately.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { testItemCode } from './_fixtures/item-code';
import { closeDb, transaction, APP_ROLE, productionRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { cookLabourFor, createProductionDraft, createRecipe, editRecipe, postProduction, seedCanonicalPositions, quantity } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity as qty } from '../../src/stock/quantity';

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

async function newOrg(hint: string) {
  const code = uid(`p650s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  return orgId;
}

async function fixture(hint: string) {
  const orgId = await newOrg(hint);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = p!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Kitchen type') returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${`orgs/${orgId}/p.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${adminId}) returning id`;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('S')}, ${name}, 'multi_room') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${s!.id})`;
    const [loc] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgId}, ${s!.id}, 'KIT', 'Kitchen', ${t!.id}, 'operating', true, ${adminId}) returning id`;
    return { id: s!.id, name, locationId: loc!.id };
  };
  const lipa = await mkStore('Lipa');
  const bauan = await mkStore('Bauan');
  const mkItem = async (name: string, kind: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, ${`${name} ${uid('n')}`}, ${kind}, 'kg', ${adminId}) returning id`)[0]!.id;
  const tomato = await mkItem('Tomato', 'raw_material');
  const sauce = await mkItem('House sauce', 'retail');
  const admin: Actor = { personId: adminId, orgId };
  const f = { orgId, adminId, admin, lipa, bauan, tomato, sauce, fileId: file!.id };
  for (const st of [lipa, bauan]) await stockUp(f, st, tomato, '200', '40.00');
  return f;
}
type F = Awaited<ReturnType<typeof fixture>>;

async function stockUp(f: Pick<F, 'orgId' | 'adminId' | 'fileId'>, store: { id: string; locationId: string }, itemId: string, q: string, cost: string): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by) values (${f.orgId}, ${store.id}, 'purchase', '2026-01-02', ${f.fileId}, ${f.adminId}) returning id`;
  const r = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: store.id, deliveryId: d!.id, deliveredOn: '2026-01-02', receivedBy: f.adminId,
      locations: [{ id: store.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material' as never, receivedQuantity: qty(q), conversionFactor: '1', unitCost: `${cost}00`, locationId: store.locationId }],
    }),
  );
  if (!r.ok) throw new Error(r.reason);
}

/** A recipe making 5 kg of sauce from 10 kg of tomato. */
async function recipe(f: F, opts: { storeIds?: string[]; standardLabourCost?: string; outputQuantity?: string } = {}) {
  const name = `Sauce ${uid('r')}`;
  const r = await asOrg(f.orgId, (tx) =>
    createRecipe(tx, f.admin, {
      orgId: f.orgId, name, outputItemId: f.sauce, outputQuantity: opts.outputQuantity ?? '5', lines: [{ itemId: f.tomato, quantity: '10' }],
      ...(opts.storeIds ? { storeIds: opts.storeIds } : {}),
      ...(opts.standardLabourCost !== undefined ? { standardLabourCost: opts.standardLabourCost } : {}),
    }),
  );
  if (!r.ok) throw new Error(r.reason);
  names.set(r.recipeId, name);
  return r.recipeId;
}
const names = new Map<string, string>();

async function cook(f: F, store: F['lipa'], recipeId: string, made: string, labourCost?: string) {
  return asOrg(f.orgId, (tx) =>
    createProductionDraft(tx, f.admin, {
      orgId: f.orgId, storeId: store.id, locationId: store.locationId, kind: 'cook', recipeId, producedOn: '2026-01-12',
      labourCost, inputs: [], outputs: [{ itemId: f.sauce, quantity: made, unit: 'kg' }],
    }),
  );
}
const labourOf = async (id: string) => (await sql<{ labour_cost: string }[]>`select labour_cost::text from production_records where id = ${id}`)[0]!.labour_cost;
const recordCount = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from production_records where org_id = ${orgId}`)[0]!.n);

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-650 S2 - a product recipe is made only at its stores', () => {
  it('1. a recipe listed for Lipa is refused at Bauan in the DOMAIN (no record is written), in a sentence naming the store', async () => {
    const f = await fixture('s1');
    const id = await recipe(f, { storeIds: [f.lipa.id] });
    const r = await cook(f, f.bauan, id, '5');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(`Only Lipa make ${names.get(id)}.`);
    expect(await recordCount(f.orgId)).toBe(0);
  });

  it('2. the same recipe is allowed at the listed store, and can be posted there', async () => {
    const f = await fixture('s2');
    const id = await recipe(f, { storeIds: [f.lipa.id] });
    const r = await cook(f, f.lipa, id, '5');
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.admin, { recordId: r.recordId }));
    expect(p.ok, p.ok ? '' : p.reason).toBe(true);
  });

  it('3. an EMPTY list means every store may make it (nothing breaks on deploy)', async () => {
    const f = await fixture('s3');
    const id = await recipe(f); // no storeIds at all
    expect((await cook(f, f.lipa, id, '5')).ok).toBe(true);
    expect((await cook(f, f.bauan, id, '5')).ok).toBe(true);
    expect(await asOrg(f.orgId, (tx) => productionRepo.listRecipeStores(tx, f.orgId, id))).toEqual([]);
  });

  it('4. two stores listed: the sentence names both; the screen read (recipeStoreMap) offers it only at those stores', async () => {
    const f = await fixture('s4');
    const [third] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${f.orgId}, ${uid('S')}, 'Tanauan', 'multi_room') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${f.adminId}, ${third!.id})`;
    const id = await recipe(f, { storeIds: [f.lipa.id, f.bauan.id] });
    const map = await asOrg(f.orgId, (tx) => productionRepo.recipeStoreMap(tx, f.orgId));
    expect(new Set(map.get(id))).toEqual(new Set([f.lipa.id, f.bauan.id]));
    expect(map.get(id)).not.toContain(third!.id);
    const [loc] = await sql<{ id: string }[]>`select id from stock_locations where org_id = ${f.orgId} limit 1`;
    const r = await cook(f, { ...f.lipa, id: third!.id, locationId: loc!.id }, id, '5');
    expect(!r.ok && r.reason).toMatch(new RegExp('^Only (Lipa and Bauan|Bauan and Lipa) make ' + names.get(id) + '[.]$'));
  });

  it('5. a draft saved while the recipe was open to all cannot be POSTED once the recipe is limited to another store', async () => {
    const f = await fixture('s5');
    const id = await recipe(f);
    const r = await cook(f, f.bauan, id, '5');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await sql`insert into production_recipe_stores (org_id, recipe_id, store_id) values (${f.orgId}, ${id}, ${f.lipa.id})`;
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.admin, { recordId: r.recordId }));
    expect(p.ok).toBe(false);
    expect(!p.ok && p.reason).toBe(`Only Lipa make ${names.get(id)}.`);
  });

  it('6. a store of ANOTHER organisation is refused by the database (composite same-org FK) and by the domain', async () => {
    const f = await fixture('s6');
    const otherOrg = await newOrg('s6-other');
    const [foreign] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${otherOrg}, ${uid('S')}, 'Elsewhere', 'multi_room') returning id`;
    const id = await recipe(f);
    await expect(sql`insert into production_recipe_stores (org_id, recipe_id, store_id) values (${f.orgId}, ${id}, ${foreign!.id})`).rejects.toMatchObject({ code: '23503' });
    const r = await asOrg(f.orgId, (tx) =>
      createRecipe(tx, f.admin, { orgId: f.orgId, name: uid('X'), outputItemId: f.sauce, outputQuantity: '5', lines: [{ itemId: f.tomato, quantity: '10' }], storeIds: [foreign!.id] }),
    );
    expect(r.ok).toBe(false);
  });

  it('7. editing a recipe replaces its store list, and [] removes the limit; deleting the recipe row cascades the list', async () => {
    const f = await fixture('s7');
    const id = await recipe(f, { storeIds: [f.lipa.id] });
    const edit = (storeIds?: string[]) =>
      asOrg(f.orgId, (tx) =>
        editRecipe(tx, f.admin, { recipeId: id, name: uid('Sauce'), outputItemId: f.sauce, outputQuantity: '5', lines: [{ itemId: f.tomato, quantity: '10' }], ...(storeIds ? { storeIds } : {}) }),
      );
    expect((await edit([f.bauan.id])).ok).toBe(true);
    expect((await asOrg(f.orgId, (tx) => productionRepo.listRecipeStores(tx, f.orgId, id))).map((s) => s.storeName)).toEqual(['Bauan']);
    expect((await edit()).ok).toBe(true); // omitted = unchanged
    expect((await asOrg(f.orgId, (tx) => productionRepo.listRecipeStores(tx, f.orgId, id))).length).toBe(1);
    expect((await edit([])).ok).toBe(true);
    expect(await asOrg(f.orgId, (tx) => productionRepo.listRecipeStores(tx, f.orgId, id))).toEqual([]);
    await sql`insert into production_recipe_stores (org_id, recipe_id, store_id) values (${f.orgId}, ${id}, ${f.lipa.id})`;
    await sql`delete from production_recipes where id = ${id}`;
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from production_recipe_stores where recipe_id = ${id}`)[0]!.n)).toBe(0);
  });
});

describe('T-650 S2 - standard labour per batch', () => {
  it('8. a BLANK labour box takes standard x batches: 7.5 kg of a 5 kg recipe at 100.00 a batch = 150.00 (1.5 batches)', async () => {
    const f = await fixture('l1');
    const id = await recipe(f, { standardLabourCost: '100.00' });
    const r = await cook(f, f.lipa, id, '7.5');
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(await labourOf(r.recordId)).toBe('150.00');
    const whole = await cook(f, f.lipa, id, '5');
    expect(whole.ok && (await labourOf(whole.recordId))).toBe('100.00');
  });

  it('9. a typed figure wins, including a typed 0.00', async () => {
    const f = await fixture('l2');
    const id = await recipe(f, { standardLabourCost: '100.00' });
    const a = await cook(f, f.lipa, id, '7.5', '12.50');
    expect(a.ok && (await labourOf(a.recordId))).toBe('12.50');
    const b = await cook(f, f.lipa, id, '7.5', '0.00');
    expect(b.ok && (await labourOf(b.recordId))).toBe('0.00');
  });

  it('10. a recipe with NO standard labour books 0.00 as today', async () => {
    const f = await fixture('l3');
    const id = await recipe(f);
    const r = await cook(f, f.lipa, id, '7.5');
    expect(r.ok && (await labourOf(r.recordId))).toBe('0.00');
  });

  it('11. rounding is half-up to the centavo, exact (0.01 a batch of 2 kg, 1 kg cooked = 0.005 -> 0.01; 100.00 over 3 kg, 1 kg = 33.33)', async () => {
    const f = await fixture('l4');
    const tiny = await recipe(f, { standardLabourCost: '0.01', outputQuantity: '2' });
    const a = await cook(f, f.lipa, tiny, '1');
    expect(a.ok && (await labourOf(a.recordId))).toBe('0.01');
    const third = await recipe(f, { standardLabourCost: '100.00', outputQuantity: '3' });
    const b = await cook(f, f.lipa, third, '1');
    expect(b.ok && (await labourOf(b.recordId))).toBe('33.33');
    expect(cookLabourFor('100.00', '4.000', quantity('6.000'))).toEqual({ pay: '150.00', batches: '1.5' });
    expect(cookLabourFor('100.00', '4.000', quantity('8.000'))).toEqual({ pay: '200.00', batches: '2' });
  });

  it('12. the posted cook carries the labour into the output layer: (inputs + labour) / output', async () => {
    const f = await fixture('l5');
    const id = await recipe(f, { standardLabourCost: '100.00' });
    const r = await cook(f, f.lipa, id, '5');
    if (!r.ok) throw new Error(r.reason);
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.admin, { recordId: r.recordId }));
    expect(p.ok, p.ok ? '' : p.reason).toBe(true);
    const [layer] = await sql<{ unit_cost: string }[]>`select unit_cost::text from stock_layers where source = 'production' and source_id = ${r.recordId} and item_id = ${f.sauce}`;
    expect(Number(layer!.unit_cost)).toBe(60); // the production identity (T-650 S1 ruling): 40 a kg of input + 100 labour over 5 kg output = 60
  });

  it('13. a negative or non-numeric labour per batch is refused with a sentence; blank clears it', async () => {
    const f = await fixture('l6');
    const make = (standardLabourCost: string) =>
      asOrg(f.orgId, (tx) => createRecipe(tx, f.admin, { orgId: f.orgId, name: uid('Sauce'), outputItemId: f.sauce, outputQuantity: '5', lines: [{ itemId: f.tomato, quantity: '10' }], standardLabourCost }));
    const neg = await make('-5');
    expect(!neg.ok && neg.reason).toMatch(/negative/i);
    const blank = await make('');
    expect(blank.ok).toBe(true);
    // the CHECK underneath refuses a negative even when the domain is bypassed
    await expect(sql`update production_recipes set standard_labour_cost = -1 where org_id = ${f.orgId}`).rejects.toMatchObject({ code: '23514' });
  });
});
