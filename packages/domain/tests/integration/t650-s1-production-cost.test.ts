import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-650 S1 - made-here items price off their production cost; slicing labour fills itself. Against real Postgres, no migration.
 * Cost basis order: (1) the item's latest posted slice/cook layer cost -> (2) the linked slab's landed max-of-last-two -> (3) its own landed.
 * Branch price and the T-649 customer-price resolver both read it.
 *
 * MUTANTS (each goes red): tier (1) placed after tier (2) in `costBasisFor` (the "sliced item beats the linked slab" tests); the status filter dropped from
 * `lastProductionUnitCost` (the voided test); `kind in ('slice','cook')` widened to convert (the convert test); `unit_cost > 0` dropped (the zero-cost test);
 * the blank-labour auto fill removed from `createProductionDraft` (the labour tests); `postProduction` re-deciding a zero labour (the typed-0.00 tests);
 * the edit recompute removed (the edit test).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { ensureSlicerPerson } from './_fixtures/t635-slicer';
import { testItemCode } from './_fixtures/item-code';
import { closeDb, transaction, APP_ROLE, itemsRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  branchPriceFor,
  createPriceList,
  createCustomer,
  createProductionDraft,
  createRecipe,
  editPostedProduction,
  postProduction,
  quoteForCustomer,
  seedCanonicalPositions,
  setItemPricing,
  setPrice,
  setSlicerPayRate,
  voidProduction,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';

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

async function fixture(hint: string, opts: { rates?: boolean } = {}) {
  const code = uid(`p650-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('A')}, 'Lipa', 'multi_room') returning id`;
  const storeId = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = p!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  const samId = await ensureSlicerPerson(sql, { orgId, storeId });
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Kitchen type') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${t!.id}, 'operating', true, ${adminId}) returning id`;
  const mkItem = async (name: string, kind: string, parent: string | null = null, link: string | null = null) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, cost_basis_item_id, created_by, sellable_wholesale)
      values (${orgId}, ${testItemCode()}, ${`${name} ${uid('n')}`}, ${kind}, 'kg', ${parent}, ${link}, ${adminId}, true) returning id`)[0]!.id;
  const slab = await mkItem('Beef Forequarter', 'meat_slab');
  const sliceA = await mkItem('Slice A', 'meat_sliced', slab, slab);
  const sliceB = await mkItem('Slice B', 'meat_sliced', slab, slab);
  const tomato = await mkItem('Tomato', 'raw_material');
  const sauce = await mkItem('House sauce', 'retail');
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${`orgs/${orgId}/p.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${adminId}) returning id`;
  const f = { orgId, storeId, locationId: loc!.id, adminId, samId, slab, sliceA, sliceB, tomato, sauce, fileId: file!.id, admin: actor(orgId, adminId) };
  if (opts.rates !== false) {
    expect((await asOrg(orgId, (tx) => setSlicerPayRate(tx, f.admin, { storeId, itemId: null, ratePerKg: '5.00', effectiveFrom: '2026-01-01' }))).ok).toBe(true);
  }
  return f;
}
type F = Awaited<ReturnType<typeof fixture>>;

/** Stock in the kitchen: a purchase delivery of `qty` of the item at `cost` a kg. */
async function stockUp(f: F, itemId: string, kind: string, qty: string, cost: string): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by) values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-02', ${f.fileId}, ${f.adminId}) returning id`;
  const r = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-02', receivedBy: f.adminId,
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      lines: [{ lineId: '1', itemId, itemKind: kind as never, receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: `${cost}00`, locationId: f.locationId }],
    }),
  );
  if (!r.ok) throw new Error(r.reason);
}

/** A DELIVERY price (what `costBasisFor` reads as landed): one supplier bill for the item at `price` a kg. */
async function landCost(f: F, itemId: string, price: string): Promise<void> {
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.adminId}) returning id`;
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, created_by)
    values (${f.orgId}, ${f.storeId}, ${sup!.id}, '2026-01-20', ${price}, ${f.adminId}) returning id`;
  await sql`
    insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
    values (${inv!.id}, 1, ${itemId}, '1', 'kg', '1', ${price}, ${price})`;
}

