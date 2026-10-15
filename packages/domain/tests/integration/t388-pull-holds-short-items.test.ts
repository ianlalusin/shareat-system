import { config } from 'dotenv';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  buildPlan,
  finalizeSections,
  pullHolds,
  upsertPosItemMap,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import type { PosV1SoldItemInput } from '../../../db/src/pos-v1/fixtures';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-388 S1 - DEF-618 - RETIRED by T-401 S6 (Ian 15 Oct): the pull no longer posts stock, so there is nothing to hold for short
 * stock, a room under count or a room that cannot take usage. The nineteen T-388 cases (I1-I12 and the R-numbered follow-ups) are
 * replaced by the ONE test at the bottom; the orchestrator records the retirement (the retired names are in the tester's report).
 * Real Postgres; the fixture is pos-usage-pull.test.ts's. What the old file's guards meant now lives at POST time of the draft
 * (`t401-s6-pull-draft.test.ts`: a frozen room refuses the auto-post and leaves the draft).
 *
 * Contract coded against (the spec left these open; the builder reconciles, never these tests):
 *  - `SectionOutcome` = { section, ok, reason?, postedLineCount, held: HeldLine[], heldSentences: string[], finalized }.
 *  - `heldSentences` holds one R11 sentence per held (item, room), then the closing untick sentence; tests use toContain.
 *  - `pullHolds(tx, orgId, pullId)` is exported from `@shareat/domain` (usage-pull.ts), a Map<lineKey, sentence> with the
 *    per-line sentence WITHOUT the closing untick sentence.
 *  - An unexpected failure inside the per-room post is RE-THROWN (the call rejects); a R8 refusal is read by
 *    `refusalOf`, which accepts either `{ ok: false, reason }` or a thrown refusal (the spec says only "refused").
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "shareat_test".`,
  );
}

const sql = postgres(url, { max: 5 });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let orgA: string, storeA: string, staffId: string, managerId: string, walkInA: string;
let kitchen: string, display: string, stockroom: string;
let itemCoke: string, itemCheese: string, itemSauce: string, itemMeat: string;
let recipeId: string;
let staffActor: Actor, managerActor: Actor, adminActor: Actor;

const locations = (): LocationLike[] => [
  { id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
  { id: display, role: 'operating', purpose: 'normal', isDefault: false, status: 'active' },
  { id: stockroom, role: 'storage', purpose: 'normal', isDefault: false, status: 'active' },
];

async function onHand(itemId: string, loc = kitchen): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${loc}`;
  return Number(r!.t).toFixed(3); // no rows sums to '0': normalise to the 3-decimal form the assertions use
}

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

async function stockUp(itemId: string, loc: string, qty: string, cost: string, day: string) {
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p-' + itemId + '-' + day + '.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${staffId}) returning id`;
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${storeA},'purchase',${day},${f!.id},${staffId}) returning id`;
  await asOrg(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: day,
      locations: locations(), receivedBy: staffId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId: loc }],
    }),
  );
}

/** A PHP 0 day with no receipts: POS answers `found: false` for it, and an empty plan is right only then (S5 I5). */
const ZERO_FIGURES = { paidTotal: 0, receiptCount: 0, packageOnly: 0, discounts: 0, charges: 0, methods: {} };

/** The sold items of a day, in the shape the test payload builder takes. Was the injected live-POS snapshot. */
function sold(items: { posItemKey: string; posItemName: string; physicalQty: string }[]): PosV1SoldItemInput[] {
  return items.map((i) => ({ key: i.posItemKey, name: i.posItemName, physicalQty: Number(i.physicalQty) }));
}

/** A day IMPORTED from POS on the LINKED store: its `sold_items` feed is what the usage plan reads. An empty list is a
 *  PHP 0 day (`found: false`), because a day with sales and no sold items is refused. */
async function makeSalesDay(businessDate: string, soldItems: PosV1SoldItemInput[]): Promise<string> {
  const { id } = await asOrg(orgA, (tx) =>
    importTestDay(tx, staffActor, { storeId: storeA, businessDate, soldItems, ...(soldItems.length === 0 ? { figures: ZERO_FIGURES } : {}) }),
  );
  return id;
}

async function freezeKitchen(): Promise<string> {
  const [s] = await sql<{ id: string }[]>`
    insert into count_sessions (org_id, store_id, status, counted_on, opened_by)
    values (${orgA},${storeA},'open','2026-08-20',${managerId}) returning id`;
  await sql`insert into count_session_locations (session_id, location_id) values (${s!.id}, ${kitchen})`;
  return s!.id;
}

