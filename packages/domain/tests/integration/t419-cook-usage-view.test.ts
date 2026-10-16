import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, stockUsageRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { createProductionDraft, editPostedProduction, postProduction, voidProduction } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { autoPostDueUsageDrafts } from '../../src/stock/usage-auto-post';
import { usageCloseRefusal } from '../../src/stock/usage-check-report';
import { usageVariancesFor } from '../../src/stock/usage-tolerance';
import type { LocationLike } from '../../src/stock-locations/rules';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-419 cases 1-8 - the daily usage screen lists the ingredients of recipe cooking (display only).
 * `docs/tasks/419-cook-usage-on-daily-usage.md`. TESTER.
 *
 * Red on HEAD because `listCookUsageForDay` does not exist yet (every call is a TypeError "not a function"). Once it exists, each
 * assertion names the mutant it kills. Case 7's checks (no stock figure, no usage check, no auto-post moves) are TRUE on HEAD; they
 * are red here only through the missing function, and become real guards once the builder adds it.
 * Case 5 uses DRAFT slice/convert rows (drafts are shown, so a dropped `kind = 'cook'` filter would list them).
 *
 * Fixture: Adobo base = 500 g Pork + 100 g Soy -> 0.6 kg Adobo (output may not exceed input; cooks below are 0.6 kg unless stated). All kg (a run cannot mix kg and ltr: validate.ts:161, spec fixture with ml is unpostable). Day D = 2026-08-10. Store A and B.
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

const D = '2026-08-10';
const D_BEFORE = '2026-08-09';

let orgA: string, storeA: string, storeB: string, managerId: string, clerkId: string, fileA: string, kitchenA: string, kitchenB: string;
let manager: Actor, clerk: Actor;
let pork: string, soy: string, adobo: string, flour: string, recipeId: string;

const item = async (name: string, unit: string) => {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgA}, ${testItemCode()}, ${name}, 'raw_material', ${unit}, ${managerId}) returning id`;
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
  const [s2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'B1','B One','multi_room') returning id`;
  storeB = s2!.id;
  const [m] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Manager') returning id`;
  managerId = m!.id;
  const [c] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Clerk') returning id`;
  clerkId = c!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgA}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${clerkId}, ${orgA}, 'staff')`; // active role, but NO store scope at A
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeA}), (${managerId}, ${storeB})`;
  manager = { personId: managerId, orgId: orgA };
  clerk = { personId: clerkId, orgId: orgA };
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Kitchen type') returning id`;
  const [ka] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${managerId}) returning id`;
  kitchenA = ka!.id;
  const [kb] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeB},'KIT','Kitchen',${t!.id},'operating',true,${managerId}) returning id`;
  kitchenB = kb!.id;

  pork = await item('Pork', 'kg');
  soy = await item('Soy sauce', 'kg');
  adobo = await item('Adobo', 'kg');
  flour = await item('Flour', 'kg');

  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgA}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;

  const [rec] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
    values (${orgA}, 'Adobo base', ${adobo}, 0.6, ${managerId}) returning id`;
  recipeId = rec!.id;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipeId}, ${pork}, 500, 'g'), (${recipeId}, ${soy}, 100, 'g')`;
});

const locationsOf = (id: string): LocationLike[] => [{ id, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];
async function receive(itemId: string, qty: string, storeId = storeA, locationId = kitchenA) {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${storeId},'purchase','2026-08-01',${fileA},${managerId}) returning id`;
  const result = await asOrg(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: locationsOf(locationId), receivedBy: managerId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: '100.0000', locationId }],
    }),
  );
  if (!result.ok) throw new Error(`receive failed: ${result.reason}`);
}
const stockUp = async () => {
  await receive(pork, '20');
  await receive(soy, '20');
};
const onHand = async (itemId: string): Promise<string> =>
  (await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId}`)[0]!.t;