async function slice(f: F, over: { on?: string; slabKg?: string; out?: { itemId: string; quantity: string; unit?: string }[]; labourCost?: string; post?: boolean }) {
  const draft = await asOrg(f.orgId, (tx) =>
    createProductionDraft(tx, f.admin, {
      orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'slice', performedByPersonId: f.samId, producedOn: over.on ?? '2026-01-12',
      labourCost: over.labourCost,
      inputs: [{ itemId: f.slab, quantity: over.slabKg ?? '10', unit: 'kg' }],
      outputs: (over.out ?? [{ itemId: f.sliceA, quantity: '8' }]).map((o) => ({ ...o, unit: o.unit ?? 'kg' })),
    }),
  );
  if (!draft.ok) throw new Error(draft.reason);
  if (over.post !== false) {
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.admin, { recordId: draft.recordId }));
    if (!p.ok) throw new Error(p.reason);
  }
  return draft;
}
/** The cost basis with its figure normalised (a landed average carries a long tail of digits; a layer cost has four places): Number(...) is fine in a test. */
async function basis(f: F, itemId: string) {
  const b = await asOrg(f.orgId, (tx) => itemsRepo.costBasisFor(tx, f.orgId, itemId));
  return b && { ...b, basis: String(Number(b.basis)) };
}
const labourOf = async (id: string) => (await sql<{ labour_cost: string }[]>`select labour_cost::text from production_records where id = ${id}`)[0]!.labour_cost;

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-650 S1 - the cost basis follows what an item was last MADE at', () => {
  it('1. a sliced item with a posted slice costs its layer unit cost (the source per-kg cost + labour over the output kilos) and beats the linked slab', async () => {
    const f = await fixture('s1');
    await stockUp(f, f.slab, 'meat_slab', '100', '300.00');
    await landCost(f, f.slab, '300.00');
    expect(await basis(f, f.sliceA)).toMatchObject({ basis: '300', basisFrom: 'linked' }); // no production yet: the slab's delivery price
    await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '8' }], labourCost: '200.00' });
    // The existing production identity (NOT changed here): the output carries the source's 300 a kg, plus the 200 labour spread over the 8 output kg (25 a kg);
    // the 2 kg yield gap is expensed to wastage, not loaded onto the output. 300 + 25 = 325.
    expect(await basis(f, f.sliceA)).toMatchObject({ basis: '325', basisFrom: 'produced', storeName: 'Lipa', producedOn: '2026-01-12' });
  });

  it('2. the branch price and the T-649 customer quote both pick the production cost up', async () => {
    const f = await fixture('s2');
    await stockUp(f, f.slab, 'meat_slab', '100', '300.00');
    await landCost(f, f.slab, '300.00');
    await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '8' }], labourCost: '200.00' });
    await asOrg(f.orgId, (tx) => setItemPricing(tx, f.admin, { itemId: f.sliceA, pricingMode: 'fixed_markup', fixedMarkupAmount: '50.00' }));
    const bp = await asOrg(f.orgId, (tx) => branchPriceFor(tx, f.orgId, f.sliceA));
    expect(bp).toMatchObject({ price: '375.00', basisFrom: 'produced', basisStoreName: 'Lipa' });
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: uid('List') }));
    await asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: f.sliceA, mode: 'percent_markup', markupPercent: '10' }));
    const buyer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: uid('Buyer'), priceListId: list.id }));
    const q = await asOrg(f.orgId, (tx) => quoteForCustomer(tx, f.orgId, buyer.id, f.sliceA));
    expect(q).toMatchObject({ rate: '357.50', basis: 'cost_plus' }); // 325 x 1.10, not the slab's 300 x 1.10
  });

  it('3. a voided production is ignored: the basis falls back to the linked slab', async () => {
    const f = await fixture('s3');
    await stockUp(f, f.slab, 'meat_slab', '100', '300.00');
    await landCost(f, f.slab, '300.00');
    const d = await slice(f, { out: [{ itemId: f.sliceA, quantity: '8' }], labourCost: '200.00' });
    expect((await basis(f, f.sliceA))?.basisFrom).toBe('produced');
    const v = await asOrg(f.orgId, (tx) => voidProduction(tx, f.admin, { recordId: d.recordId, reason: 'wrong weight' }));
    expect(v.ok, v.ok ? '' : v.reason).toBe(true);
    expect(await basis(f, f.sliceA)).toMatchObject({ basis: '300', basisFrom: 'linked' });
  });

  it('4. a convert is ignored (it only re-counts): the target keeps its linked basis', async () => {
    const f = await fixture('s4');
    await stockUp(f, f.slab, 'meat_slab', '100', '300.00');
    await landCost(f, f.slab, '300.00');
    await slice(f, { out: [{ itemId: f.sliceA, quantity: '8' }], labourCost: '200.00' }); // sliceA at 325
    const c = await asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.admin, {
        orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'convert', producedOn: '2026-01-13',
        inputs: [{ itemId: f.sliceA, quantity: '2', unit: 'kg' }], outputs: [{ itemId: f.sliceB, quantity: '2', unit: 'kg' }],
      }),
    );
    if (!c.ok) throw new Error(c.reason);
    const pc = await asOrg(f.orgId, (tx) => postProduction(tx, f.admin, { recordId: c.recordId }));
    expect(pc.ok, pc.ok ? '' : pc.reason).toBe(true);
    // the convert wrote Slice B a layer at 325, and that is NOT its cost
    expect(await basis(f, f.sliceB)).toMatchObject({ basis: '300', basisFrom: 'linked' });
  });

  it('5. a sauce from a cook with labour costs the input per-kg cost + labour / output kg; with no production it has no cost at all', async () => {
    const f = await fixture('s5');
    await stockUp(f, f.tomato, 'raw_material', '100', '40.00');
    expect(await basis(f, f.sauce)).toBeUndefined();
    const recipe = await asOrg(f.orgId, (tx) =>
      createRecipe(tx, f.admin, { orgId: f.orgId, name: uid('Sauce'), outputItemId: f.sauce, outputQuantity: '5', lines: [{ itemId: f.tomato, quantity: '10' }] }),
    );
    if (!recipe.ok) throw new Error(recipe.reason);
    const cook = await asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.admin, {
        orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'cook', recipeId: recipe.recipeId, producedOn: '2026-01-12', labourCost: '100.00',
        inputs: [], outputs: [{ itemId: f.sauce, quantity: '5', unit: 'kg' }],
      }),
    );
    if (!cook.ok) throw new Error(cook.reason);
    const pc = await asOrg(f.orgId, (tx) => postProduction(tx, f.admin, { recordId: cook.recordId }));
    expect(pc.ok, pc.ok ? '' : pc.reason).toBe(true);
    expect(await basis(f, f.sauce)).toMatchObject({ basis: '60', basisFrom: 'produced' }); // 40 a kg of tomato + 100 labour over 5 kg = 60
  });

  it('6. a zero-cost production is skipped, not used: the next most recent costed one is', async () => {
    const f = await fixture('s6');
    await stockUp(f, f.slab, 'meat_slab', '100', '300.00');
    await slice(f, { on: '2026-01-05', out: [{ itemId: f.sliceA, quantity: '10' }], labourCost: '0.00' }); // 3000 / 10 = 300.0000
    const newer = await slice(f, { on: '2026-01-12', out: [{ itemId: f.sliceA, quantity: '8' }], labourCost: '0.00' });
    await sql`update stock_layers set unit_cost = 0 where source = 'production' and source_id = ${newer.recordId}`; // a layer with no value (simulated)
    expect(await basis(f, f.sliceA)).toMatchObject({ basis: '300', basisFrom: 'produced', producedOn: '2026-01-05' });
    await sql`update stock_layers set unit_cost = 0 where source = 'production' and item_id = ${f.sliceA}`;
    expect(await basis(f, f.sliceA)).toBeUndefined(); // nothing costed anywhere: no cost, never zero
  });

  it('7. a delivered item is unchanged: the higher of its last two landed deliveries', async () => {
    const f = await fixture('s7');
    await landCost(f, f.tomato, '40.00');
    await landCost(f, f.tomato, '55.00');
    expect(await basis(f, f.tomato)).toMatchObject({ basis: '55', basisFrom: 'own' });
  });
});

