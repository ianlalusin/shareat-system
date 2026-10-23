/**
 * T-401 S5 shared fixture (TESTER). Raw SQL for everything the code under test is NOT the subject of, so a red test names
 * the function it proves. One ORG PER CALL (uid-unique codes, no truncation), so several files can share one database.
 *
 * A world = one org, stores A (multi_room: Kitchen default, Display, Stockroom) and B (Kitchen), both LINKED to POS with tenders,
 * the whole of 2026 open for stock periods, a chart of accounts, and: admin (every store), manager (A and B), staff.
 * Stock items: Coke (retail, pcs), Cheese (raw, kg), Sauce (raw, pcs), Pork (raw, kg), Rice (raw, kg).
 * Menu variants are made raw (a menu item + default variant + a rule); links and switches are made raw too, so that a test
 * of the usage plan does not depend on linkPosV1Item / switchUsageSource (which are other tests' subject).
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import type { PosV1SoldItemInput } from '../../../db/src/pos-v1/fixtures';
import { testItemCode } from './_fixtures/item-code';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
export const sql = postgres(url, { max: 5 });
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export interface StoreRooms { storeId: string; kitchen: string; display?: string; stockroom?: string }
export interface World {
  orgId: string;
  a: StoreRooms;
  b: StoreRooms;
  admin: Actor;
  superAdmin: Actor;
  manager: Actor;
  staff: Actor;
  coke: string; cheese: string; sauce: string; pork: string; rice: string;
  /** recipe: output Cheese 1 kg, lines Cheese 0.2 g->kg... (kept simple: Cheese 200 g + Sauce 1 pcs per 1 unit). */
  recipeId: string;
}

export const FIGURES_ZERO = { paidTotal: 0, receiptCount: 0, packageOnly: 0, discounts: 0, charges: 0, methods: {} };

export async function world(hint: string): Promise<World> {
  const code = uid(`t401s5-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const mkStore = async (c: string, name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${c}, ${name}, 'multi_room') returning id`;
    return s!.id;
  };
  const storeA = await mkStore('A1', 'Lipa');
  const storeB = await mkStore('B1', 'Malvar');
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [storeA, storeB]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await person('Admin', 'admin');
  const superId = await person('Super', 'super_admin');
  const managerId = await person('Manager', 'manager');
  const staffId = await person('Staffer', 'staff');
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const room = async (storeId: string, c: string, name: string, role: 'operating' | null, isDefault: boolean) => {
    const [r] = role
      ? await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgId}, ${storeId}, ${c}, ${name}, ${t!.id}, ${role}, ${isDefault}, ${adminId}) returning id`
      : await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgId}, ${storeId}, ${c}, ${name}, ${t!.id}, ${adminId}) returning id`;
    return r!.id;
  };
  const kitchenA = await room(storeA, 'KIT', 'Kitchen', 'operating', true);
  const displayA = await room(storeA, 'DISP', 'Display', 'operating', false);
  const stockroomA = await room(storeA, 'STORE', 'Stockroom', null, false);
  const kitchenB = await room(storeB, 'KIT', 'Kitchen', 'operating', true);

  const item = async (name: string, kind: string, unit: string) => {
    const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, ${name}, ${kind}, ${unit}, ${adminId}) returning id`;
    return i!.id;
  };
  const coke = await item('Coke', 'retail', 'pcs');
  const cheese = await item('Cheese', 'raw_material', 'kg');
  const sauce = await item('Sauce', 'raw_material', 'pcs');
  const pork = await item('Pork', 'raw_material', 'kg');
  const rice = await item('Rice', 'raw_material', 'kg');
  const [r] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${orgId}, 'Samgyup Box', ${cheese}, 1, ${adminId}) returning id`;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${cheese}, 0.2, 'kg')`;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${rice}, 0.1, 'kg')`;

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;
  await seedChartOfAccounts(sql, orgId);

  for (const [sid, tag] of [[storeA, 'A'], [storeB, 'B']] as const) {
    const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${sid}, 'Walk-in', true) returning id`;
    const [g] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${sid}, ${'GCash - ' + tag}, 'ewallet', '1140', 'cashier') returning id`;
    await linkTestStore(sql, { orgId, storeId: sid, channelId: ch!.id, createdBy: managerId });
    await seedTestTenders(sql, { orgId, storeId: sid, walletAccountId: g!.id });
  }
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeA}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId: storeA, employmentId: emp!.id, personId: staffId, setBy: managerId });

  return {
    orgId,
    a: { storeId: storeA, kitchen: kitchenA, display: displayA, stockroom: stockroomA },
    b: { storeId: storeB, kitchen: kitchenB },
    admin: { personId: adminId, orgId },
    superAdmin: { personId: superId, orgId },
    manager: { personId: managerId, orgId },
    staff: { personId: staffId, orgId },
    coke, cheese, sauce, pork, rice,
    recipeId: r!.id,
  };
}

