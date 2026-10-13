import { config } from 'dotenv';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  buildPlan,
  decideMapRequest,
  finalizeSections,
  requestMap,
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
 * T-177 — buildPlan/finalizeSections, plus the item-map/request workflow they depend on.
 *
 * ⭐ T-375 S5 (S5-lite): usage no longer fetches POS at all. Each day is IMPORTED from the stub fetchers
 * (`importTestDay(…, { soldItems })`) on a store LINKED to POS, and `buildPlan` / `finalizeSections` read the
 * `sold_items` feed the import stored. `fetch` is a spy that throws, so any live call is a red test, and the suite
 * still runs with no network and no POS credentials (§9.3).
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
  return r!.t;
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
  // T-403: mapping is admin-only; the manager keeps everything else.
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

describe('T-177 — 1. physical quantity: POS already nets sold+comped-voided, never recomputed', () => {
  it('⭐ physicalQty 11 (from 10 sold, 2 comped, 1 voided) → 11 consumed, not 10 and not 12', async () => {
    await stockUp(itemCoke, kitchen, '50', '10.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'coke', posItemName: 'Coke', physicalQty: '11' }]));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1',
    }));

    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.find((l) => l.posItemKey === 'coke')?.quantity).toBe('11.000');

    const result = await asOrg(orgA, (tx) =>
      finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [plan.lines[0]!.key] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0]).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect(await onHand(itemCoke)).toBe('39.000');
  });
});

describe('T-177 — 2. a recipe map explodes; an unconvertible unit blocks that line, not the pull', () => {
  it('cheese line converts and finalizes; sauce line is blocked and never offered as confirmable', async () => {
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'samgyup', posItemName: 'Samgyup Box', physicalQty: '5' }]));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'samgyup', posItemName: 'Samgyup Box', mode: 'recipe', recipeId,
    }));

    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines).toHaveLength(2);
    const cheeseLine = plan.lines.find((l) => l.itemId === itemCheese)!;
    const sauceLine = plan.lines.find((l) => l.itemId === itemSauce)!;
    expect(cheeseLine.blocked).toBe(false);
    expect(sauceLine.blocked).toBe(true);

    // Only the cheese key is confirmable/confirmed — the sauce line was never offered.
    const result = await asOrg(orgA, (tx) =>
      finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['recipe'], confirmedKeys: [cheeseLine.key] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0]).toMatchObject({ ok: true, postedLineCount: 1 });
    // 0.2g * 5 / 1 = 1g -> converts to 0.001kg consumed; on-hand = 10 - 0.001
    expect(await onHand(itemCheese)).toBe('9.999');
  });
});

describe('T-177 — 3. a no_stock map consumes nothing and does not appear in the orphan section', () => {
  it('produces no plan line at all', async () => {
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'delivery-fee', posItemName: 'Delivery Fee', physicalQty: '3' }]));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'delivery-fee', posItemName: 'Delivery Fee', mode: 'no_stock',
    }));
    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines).toHaveLength(0);
  });
});

describe('T-177 — 4. an unmapped item is an orphan; request/approve/reject workflow', () => {
  it('requesting writes a request and moves no stock; approving silences it; rejecting returns it to unmapped', async () => {
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'mystery', posItemName: 'Mystery Item', physicalQty: '2' }]));
    const plan1 = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    expect(plan1.lines[0]).toMatchObject({ section: 'orphan', posItemKey: 'mystery' });

    const req = await asOrg(orgA, (tx) => requestMap(tx, staffActor, { orgId: orgA, storeId: storeA, posItemKey: 'mystery', posItemName: 'Mystery Item' }));
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const [reqCount] = await sql<{ c: string }[]>`select count(*)::text as c from pos_map_requests`;
    expect(reqCount!.c).toBe('1');
    const [mapCount] = await sql<{ c: string }[]>`select count(*)::text as c from pos_item_maps`;
    expect(mapCount!.c).toBe('0'); // a request never moves stock or creates a map on its own

    const decided = await asOrg(orgA, (tx) => decideMapRequest(tx, managerActor, { requestId: req.requestId, decision: 'approved' }));
    expect(decided.ok).toBe(true);

    // Approving silences it: re-planning no longer shows it as an orphan.
    const plan2 = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan2.ok).toBe(true);
    if (!plan2.ok) return;
    expect(plan2.lines).toHaveLength(0);
  });

  it('rejecting returns the item to unmapped — it reappears as an orphan', async () => {
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'mystery2', posItemName: 'Mystery Item 2', physicalQty: '1' }]));
    const req = await asOrg(orgA, (tx) => requestMap(tx, staffActor, { orgId: orgA, storeId: storeA, posItemKey: 'mystery2', posItemName: 'Mystery Item 2' }));
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const decided = await asOrg(orgA, (tx) => decideMapRequest(tx, managerActor, { requestId: req.requestId, decision: 'rejected' }));
    expect(decided.ok).toBe(true);

    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0]).toMatchObject({ section: 'orphan', posItemKey: 'mystery2' });
  });
});