describe('T-650 S1.6 - slicing labour fills itself from the slicer rate', () => {
  async function ready(hint: string, opts: { rates?: boolean } = {}) {
    const f = await fixture(hint, opts);
    await stockUp(f, f.slab, 'meat_slab', '100', '300.00');
    return f;
  }

  it('a BLANK labour box takes kg x rate (9 kg x 5.00 = 45.00) and the layer carries it', async () => {
    const f = await ready('l1');
    const d = await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '9' }] });
    expect(await labourOf(d.recordId)).toBe('45.00');
    expect(await basis(f, f.sliceA)).toMatchObject({ basis: '305', basisFrom: 'produced' }); // 300 + 45 / 9
  });

  it('a typed figure wins, including a typed 10.00 against a 45.00 rate', async () => {
    const f = await ready('l2');
    const d = await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '9' }], labourCost: '10.00' });
    expect(await labourOf(d.recordId)).toBe('10.00');
  });

  it('grams count as kg through the one conversion table: 2000 g + 6 kg = 8 kg = 40.00', async () => {
    const f = await ready('l3');
    const d = await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '2000', unit: 'g' }, { itemId: f.sliceB, quantity: '6' }] });
    expect(await labourOf(d.recordId)).toBe('40.00');
  });

  it('no rate in force: labour stays 0.00 and the draft says why', async () => {
    const f = await ready('l4', { rates: false });
    const d = await slice(f, { post: false });
    expect(d.labourNote).toMatch(/no slicer rate in force/i);
    expect(await labourOf(d.recordId)).toBe('0.00');
  });

  it('the figure is fixed when the draft is saved: a rate set AFTER the draft does not rewrite it at post (a typed 0.00 must stay 0.00)', async () => {
    const f = await ready('l5', { rates: false });
    const d = await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '9' }], post: false });
    expect(await labourOf(d.recordId)).toBe('0.00');
    expect((await asOrg(f.orgId, (tx) => setSlicerPayRate(tx, f.admin, { storeId: f.storeId, itemId: null, ratePerKg: '5.00', effectiveFrom: '2026-01-01' }))).ok).toBe(true);
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.admin, { recordId: d.recordId }));
    expect(p.ok, p.ok ? '' : p.reason).toBe(true);
    expect(await labourOf(d.recordId)).toBe('0.00');
  });

  it('a TYPED 0.00 stays 0.00 even with a rate in force', async () => {
    const f = await ready('l5b');
    const d = await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '9' }], labourCost: '0.00' });
    expect(await labourOf(d.recordId)).toBe('0.00');
  });

  it('editing an AUTOMATIC figure follows the new kilos (9 kg -> 7 kg: 45.00 -> 35.00); a TYPED figure is left alone', async () => {
    const f = await ready('l6');
    const auto = await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '9' }] });
    const typed = await slice(f, { slabKg: '10', out: [{ itemId: f.sliceA, quantity: '9' }], labourCost: '12.34' });
    const edit = (recordId: string) =>
      asOrg(f.orgId, (tx) =>
        editPostedProduction(tx, f.admin, { recordId, inputs: [{ itemId: f.slab, quantity: '10', unit: 'kg' }], outputs: [{ itemId: f.sliceA, quantity: '7', unit: 'kg' }] }),
      );
    expect((await edit(auto.recordId)).ok).toBe(true);
    expect((await edit(typed.recordId)).ok).toBe(true);
    expect(await labourOf(auto.recordId)).toBe('35.00');
    expect(await labourOf(typed.recordId)).toBe('12.34');
  });
});