/** A PHP-0-day-safe import of a stored v1 day on a LINKED store; its sold_items feed is what the usage plan reads. */
export function sold(items: { key: string; name?: string; qty: number }[]): PosV1SoldItemInput[] {
  return items.map((i) => ({ key: i.key, name: i.name ?? i.key, physicalQty: i.qty }));
}
export async function makeDay(w: World, storeId: string, businessDate: string, items: PosV1SoldItemInput[]): Promise<string> {
  const { id } = await asOrg(w.orgId, (tx) =>
    importTestDay(tx, w.manager, { storeId, businessDate, soldItems: items, ...(items.length === 0 ? { figures: FIGURES_ZERO } : {}) }),
  );
  return id;
}

/** Stock a room (a delivery), so a finalize has something to consume. */
export async function stockUp(w: World, storeId: string, locationId: string, itemId: string, qty: string, day = '2026-08-01') {
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${w.orgId}, ${'orgs/' + w.orgId + '/p-' + itemId + '-' + uid('f') + '.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${w.staff.personId}) returning id`;
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by) values (${w.orgId}, ${storeId}, 'purchase', ${day}, ${f!.id}, ${w.staff.personId}) returning id`;
  const locations: LocationLike[] = [
    { id: locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
  ];
  await asOrg(w.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: w.orgId, storeId, deliveryId: d!.id, deliveredOn: day, locations, receivedBy: w.staff.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: '50.0000', locationId }],
    }),
  );
}

// ---- raw menu + link + switch + map fixtures ---------------------------------------------------------------------------
export interface RuleShape {
  mode: 'direct' | 'recipe' | 'no_stock';
  itemId?: string;
  recipeId?: string;
  quantityPerSale?: string;
  /** an instant; default = the database now() */
  effectiveFrom?: Date;
}

/** A menu category + item + default variant, by raw SQL. Returns the variant id. */
export async function rawVariant(w: World, name: string): Promise<string> {
  let [cat] = await sql<{ id: string }[]>`select id from menu_categories where org_id = ${w.orgId} limit 1`;
  if (!cat) [cat] = await sql<{ id: string }[]>`insert into menu_categories (org_id, name, sort_order, status, created_by) values (${w.orgId}, 'Cat', 0, 'active', ${w.admin.personId}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${w.orgId}, ${cat!.id}, ${name}, 'a_la_carte', true, false, true, 0, 'active', ${w.admin.personId}) returning id`;
  const [v] = await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by) values (${w.orgId}, ${item!.id}, null, true, 0, 'active', ${w.admin.personId}) returning id`;
  return v!.id;
}

/** A depletion rule row, by raw SQL (effective_from defaults to now(); a FUTURE instant is a scheduled rule). */
export async function rawRule(w: World, variantId: string, r: RuleShape): Promise<string> {
  const from = r.effectiveFrom ?? null;
  const [row] = await sql<{ id: string }[]>`
    insert into menu_depletion_rules (org_id, variant_id, mode, item_id, recipe_id, quantity_per_sale, effective_from, created_by)
    values (${w.orgId}, ${variantId}, ${r.mode}, ${r.itemId ?? null}, ${r.recipeId ?? null}, ${r.quantityPerSale ?? null}, coalesce(${from}::timestamptz, now()), ${w.admin.personId}) returning id`;
  return row!.id;
}