const cookDraft = async (qty = '0.6', over: { storeId?: string; locationId?: string; producedOn?: string } = {}): Promise<string> => {
  const r = await asOrg(orgA, (tx) =>
    createProductionDraft(tx, manager, {
      orgId: orgA, storeId: over.storeId ?? storeA, locationId: over.locationId ?? kitchenA, kind: 'cook', producedOn: over.producedOn ?? D,
      labourCost: '0', recipeId, inputs: [], outputs: [{ itemId: adobo, quantity: qty, unit: 'kg' }],
    } as Parameters<typeof createProductionDraft>[2]),
  );
  if (!r.ok) throw new Error(`cook draft failed: ${r.reason}`);
  return r.recordId;
};
const cookPosted = async (qty = '0.6', over: Parameters<typeof cookDraft>[1] = {}): Promise<string> => {
  const id = await cookDraft(qty, over);
  const p = await asOrg(orgA, (tx) => postProduction(tx, manager, { recordId: id }));
  if (!p.ok) throw new Error(`cook post failed: ${JSON.stringify(p)}`);
  return id;
};
const view = (actor: Actor = manager, storeId = storeA, date = D) =>
  asOrg(orgA, (tx) => domain.listCookUsageForDay(tx, actor, { storeId, date }));

const shape = (rows: Awaited<ReturnType<typeof view>>) =>
  rows.map((r) => ({ item: r.itemName, q: r.quantity, unit: r.unit, recipe: r.recipeName, draft: r.isDraft }));