const fetchSpy = vi.fn(async (..._args: unknown[]) => {
  throw new Error('LIVE POS FETCH: usage must read the stored feed, never call POS');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  await sql`
    truncate table pos_usage_pull_lines, pos_usage_pulls, pos_map_requests, pos_item_maps,
      production_record_lines, production_records, production_recipe_lines, production_recipes,
      count_lines, count_session_locations, count_sessions,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      sales_day_channels, sales_day_tenders, sales_days,
      stock_locations, location_types, departments,
      person_store_scope, person_roles,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;

  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Staffer') returning id`;
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Manager') returning id`;
  staffId = staff!.id;
  managerId = manager!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${orgA}, 'staff')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgA}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffId}, ${storeA})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeA})`;
  staffActor = { personId: staffId, orgId: orgA };
  managerActor = { personId: managerId, orgId: orgA };
  // T-403: mapping is admin-only.
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgA}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeA})`;
  adminActor = { personId: admin!.id, orgId: orgA };

  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [rk] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${staffId}) returning id`;
  const [rd] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, created_by) values (${orgA},${storeA},'DISP','Display',${t!.id},'operating',${staffId}) returning id`;
  const [rs] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgA},${storeA},'STORE','Stockroom',${t!.id},${staffId}) returning id`;
  kitchen = rk!.id; display = rd!.id; stockroom = rs!.id;

  const [ic] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Coke','retail','pcs',${staffId}) returning id`;
  const [ich] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Cheese','raw_material','kg',${staffId}) returning id`;
  const [isc] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Sauce','raw_material','pcs',${staffId}) returning id`;
  const [im] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Pork Slab','meat_slab','kg',${staffId}) returning id`;
  itemCoke = ic!.id; itemCheese = ich!.id; itemSauce = isc!.id; itemMeat = im!.id;

  const [r] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
    values (${orgA}, 'Samgyup Box', ${itemCheese}, 1, ${staffId}) returning id`;
  recipeId = r!.id;
  // Cheese line converts fine (g -> kg). Sauce line is unconvertible (pcs recipe-unit "box").
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipeId}, ${itemCheese}, 0.2, 'g')`;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipeId}, ${itemSauce}, 1, 'box')`;

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgA}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;
  await seedChartOfAccounts(sql, orgA);

  // T-375 S5: the store is LINKED to POS, with the tenders D1's methods resolve to; days are imported, never typed.
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgA}, ${storeA}, 'Walk-in', true) returning id`;
  walkInA = ch!.id;
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgA}, ${storeA}, 'GCash - A One', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId: orgA, storeId: storeA, channelId: walkInA, createdBy: managerId });
  await seedTestTenders(sql, { orgId: orgA, storeId: storeA, walletAccountId: gcash!.id });

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgA}, ${storeA}, ${staffId}, 'SE-001', 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId: orgA, storeId: storeA, employmentId: staffEmployment!.id, personId: staffId, setBy: managerId,
  });
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-388 retired (T-401 S6): the pull holds nothing, because it posts nothing', () => {
  it('Kitchen has Coke 0 and Cheese 10, and is being counted; sold Coke 3 and Cheese 2: finalize is ok with NO hold and NO stock written, the section is stamped, and both lines (the short one too) are in the day draft at expected', async () => {
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([
      { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '3' },
      { posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', physicalQty: '2' },
    ]));
    for (const [key, name, item] of [['coke', 'Coke', itemCoke], ['cheese-direct', 'Cheese Direct', itemCheese]] as const) {
      const r = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: key, posItemName: name, mode: 'direct', itemId: item, quantityPerSale: '1' }));
      expect(r.ok).toBe(true);
    }
    await freezeKitchen();
    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(await onHand(itemCoke), 'sanity: Coke is short').toBe('0.000');

    const balancesBefore = await balances();
    const out = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: plan.lines.map((l) => l.key) }));
    expect(out.ok, out.ok ? '' : out.reason).toBe(true);
    if (!out.ok) return;
    expect(out.sections[0]).toMatchObject({ ok: true, postedLineCount: 0, held: [], heldSentences: [], finalized: true });
    expect((await asOrg(orgA, (tx) => pullHolds(tx, orgA, plan.pullId))).size, 'pullHolds is always empty').toBe(0);
    expect(await onHand(itemCoke)).toBe('0.000');
    expect(await onHand(itemCheese)).toBe('10.000');
    expect(await balances(), 'no journal line').toEqual(balancesBefore);
    const [mv] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${orgA} and quantity < 0`;
    expect(mv!.n, 'no stock out').toBe('0');
    const lines = await sql<{ item_id: string; quantity: string }[]>`
      select l.item_id, l.quantity::text as quantity from stock_usage_records r join stock_usage_lines l on l.record_id = r.id
       where r.store_id = ${storeA} and r.status = 'draft' and r.kind = 'usage'`;
    expect(Object.fromEntries(lines.map((l) => [l.item_id, l.quantity]))).toEqual({ [itemCoke]: '3.000', [itemCheese]: '2.000' });
    const [pull] = await sql<{ direct: Date | null }[]>`select direct_finalized_at as direct from pos_usage_pulls where id = ${plan.pullId}`;
    expect(pull!.direct).not.toBeNull();
  });
});