describe('T-177 — 5/6. PLAN_CHANGED: the confirm-what-you-saw write contract', () => {
  it('⭐ changing the MAPPING between plan and finalize refuses the finalize, and nothing is written', async () => {
    await stockUp(itemCoke, kitchen, '50', '10.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'coke', posItemName: 'Coke', physicalQty: '11' }]));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1',
    }));

    const plan = await asOrg(orgA, (tx) =>
      buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const confirmedKey = plan.lines[0]!.key;

    // T-375 S5: usage reads a STORED feed, so the POS data cannot change under a plan (a changed feed hits the
    // "changed" sentence first, U3). What can still move is the mapping: coke stops being a stock item, so the
    // rebuild no longer produces the confirmed key.
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'coke', posItemName: 'Coke', mode: 'no_stock',
    }));
    const result = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [confirmedKey] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/PLAN_CHANGED/);
    expect(await onHand(itemCoke)).toBe('50.000');
  });

  it('⭐ a rebuild key absent from the confirmed list is not written — a naive implementation passes only the other direction', async () => {
    await stockUp(itemCoke, kitchen, '50', '10.0000', '2026-08-01');
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'coke', posItemName: 'Coke', physicalQty: '11' }]));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1',
    }));
    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // Confirm NOTHING — the client saw the plan but ticked no boxes.
    const result = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0]).toMatchObject({ ok: true, postedLineCount: 0 });
    expect(await onHand(itemCoke)).toBe('50.000');
  });
});

describe('T-177 — 7. SNAPSHOT_STALE: a 61-minute-old snapshot is refused', () => {
  it('refuses finalize outright, before any live re-fetch', async () => {
    const dayId = await makeSalesDay('2026-08-20', sold([]));
    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    await sql`update pos_usage_pulls set snapshot_taken_at = now() - interval '61 minutes' where id = ${plan.pullId}`;

    const result = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/SNAPSHOT_STALE/);
  });
});

describe('T-177 — 8. finalizing one section leaves the others open; a second finalize of the same section is refused', () => {
  it('finalizing direct does not touch recipe/orphan; finalizing direct again is refused', async () => {
    await stockUp(itemCoke, kitchen, '50', '10.0000', '2026-08-01');
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([
      { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '11' },
      { posItemKey: 'samgyup', posItemName: 'Samgyup Box', physicalQty: '5' },
      { posItemKey: 'mystery', posItemName: 'Mystery Item', physicalQty: '1' },
    ]));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1' }));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: 'samgyup', posItemName: 'Samgyup Box', mode: 'recipe', recipeId }));

    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const directKey = plan.lines.find((l) => l.section === 'direct')!.key;

    const first = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [directKey] }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.sections[0]!.ok).toBe(true);

    const [row] = await sql<{ direct: Date | null; recipe: Date | null; orphan: Date | null; status: string }[]>`
      select direct_finalized_at as direct, recipe_finalized_at as recipe, orphan_finalized_at as orphan, status
      from pos_usage_pulls where id = ${plan.pullId}`;
    expect(row!.direct).not.toBeNull();
    expect(row!.recipe).toBeNull();
    expect(row!.orphan).toBeNull();
    expect(row!.status).toBe('planned');

    const second = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [directKey] }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.sections[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/already finalized/) });
    // Not re-posted — still 39, not 28.
    expect(await onHand(itemCoke)).toBe('39.000');
  });
});