describe('T-419 cook usage view - what is listed', () => {
  it('1. a posted 0.6 kg cook lists pork 0.500 kg and soy 0.100 kg, each with the recipe name, not draft. Mutant: recipe join dropped', async () => {
    await stockUp();
    await cookPosted('0.6');
    const rows = await view();
    expect(shape(rows)).toEqual([
      { item: 'Pork', q: '0.500', unit: 'kg', recipe: 'Adobo base', draft: false },
      { item: 'Soy sauce', q: '0.100', unit: 'kg', recipe: 'Adobo base', draft: false },
    ]);
  });

  it('2. the cooked output (Adobo) is NOT listed. Mutant: direction = in instead of out', async () => {
    await stockUp();
    await cookPosted('0.6');
    const rows = await view();
    expect(rows.map((r) => r.itemId)).not.toContain(adobo);
    expect(rows).toHaveLength(2);
  });

  it('3. a draft cook is listed with isDraft true; a voided cook is not. Mutants: posted-only filter; void not excluded; isDraft hard-coded false', async () => {
    await stockUp();
    await cookDraft('0.6');
    const voidedId = await cookPosted('1.2');
    const v = await asOrg(orgA, (tx) => voidProduction(tx, manager, { recordId: voidedId, reason: 'testing the void exclusion' }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    const rows = await view();
    expect(shape(rows)).toEqual([
      { item: 'Pork', q: '0.500', unit: 'kg', recipe: 'Adobo base', draft: true },
      { item: 'Soy sauce', q: '0.100', unit: 'kg', recipe: 'Adobo base', draft: true },
    ]);
  });

  it('3b. posted rows come before draft rows. Mutant: no posted-first ordering', async () => {
    await stockUp();
    await cookDraft('2.4');
    await cookPosted('0.6');
    const rows = await view();
    expect(rows.map((r) => r.isDraft)).toEqual([false, false, true, true]);
  });

  it('4. a posted cook edited from 0.6 kg to 1.2 kg is listed ONCE at the new quantity (pork 1.000). Mutant: reversed_at is null dropped', async () => {
    await stockUp();
    const id = await cookPosted('0.6');
    const e = await asOrg(orgA, (tx) =>
      editPostedProduction(tx, manager, { recordId: id, inputs: [], outputs: [{ itemId: adobo, quantity: '1.2', unit: 'kg' }] } as Parameters<typeof editPostedProduction>[2]),
    );
    expect(e.ok, JSON.stringify(e)).toBe(true);
    const rows = await view();
    expect(shape(rows)).toEqual([
      { item: 'Pork', q: '1.000', unit: 'kg', recipe: 'Adobo base', draft: false },
      { item: 'Soy sauce', q: '0.200', unit: 'kg', recipe: 'Adobo base', draft: false },
    ]);
  });

  it('5. a slice and a convert record on D are not listed. Mutant: kind = cook dropped', async () => {
    for (const kind of ['slice', 'convert'] as const) {
      const [r] = await sql<{ id: string }[]>`
        insert into production_records (org_id, store_id, location_id, kind, produced_on, created_by)
        values (${orgA}, ${storeA}, ${kitchenA}, ${kind}, ${D}, ${managerId}) returning id`;
      await sql`insert into production_record_lines (record_id, direction, item_id, quantity, unit, revision) values (${r!.id}, 'out', ${flour}, 3, 'kg', 1), (${r!.id}, 'in', ${flour}, 2, 'kg', 1)`;
    }
    expect(await view()).toEqual([]);
  });

  it('6. a cook at store B, and a cook at store A on the day before, are not listed for (A, D). Mutants: store or date filter dropped', async () => {
    await receive(pork, '20', storeB, kitchenB);
    await receive(soy, '20', storeB, kitchenB);
    await stockUp();
    await cookDraft('0.6', { storeId: storeB, locationId: kitchenB });
    await cookDraft('0.6', { producedOn: D_BEFORE });
    expect(await view()).toEqual([]);
    expect(await view(manager, storeB)).toHaveLength(2);
    expect(await view(manager, storeA, D_BEFORE)).toHaveLength(2);
  });
});

describe('T-419 case 7 - display only: a draft moves nothing and counts nowhere', () => {
  const snapshot = async () => ({
    porkOnHand: await onHand(pork),
    movements: Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements`)[0]!.n),
    actuals: await asOrg(orgA, async (tx) => [...(await stockUsageRepo.usageActualsForDay(tx, storeA, D)).entries()]),
    variances: await asOrg(orgA, (tx) => usageVariancesFor(tx, orgA, storeA, D)),
    close: await asOrg(orgA, (tx) => usageCloseRefusal(tx, orgA, '2026-08-01', '2026-08-31')),
    usageRows: Number((await sql<{ n: string }[]>`select (select count(*) from stock_usage_records) + (select count(*) from stock_usage_lines) as n`)[0]!.n),
  });

  it('draft leg: stock, movements, usage actuals, band verdicts, close refusal and the auto-post sweep are identical with and without the draft', async () => {
    await stockUp();
    const before = await snapshot();
    await cookDraft('0.6');
    // The view must exist and list the draft - otherwise "identical" proves nothing.
    expect((await view()).filter((r) => r.isDraft)).toHaveLength(2);
    const swept = await asOrg(orgA, (tx) => autoPostDueUsageDrafts(tx, new Date('2026-08-11T07:00:00Z')));
    expect(swept.posted).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(before.porkOnHand).toBe('20.000');
  });

  it('posted leg (T-420 edits this leg): on-hand drops 0.500 kg once; actuals, verdicts, close refusal and sweep are unchanged in T-419', async () => {
    await stockUp();
    const before = await snapshot();
    await cookPosted('0.6');
    expect((await view()).filter((r) => !r.isDraft)).toHaveLength(2);
    const swept = await asOrg(orgA, (tx) => autoPostDueUsageDrafts(tx, new Date('2026-08-11T07:00:00Z')));
    expect(swept.posted).toEqual([]);
    const after = await snapshot();
    expect(after.porkOnHand).toBe('19.500');
    expect({ ...after, porkOnHand: before.porkOnHand, movements: before.movements }).toEqual(before);
  });
});

describe('T-419 case 8 - the gate', () => {
  it('8. an actor without record_stock_movement at store A is refused. Mutant: authorize removed', async () => {
    await stockUp();
    await cookDraft('0.6');
    await expect(view(clerk)).rejects.toThrow(/may not/);
  });
});