/** A link, raw. The variant must already have a rule in force (the S1 trigger). */
export async function rawLink(w: World, storeId: string, posItemKey: string, variantId: string, locationId: string | null = null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into menu_pos_v1_links (org_id, store_id, pos_item_key, variant_id, location_id, status, created_by)
    values (${w.orgId}, ${storeId}, ${posItemKey}, ${variantId}, ${locationId}, 'active', ${w.admin.personId}) returning id`;
  return row!.id;
}

/** A switch row, raw (the insert trigger stamps created_at = now()). */
export async function rawSwitch(w: World, storeId: string, source: 'menu_rules' | 'v1_pos_map', reason: string | null = null, differenceCount: number | null = 0): Promise<void> {
  await sql`
    insert into menu_usage_source_switches (org_id, store_id, source, reason, difference_count, created_by)
    values (${w.orgId}, ${storeId}, ${source}, ${reason}, ${differenceCount}, ${w.admin.personId})`;
}

/** A pos_item_maps row, raw (so a test of the plan does not depend on upsertPosItemMap). */
export async function rawMap(
  w: World,
  storeId: string,
  posItemKey: string,
  m: { mode: 'direct' | 'recipe' | 'no_stock'; itemId?: string; recipeId?: string; quantityPerSale?: string; locationId?: string | null; name?: string },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into pos_item_maps (org_id, store_id, pos_item_key, pos_item_name, mode, item_id, recipe_id, quantity_per_sale, location_id, status, created_by)
    values (${w.orgId}, ${storeId}, ${posItemKey}, ${m.name ?? posItemKey}, ${m.mode}, ${m.itemId ?? null}, ${m.recipeId ?? null}, ${m.quantityPerSale ?? null}, ${m.locationId ?? null}, 'active', ${w.admin.personId}) returning id`;
  return row!.id;
}

/** A refusal as a sentence, whether the code returns it ({ ok:false, reason }) or throws it; null when it succeeded. */
export async function refusalOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    const r = (await run()) as { ok?: boolean; reason?: string } | undefined;
    if (r && typeof r === 'object' && r.ok === false) return r.reason ?? '(refused)';
    return null;
  } catch (e) {
    const err = e as { userMessage?: unknown };
    // only a REFUSAL (a sentence for the user) counts: a TypeError (function not built yet) or an AuthorizationError is a real failure
    if (typeof err.userMessage === 'string') return err.userMessage;
    throw e;
  }
}

// ---- the contract the BUILDER must meet (assumed by the tester; every name is in the tester's report) ---------------------
import * as domainModule from '@shareat/domain';
import * as dbModule from '@shareat/db';

export interface SourceDifference {
  /** business date 'YYYY-MM-DD' for a day-feed difference; null/undefined for a standing link-vs-map difference */
  businessDate?: string | null;
  posItemKey: string;
  kind?: string;
}
export interface Comparison { differenceCount: number; differences: SourceDifference[] }
export type UsageSource = 'v1_pos_map' | 'menu_rules';
export const s5 = domainModule as unknown as {
  linkPosV1Item(actor: Actor, input: { storeId: string; posItemKey: string; variantId: string; locationId?: string | null }, tx?: Tx): Promise<{ id: string }>;
  unlinkPosV1Item(actor: Actor, input: { storeId: string; posItemKey: string }, tx?: Tx): Promise<unknown>;
  seedLinkFromMap(actor: Actor, input: { storeId: string; posItemKey: string; variantId: string }, tx?: Tx): Promise<unknown>;
  compareDepletionSources(actor: Actor, input: { storeId: string; days?: number }, tx?: Tx): Promise<Comparison>;
  switchUsageSource(
    actor: Actor,
    input: { storeId: string; source: UsageSource; acceptDifferences?: boolean; reason?: string },
    tx?: Tx,
  ): Promise<unknown>;
  setDepletionRule(actor: Actor, input: Record<string, unknown>, tx?: Tx): Promise<{ id: string }>;
  cancelScheduledDepletionRule(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string }>;
  setItemStatus(tx: Tx | null, actor: Actor, input: { itemId: string; status: 'active' | 'inactive' }): Promise<{ changed: boolean }>;
};
export const repoS5 = dbModule as unknown as {
  menuRepo: { usageSourceInForce(tx: Tx, storeId: string): Promise<UsageSource> };
  itemsRepo: { retireReadout(tx: Tx, orgId: string, itemId: string): Promise<{ activePosMaps: number; activeRecipes: number; activeMenuRules?: number }> };
};

export async function count(table: string, orgId: string): Promise<number> {
  // pos_usage_pull_lines has no org_id: count through its pulls
  const q = table === 'pos_usage_pull_lines'
    ? `select count(*)::text as n from pos_usage_pull_lines l join pos_usage_pulls p on p.id = l.pull_id where p.org_id = '${orgId}'`
    : `select count(*)::text as n from ${table} where org_id = '${orgId}'`;
  const [r] = await sql.unsafe<{ n: string }[]>(q);
  return Number(r!.n);
}