describe('T-177 — 9. finalizing posts through T-164 — cost asserted', () => {
  it('raw_material -> food -> 5100, FIFO cost = 11 @ 10.00', async () => {
    await stockUp(itemCoke, kitchen, '50', '10.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'coke', posItemName: 'Coke', physicalQty: '11' }]));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1' }));
    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const result = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [plan.lines[0]!.key] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const b = await balances();
    // itemCoke is 'retail' kind -> cogsCategoryForItemKind('retail') = 'retail'. Retail's inventory
    // account per COA-ALIGNMENT is 1320; its COGS account is asserted here, whichever the shared
    // routing table names, so this test breaks the moment that routing table drifts.
    const posted = await sql<{ n: string }[]>`select count(*)::text as n from pos_usage_pull_lines where usage_record_id is not null`;
    expect(posted[0]!.n).toBe('1');
    expect(Object.values(b).some((v) => v !== '0.00' && v !== undefined)).toBe(true);
  });
});

describe('T-177 — 10. (T-388 I4) a frozen room waits: its lines are held, the rest post, and finalize again posts them', () => {
  it('kitchen frozen, display not — display posts, kitchen is held as frozen and the section is NOT stamped; after the count is cancelled finalize again posts it and stamps. Mutant: stamp regardless -> red', async () => {
    await stockUp(itemCoke, kitchen, '50', '10.0000', '2026-08-01');
    await stockUp(itemCheese, display, '10', '50.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([
      { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '5' },
      { posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', physicalQty: '2' },
    ]));
    // Coke resolves to kitchen (no override); cheese-as-direct resolves to display (its own override).
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1' }));
    await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', mode: 'direct', itemId: itemCheese, quantityPerSale: '1', locationId: display }));

    const sessionId = await freezeKitchen();

    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const keys = plan.lines.map((l) => l.key);
    const cokeKey = plan.lines.find((l) => l.posItemKey === 'coke')!.key;
    // sanity: the fixture really has stock in both rooms, so a hold can only be the freeze
    expect(await onHand(itemCoke, kitchen)).toBe('50.000');
    expect(await onHand(itemCheese, display)).toBe('10.000');

    const result = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: keys }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0]).toMatchObject({ ok: true, postedLineCount: 1, finalized: false });
    expect(result.sections[0]!.held).toHaveLength(1);
    expect(result.sections[0]!.held[0]).toMatchObject({ key: cokeKey, cause: 'frozen' });
    expect(result.sections[0]!.heldSentences).toContain(
      'Kitchen is being counted, so 1 line(s) there wait. Finish or cancel the count, then finalize again.',
    );
    // Display's cheese posted (10 - 2 consumed = 8); kitchen's coke did not (still 50).
    expect(await onHand(itemCheese, display)).toBe('8.000');
    expect(await onHand(itemCoke, kitchen)).toBe('50.000');
    const [mid] = await sql<{ direct: Date | null; status: string }[]>`select direct_finalized_at as direct, status from pos_usage_pulls where id = ${plan.pullId}`;
    expect(mid!.direct, 'a section with a held line is not stamped').toBeNull();
    expect(mid!.status).toBe('planned');

    await sql`update count_sessions set status = 'cancelled', closed_by = ${managerId}, closed_at = now() where id = ${sessionId}`;
    const again = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: keys }));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.sections[0]).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect(await onHand(itemCoke, kitchen)).toBe('45.000');
    expect(await onHand(itemCheese, display), 'display is not posted a second time').toBe('8.000');
    const [end] = await sql<{ direct: Date | null }[]>`select direct_finalized_at as direct from pos_usage_pulls where id = ${plan.pullId}`;
    expect(end!.direct).not.toBeNull();
  });
});

describe('T-177 — 11. ⭐ meat maps and pulls normally — the carve-out is gone (§4)', () => {
  it('a meat_slab item maps direct and finalizes exactly like any other kind', async () => {
    await stockUp(itemMeat, kitchen, '20', '300.0000', '2026-08-01');
    const dayId = await makeSalesDay('2026-08-20', sold([{ posItemKey: 'pork-skewers', posItemName: 'Pork Skewers', physicalQty: '10' }]));
    const upserted = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'pork-skewers', posItemName: 'Pork Skewers', mode: 'direct', itemId: itemMeat, quantityPerSale: '0.5',
    }));
    expect(upserted.ok).toBe(true);

    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0]).toMatchObject({ itemId: itemMeat, quantity: '5.000', blocked: false });

    const result = await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [plan.lines[0]!.key] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0]).toMatchObject({ ok: true, postedLineCount: 1 });
    expect(await onHand(itemMeat)).toBe('15.000');
  });
});

describe('T-177 — 12. a second direct map onto an already-mapped item needs confirmation', () => {
  it('refused without confirmation, accepted with it', async () => {
    const first = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'coke-can', posItemName: 'Coke Can', mode: 'direct', itemId: itemCoke, quantityPerSale: '1',
    }));
    expect(first.ok).toBe(true);

    const second = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'coke-bottle', posItemName: 'Coke Bottle', mode: 'direct', itemId: itemCoke, quantityPerSale: '1',
    }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.needsConfirmation).toBe(true);

    const confirmed = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, {
      orgId: orgA, storeId: storeA, posItemKey: 'coke-bottle', posItemName: 'Coke Bottle', mode: 'direct', itemId: itemCoke, quantityPerSale: '1', confirmShared: true,
    }));
    expect(confirmed.ok).toBe(true);
  });

  it('a recipe map never needs confirmation, even sharing a recipe already used elsewhere', async () => {
    const first = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: 'samgyup-a', posItemName: 'Samgyup A', mode: 'recipe', recipeId }));
    expect(first.ok).toBe(true);
    const second = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, { orgId: orgA, storeId: storeA, posItemKey: 'samgyup-b', posItemName: 'Samgyup B', mode: 'recipe', recipeId }));
    expect(second.ok).toBe(true);
  });
});

describe('T-177 — the authorize() boundary', () => {
  it('⛔ staff may NOT manage_pos_map', async () => {
    await expect(
      asOrg(orgA, (tx) => upsertPosItemMap(tx, staffActor, { orgId: orgA, storeId: storeA, posItemKey: 'x', posItemName: 'X', mode: 'no_stock' })),
    ).rejects.toThrow(/may not 'manage_pos_map'/);
  });

  it('✅ staff MAY request_pos_map', async () => {
    const res = await asOrg(orgA, (tx) => requestMap(tx, staffActor, { orgId: orgA, storeId: storeA, posItemKey: 'x', posItemName: 'X' }));
    expect(res.ok).toBe(true);
  });

  it('⛔ staff may NOT finalize_pos_usage_pull', async () => {
    const dayId = await makeSalesDay('2026-08-20', sold([]));
    const plan = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await expect(
      asOrg(orgA, (tx) => finalizeSections(tx, staffActor, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: [] })),
    ).rejects.toThrow(/may not 'finalize_pos_usage_pull'/);
  });
});

describe('T-177 invariant 12 — one live pull per (store, sales day)', () => {
  it('a second plan for a day already planned refreshes it rather than erroring, but a FINALIZED day refuses a new one', async () => {
    const dayId = await makeSalesDay('2026-08-20', sold([]));
    const plan1 = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan1.ok).toBe(true);
    if (!plan1.ok) return;
    const plan2 = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: display }));
    expect(plan2.ok).toBe(true);
    if (!plan2.ok) return;
    expect(plan2.pullId).toBe(plan1.pullId);

    await asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId: plan1.pullId, sections: ['direct', 'recipe', 'orphan'], confirmedKeys: [] }));

    const plan3 = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
    expect(plan3.ok).toBe(false);
  });
});
