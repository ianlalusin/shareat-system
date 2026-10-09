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
  voidPosUsagePull,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { transferNow } from '../../src/stock/transfers';
import { postUsage, saveUsageDraft } from '../../src/stock/usage-records';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import type { PosV1SoldItemInput } from '../../../db/src/pos-v1/fixtures';

/**
 * T-388 S1 - DEF-618: a POS usage pull posts every line that has stock and holds back only the short items
 * (`docs/tasks/388-pull-short-stock-per-item.md`, cases I1..I12). Real Postgres; the fixture is pos-usage-pull.test.ts's.
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
let staffActor: Actor, managerActor: Actor;

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

  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [rk] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${staffId}) returning id`;
  const [rd] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, created_by) values (${orgA},${storeA},'DISP','Display',${t!.id},'operating',${staffId}) returning id`;
  const [rs] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgA},${storeA},'STORE','Stockroom',${t!.id},${staffId}) returning id`;
  kitchen = rk!.id; display = rd!.id; stockroom = rs!.id;

  const [ic] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'COKE','Coke','retail','pcs',${staffId}) returning id`;
  const [ich] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'CHEESE','Cheese','raw_material','kg',${staffId}) returning id`;
  const [isc] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'SAUCE','Sauce','raw_material','pcs',${staffId}) returning id`;
  const [im] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'PORKSLAB','Pork Slab','meat_slab','kg',${staffId}) returning id`;
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

// ------------------------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------------------------
const DAY = '2026-08-20';
const CLOSING = 'Or untick a held line to finalize without it.';
const cokeSentence = (onHandText: string, need = '3') =>
  `Coke: ${need} pcs sold, ${onHandText} on hand in Kitchen. Receive or count it, then finalize again.`;

async function mapDirect(posItemKey: string, posItemName: string, itemId: string, locationId?: string) {
  const r = await asOrg(orgA, (tx) => upsertPosItemMap(tx, managerActor, {
    orgId: orgA, storeId: storeA, posItemKey, posItemName, mode: 'direct', itemId, quantityPerSale: '1',
    ...(locationId ? { locationId } : {}),
  }));
  expect(r.ok, r.ok ? '' : String((r as { reason?: string }).reason)).toBe(true);
}
async function mapRecipe(posItemKey: string, posItemName: string, recipe: string) {
  const r = await asOrg(orgA, (tx) => upsertPosItemMap(tx, managerActor, { orgId: orgA, storeId: storeA, posItemKey, posItemName, mode: 'recipe', recipeId: recipe }));
  expect(r.ok, r.ok ? '' : String((r as { reason?: string }).reason)).toBe(true);
}
async function planOf(dayId: string) {
  const p = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: dayId, locationId: kitchen }));
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  return p;
}
type SectionName = 'direct' | 'recipe' | 'orphan';
const finalize = (pullId: string, sections: SectionName[], confirmedKeys: string[]) =>
  asOrg(orgA, (tx) => finalizeSections(tx, managerActor, { pullId, sections, confirmedKeys }));
async function mustFinalize(pullId: string, sections: SectionName[], confirmedKeys: string[]) {
  const r = await finalize(pullId, sections, confirmedKeys);
  if (!r.ok) throw new Error(`finalize refused: ${r.reason}`);
  return r.sections;
}
/** A refusal as a sentence, whether the builder returns it or throws it. */
async function refusalOf(run: () => Promise<{ ok: boolean; reason?: string }>): Promise<string | null> {
  try {
    const r = await run();
    return r.ok ? null : (r.reason ?? '');
  } catch (e) {
    const err = e as { userMessage?: string; message?: string };
    return err.userMessage ?? err.message ?? String(e);
  }
}
async function outCount(itemId: string): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where item_id = ${itemId} and quantity < 0`;
  return Number(r!.n);
}
async function usageCount(): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from stock_usage_records where org_id = ${orgA}`;
  return Number(r!.n);
}
async function pullRow(pullId: string) {
  const [r] = await sql<{ direct: Date | null; recipe: Date | null; status: string }[]>`
    select direct_finalized_at as direct, recipe_finalized_at as recipe, status from pos_usage_pulls where id = ${pullId}`;
  return r!;
}
async function storedLine(pullId: string, key: string) {
  const [r] = await sql<{ item_id: string | null; location_id: string | null; quantity: string | null; usage_record_id: string | null }[]>`
    select item_id, location_id, quantity::text as quantity, usage_record_id from pos_usage_pull_lines where pull_id = ${pullId} and line_key = ${key}`;
  return r;
}
async function newRecipe(name: string, outputItem: string, lines: { itemId: string; quantity: string; unit: string }[]): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${orgA}, ${name}, ${outputItem}, 1, ${staffId}) returning id`;
  await setRecipeLines(r!.id, lines);
  return r!.id;
}
/** Delete + insert in order, so the heap order (which `getRecipesForExplosion` returns, unordered) is the ingredient order. */
async function setRecipeLines(recipe: string, lines: { itemId: string; quantity: string; unit: string }[]) {
  await sql`delete from production_recipe_lines where recipe_id = ${recipe}`;
  for (const l of lines) {
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipe}, ${l.itemId}, ${l.quantity}, ${l.unit})`;
  }
}

/** The DEF-618 day: Kitchen holds Cheese 10 and NO Coke; sold Coke 3 and Cheese 2, both direct, both in Kitchen. */
async function def618Day() {
  await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
  const dayId = await makeSalesDay(DAY, sold([
    { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '3' },
    { posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', physicalQty: '2' },
  ]));
  await mapDirect('coke', 'Coke', itemCoke);
  await mapDirect('cheese-direct', 'Cheese Direct', itemCheese);
  const plan = await planOf(dayId);
  const cokeKey = plan.lines.find((l) => l.posItemKey === 'coke')!.key;
  const cheeseKey = plan.lines.find((l) => l.posItemKey === 'cheese-direct')!.key;
  // sanity: the fixture is what the case says it is
  expect(await onHand(itemCoke)).toBe('0.000');
  expect(await onHand(itemCheese)).toBe('10.000');
  expect(plan.lines.find((l) => l.key === cokeKey)?.quantity).toBe('3.000');
  expect(plan.lines.find((l) => l.key === cheeseKey)?.quantity).toBe('2.000');
  return { dayId, plan, cokeKey, cheeseKey, keys: [cokeKey, cheeseKey] };
}

describe('T-388 I1 - DEF-618 itself: one short item never stops another item posting', () => {
  it('Kitchen has Coke 0 and Cheese 10; sold Coke 3, Cheese 2 -> Cheese posts (10 -> 8), Coke is held with its sentence, the section is NOT stamped and the pull stays planned. Mutant: today\'s code (whole room blocked, section stamped) -> red', async () => {
    const d = await def618Day();
    const [s] = await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    expect(s).toMatchObject({ section: 'direct', ok: true, postedLineCount: 1, finalized: false });
    expect(s!.held).toHaveLength(1);
    expect(s!.held[0]).toMatchObject({ key: d.cokeKey, itemId: itemCoke, locationId: kitchen, cause: 'short' });
    expect(s!.heldSentences).toContain(cokeSentence('0'));
    expect(s!.heldSentences).toContain(CLOSING);
    expect(await onHand(itemCheese)).toBe('8.000');
    expect(await onHand(itemCoke)).toBe('0.000');
    const pull = await pullRow(d.plan.pullId);
    expect(pull.direct, 'a section with a held line is not stamped').toBeNull();
    expect(pull.status).toBe('planned');
    expect(await usageCount()).toBe(1);
    expect((await storedLine(d.plan.pullId, d.cheeseKey))?.usage_record_id, 'the posted line is linked').not.toBeNull();
    expect((await storedLine(d.plan.pullId, d.cokeKey))?.usage_record_id, 'the held line is not').toBeNull();
  });
});

describe('T-388 I2 - finalize again after receiving posts the held line exactly once', () => {
  it('receive 5 Coke, finalize again: Coke posts (5 -> 2), Cheese is NOT posted again (still 8, one OUT movement), section stamped. Mutants: posted keys not skipped -> cheese 6; stamp before re-check -> red', async () => {
    const d = await def618Day();
    const [first] = await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    expect(first!.finalized, 'sanity: the first press held Coke and stamped nothing').toBe(false);
    await stockUp(itemCoke, kitchen, '5', '10.0000', '2026-08-02');
    expect(await onHand(itemCoke)).toBe('5.000');

    const [again] = await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    expect(again).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect(await onHand(itemCoke)).toBe('2.000');
    expect(await onHand(itemCheese), 'cheese is not posted a second time').toBe('8.000');
    expect(await outCount(itemCheese)).toBe(1);
    expect(await outCount(itemCoke)).toBe(1);
    expect((await pullRow(d.plan.pullId)).direct).not.toBeNull();
    expect(await usageCount()).toBe(2);
  });
});

describe('T-388 I3 - room-only shortfall (the store holds the item, in another room)', () => {
  it('10 Coke in Stockroom, 0 in Kitchen; sold 3 from Kitchen: the call is ok, Coke is held (0 on hand in Kitchen), the rest posts, and the transaction COMMITS. Mutant: store-wide check instead of room on-hand -> the deferred trigger kills the commit, red', async () => {
    await stockUp(itemCoke, stockroom, '10', '10.0000', '2026-08-01');
    const d = await def618Day();
    expect(await onHand(itemCoke, stockroom)).toBe('10.000');
    const [s] = await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    expect(s).toMatchObject({ ok: true, postedLineCount: 1, finalized: false });
    expect(s!.heldSentences).toContain(cokeSentence('0'));
    expect(await onHand(itemCoke, kitchen)).toBe('0.000');
    expect(await onHand(itemCoke, stockroom)).toBe('10.000');
    expect(await onHand(itemCheese)).toBe('8.000');
  });
});

describe('T-388 I5 - a closed stock month posts nothing', () => {
  async function closeAugust() {
    await sql`update fiscal_periods set status = 'closed' where org_id = ${orgA} and starts_on <= '2026-08-01'`; // earlier months close with it (an open month may not precede a closed one)
  }

  it('I5 closed month, something to post: { ok: false, reason: the closed-month sentence }; no movement, no record, no stamp. Mutant: drop R6 -> today\'s swallow stamps the section, red', async () => {
    const d = await def618Day();
    const before = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements`;
    await closeAugust();
    const r = await finalize(d.plan.pullId, ['direct'], d.keys);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/is closed\. Stock can't be used on/);
    expect(await usageCount()).toBe(0);
    expect((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements`)[0]!.n).toBe(before[0]!.n);
    expect((await pullRow(d.plan.pullId)).direct).toBeNull();
    expect(await onHand(itemCheese)).toBe('10.000');
  });

  it('I5b R6 escape: I1\'s state, then the month closes; finalize again with Coke unticked: ok, nothing posted, section stamped. Mutant: R6 refuses unconditionally -> red', async () => {
    const d = await def618Day();
    const [first] = await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    expect(first!.finalized, 'sanity: Coke was held, nothing stamped').toBe(false);
    expect((await pullRow(d.plan.pullId)).direct).toBeNull();
    await closeAugust();

    const r = await finalize(d.plan.pullId, ['direct'], [d.cheeseKey]); // Coke unticked
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.sections[0]).toMatchObject({ ok: true, postedLineCount: 0, held: [], finalized: true });
    expect((await pullRow(d.plan.pullId)).direct).not.toBeNull();
    expect(await usageCount()).toBe(1);
  });
});

describe('T-388 I5c / I6 - an unexpected failure inside a room post is never swallowed', () => {
  /** A recipe whose only ingredient is a SUPPLY item (inventory account 1320), stocked, so only its posting can fail. */
  async function supplyRecipeDay() {
    const [n] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'NAPKIN','Napkin','supply','pcs',${staffId}) returning id`;
    await stockUp(n!.id, kitchen, '20', '1.0000', '2026-08-01');
    await stockUp(itemCoke, kitchen, '50', '10.0000', '2026-08-01');
    const recipe = await newRecipe('Napkin Pack', itemSauce, [{ itemId: n!.id, quantity: '2', unit: 'pcs' }]);
    const dayId = await makeSalesDay(DAY, sold([
      { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '3' },
      { posItemKey: 'pack', posItemName: 'Napkin Pack', physicalQty: '1' },
    ]));
    await mapDirect('coke', 'Coke', itemCoke);
    await mapRecipe('pack', 'Napkin Pack', recipe);
    const plan = await planOf(dayId);
    return { napkin: n!.id, plan };
  }
  /** Receipts posted to 1310 above (stockUp passes a raw_material kind), so no journal line touches 1320: renaming it makes the supply posting throw and breaks nothing else. */
  const breakSupplyAccount = () => sql`update accounts set code = '1320-gone' where org_id = ${orgA} and code = '1320'`;

  it('I6 one recipe line whose posting throws: the call REJECTS, nothing is stamped, no record, stock unchanged. Mutant: keep the bare catch -> the call returns ok and stamps, red', async () => {
    const { napkin, plan } = await supplyRecipeDay();
    const recipeKeys = plan.lines.filter((l) => l.section === 'recipe').map((l) => l.key);
    expect(recipeKeys, 'sanity: one recipe line').toHaveLength(1);
    await breakSupplyAccount();
    const [acct] = await sql<{ n: string }[]>`select count(*)::text as n from accounts where org_id = ${orgA} and code = '1320'`;
    expect(acct!.n, 'sanity: the 1320 account is gone').toBe('0');

    // sanity: posting the napkin really throws (so the failure below is the fixture's, not a refusal), then rolls back
    await expect(asOrg(orgA, async (tx) => {
      const draft = await saveUsageDraft(tx, managerActor, { orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'usage', usedOn: DAY, lines: [{ itemId: napkin, quantity: '2.000' }] });
      if (!draft.ok) throw new Error(`fixture: ${draft.reason}`);
      return postUsage(tx, managerActor, { recordId: draft.recordId });
    })).rejects.toThrow(/unknown account code/);
    expect(await usageCount(), 'sanity: that probe rolled back').toBe(0);

    await expect(finalize(plan.pullId, ['recipe'], recipeKeys)).rejects.toThrow();
    expect(await usageCount()).toBe(0);
    expect((await pullRow(plan.pullId)).recipe).toBeNull();
    expect(await onHand(napkin)).toBe('20.000');
  });

  it('I5c ["direct","recipe"]: direct posts, then recipe fails -> the call rejects and direct\'s posting is gone too (no movement, no record). Mutant: return { ok: false } / swallow after a write -> direct\'s record survives, red', async () => {
    const { napkin, plan } = await supplyRecipeDay();
    const keys = plan.lines.filter((l) => l.section === 'direct' || l.section === 'recipe').map((l) => l.key);
    expect(keys, 'sanity: a direct line and a recipe line').toHaveLength(2);
    await breakSupplyAccount();

    await expect(finalize(plan.pullId, ['direct', 'recipe'], keys)).rejects.toThrow();
    expect(await usageCount(), 'direct\'s record unwound with the call').toBe(0);
    expect(await onHand(itemCoke), 'direct\'s stock unwound with the call').toBe('50.000');
    expect(await onHand(napkin)).toBe('20.000');
    const pull = await pullRow(plan.pullId);
    expect(pull.direct).toBeNull();
    expect(pull.recipe).toBeNull();
  });
});

describe('T-388 I6b - R4a: a room that cannot take usage is read, not inferred from an error', () => {
  it('a direct map whose room override is a STORAGE room: that line is held with the room sentence, the other lines post, the call is ok. Mutant: no room read -> the operating-room trigger throws and the call fails, red', async () => {
    await stockUp(itemCoke, stockroom, '10', '10.0000', '2026-08-01');
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    const dayId = await makeSalesDay(DAY, sold([
      { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '3' },
      { posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', physicalQty: '2' },
    ]));
    await mapDirect('coke', 'Coke', itemCoke, stockroom); // the item map does not check the room is operating
    await mapDirect('cheese-direct', 'Cheese Direct', itemCheese);
    const plan = await planOf(dayId);
    const cokeKey = plan.lines.find((l) => l.posItemKey === 'coke')!.key;
    expect(plan.lines.find((l) => l.key === cokeKey)?.locationId, 'sanity: Coke resolves to the storage room').toBe(stockroom);

    const [s] = await mustFinalize(plan.pullId, ['direct'], plan.lines.map((l) => l.key));
    expect(s).toMatchObject({ ok: true, postedLineCount: 1, finalized: false });
    expect(s!.held).toHaveLength(1);
    expect(s!.held[0]).toMatchObject({ key: cokeKey, cause: 'room' });
    expect(s!.heldSentences).toContain("Stockroom can't take usage; fix the mapping for Coke, then finalize again.");
    expect(await onHand(itemCheese)).toBe('8.000');
    expect(await onHand(itemCoke, stockroom)).toBe('10.000');
  });
});

describe('T-388 I6c - R3: the room\'s movement rows are locked before the read', () => {
  it('a transfer of Kitchen\'s Coke is open (holds the row lock): finalize BLOCKS until it commits, then holds Coke as short and commits cleanly. Mutant: plain onHand -> finalize reads the old figure and the deferred trigger kills a commit, red', async () => {
    await stockUp(itemCoke, kitchen, '5', '10.0000', '2026-08-01');
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    const dayId = await makeSalesDay(DAY, sold([
      { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '3' },
      { posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', physicalQty: '2' },
    ]));
    await mapDirect('coke', 'Coke', itemCoke);
    await mapDirect('cheese-direct', 'Cheese Direct', itemCheese);
    const plan = await planOf(dayId);
    const keys = plan.lines.map((l) => l.key);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const transfer = asOrg(orgA, async (tx) => {
      const out = await transferNow(tx, { storeId: storeA, fromLocationId: kitchen, toLocationId: display, lines: [{ itemId: itemCoke, quantity: '5' }], actor: managerActor });
      locked();
      await gate; // the transaction (and its row lock) stays open
      return out;
    });
    await lockedP;

    let settled = false;
    const fin = finalize(plan.pullId, ['direct'], keys).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 800));
    const waited = !settled;
    release(); // always let the transfer commit, whatever the assertion below says (an open tx would hang the next truncate)
    await Promise.allSettled([transfer, fin]);
    expect(waited, "finalize must wait for the transfer's row lock").toBe(true);
    const tr = await transfer;
    expect(tr.ok, tr.ok ? '' : tr.reason).toBe(true);
    const r = await fin;
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.sections[0]).toMatchObject({ ok: true, postedLineCount: 1, finalized: false });
    expect(r.sections[0]!.heldSentences).toContain(cokeSentence('0'));
    expect(await onHand(itemCoke, kitchen)).toBe('0.000');
    expect(await onHand(itemCoke, display)).toBe('5.000');
    expect(await onHand(itemCheese)).toBe('8.000');
  });
});

describe('T-388 I6d - the on-hand read is per section, after earlier sections wrote', () => {
  it('one call ["direct","recipe"], Cheese 2 direct + 2 recipe, 3 on hand: direct posts (3 -> 1), recipe\'s Cheese is held. Mutant: on-hand read once for the call -> both post and the commit fails, red', async () => {
    await stockUp(itemCheese, kitchen, '3', '50.0000', '2026-08-01');
    const recipe = await newRecipe('Cheese Box', itemSauce, [{ itemId: itemCheese, quantity: '2', unit: 'kg' }]);
    const dayId = await makeSalesDay(DAY, sold([
      { posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', physicalQty: '2' },
      { posItemKey: 'box', posItemName: 'Cheese Box', physicalQty: '1' },
    ]));
    await mapDirect('cheese-direct', 'Cheese Direct', itemCheese);
    await mapRecipe('box', 'Cheese Box', recipe);
    const plan = await planOf(dayId);
    expect(plan.lines.find((l) => l.section === 'direct')?.quantity).toBe('2.000');
    expect(plan.lines.find((l) => l.section === 'recipe')?.quantity).toBe('2.000');
    const keys = plan.lines.filter((l) => l.section !== 'orphan').map((l) => l.key);

    const secs = await mustFinalize(plan.pullId, ['direct', 'recipe'], keys);
    const direct = secs.find((s) => s.section === 'direct')!;
    const rec = secs.find((s) => s.section === 'recipe')!;
    expect(direct).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect(rec).toMatchObject({ ok: true, postedLineCount: 0, finalized: false });
    expect(rec.held).toHaveLength(1);
    expect(rec.held[0]).toMatchObject({ itemId: itemCheese, locationId: kitchen, cause: 'short' });
    expect(rec.heldSentences).toContain('Cheese: 2 kg needed, 1 on hand in Kitchen. Receive or count it, then finalize again.');
    expect(await onHand(itemCheese)).toBe('1.000');
  });
});

describe('T-388 I7 - R8 / R10: a posted key stays what it posted', () => {
  it('I7a part of a recipe section posted, then ingredient 0 becomes a different item: re-finalize is REFUSED with the R8 sentence and posts nothing. Mutant: no posted-line check -> red', async () => {
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    await stockUp(itemMeat, kitchen, '10', '300.0000', '2026-08-01');
    const recipe = await newRecipe('Box', itemMeat, [
      { itemId: itemCheese, quantity: '1', unit: 'kg' },
      { itemId: itemSauce, quantity: '1', unit: 'pcs' }, // no Sauce on hand: held
    ]);
    const dayId = await makeSalesDay(DAY, sold([{ posItemKey: 'box', posItemName: 'Box', physicalQty: '1' }]));
    await mapRecipe('box', 'Box', recipe);
    const plan = await planOf(dayId);
    const keys = plan.lines.filter((l) => l.section === 'recipe').map((l) => l.key);
    expect(keys, 'sanity: two recipe lines').toHaveLength(2);
    const [first] = await mustFinalize(plan.pullId, ['recipe'], keys);
    expect(first).toMatchObject({ postedLineCount: 1, finalized: false });
    expect(await onHand(itemCheese)).toBe('9.000');

    await setRecipeLines(recipe, [
      { itemId: itemMeat, quantity: '1', unit: 'kg' }, // ingredient 0 is now a different item
      { itemId: itemSauce, quantity: '1', unit: 'pcs' },
    ]);
    const reason = await refusalOf(() => finalize(plan.pullId, ['recipe'], keys));
    expect(reason).toBe('The mapping or recipe for Box changed after part of this section was posted. Void the pull and build the day again.');
    expect(await onHand(itemMeat), 'nothing new posted').toBe('10.000');
    expect(await onHand(itemCheese)).toBe('9.000');
    expect(await usageCount()).toBe(1);
  });

  it('I7b R10: the recipe changes between plan and finalize; the stored posted line names the item that ACTUALLY posted. Mutant: R10 writing only quantity and record id -> the stored line names the plan-time item, red', async () => {
    await stockUp(itemCheese, kitchen, '10', '50.0000', '2026-08-01');
    await stockUp(itemMeat, kitchen, '10', '300.0000', '2026-08-01');
    const recipe = await newRecipe('Box', itemSauce, [{ itemId: itemCheese, quantity: '1', unit: 'kg' }]);
    const dayId = await makeSalesDay(DAY, sold([{ posItemKey: 'box', posItemName: 'Box', physicalQty: '1' }]));
    await mapRecipe('box', 'Box', recipe);
    const plan = await planOf(dayId);
    const key = plan.lines.find((l) => l.section === 'recipe')!.key;
    expect((await storedLine(plan.pullId, key))?.item_id, 'sanity: planned on Cheese').toBe(itemCheese);

    await setRecipeLines(recipe, [{ itemId: itemMeat, quantity: '1', unit: 'kg' }]); // same key, different item
    const [s] = await mustFinalize(plan.pullId, ['recipe'], [key]);
    expect(s).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect(await onHand(itemMeat), 'Meat is what posted').toBe('9.000');
    expect(await onHand(itemCheese)).toBe('10.000');
    const stored = await storedLine(plan.pullId, key);
    expect(stored?.item_id).toBe(itemMeat);
    expect(stored?.location_id).toBe(kitchen);
    expect(stored?.quantity).toBe('1.000');
    expect(stored?.usage_record_id).not.toBeNull();
  });
});

describe('T-388 DEF-622 - recipe ingredient keys follow line id order, not heap order', () => {
  it('lines inserted Cheese then Sauce, then the Cheese row deleted and re-inserted with its own id so it moves to the end of the heap: a plain SELECT returns Sauce first, yet every plan binds :0 to Cheese and :1 to Sauce. Mutant: drop orderBy(productionRecipeLines.id) in the recipe-lines read -> keys swap, red', async () => {
    const recipe = await newRecipe('Box', itemMeat, [
      { itemId: itemCheese, quantity: '1', unit: 'kg' },
      { itemId: itemSauce, quantity: '1', unit: 'pcs' },
    ]);
    // Delete the Cheese row and re-insert it WITH ITS OWN id: the id (uuidv7, so id order = creation order) is kept, but the
    // row now sits after Sauce in the heap and in the recipe_id index. (A plain UPDATE is a HOT update: an index scan still
    // finds the old slot first, so it did not reorder.)
    const [ch] = await sql<{ id: string }[]>`select id from production_recipe_lines where recipe_id = ${recipe} and item_id = ${itemCheese}`;
    await sql`delete from production_recipe_lines where id = ${ch!.id}`;
    await sql`insert into production_recipe_lines (id, recipe_id, item_id, quantity, unit) values (${ch!.id}, ${recipe}, ${itemCheese}, '1', 'kg')`;
    const plain = await sql<{ item_id: string }[]>`select item_id from production_recipe_lines where recipe_id = ${recipe}`;
    const byId = await sql<{ item_id: string }[]>`select item_id from production_recipe_lines where recipe_id = ${recipe} order by id`;
    expect(byId.map((r) => r.item_id), 'sanity: id order is Cheese, Sauce').toEqual([itemCheese, itemSauce]);
    expect(plain.map((r) => r.item_id), 'sanity: heap order differs from id order').toEqual([itemSauce, itemCheese]);

    const dayId = await makeSalesDay(DAY, sold([{ posItemKey: 'box', posItemName: 'Box', physicalQty: '1' }]));
    await mapRecipe('box', 'Box', recipe);
    for (let i = 0; i < 2; i++) {
      const plan = await planOf(dayId); // built twice: the second is a rebuild of the same pull
      const lines = plan.lines.filter((l) => l.section === 'recipe');
      expect(lines.find((l) => l.key === 'recipe:box:0')?.itemId).toBe(itemCheese);
      expect(lines.find((l) => l.key === 'recipe:box:1')?.itemId).toBe(itemSauce);
      expect((await storedLine(plan.pullId, 'recipe:box:0'))?.item_id).toBe(itemCheese);
      expect((await storedLine(plan.pullId, 'recipe:box:1'))?.item_id).toBe(itemSauce);
    }
  });
});

describe('T-388 I8 - R9: a pull with a posted line is "partly finalized" for the pin rule', () => {
  it('I1\'s state (Cheese posted, Coke held, nothing stamped), then a newer sold_items feed with different quantities: buildPlan is refused with the partly-posted sentence. Mutant: pin rule keyed only on stamps -> the rebuild re-pins, red', async () => {
    const d = await def618Day();
    const [first] = await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    expect(first!.finalized, 'sanity: nothing stamped').toBe(false);
    expect((await pullRow(d.plan.pullId)).direct).toBeNull();
    await asOrg(orgA, (tx) => importTestDay(tx, staffActor, { storeId: storeA, businessDate: DAY, soldItems: sold([
      { posItemKey: 'coke', posItemName: 'Coke', physicalQty: '4' },
      { posItemKey: 'cheese-direct', posItemName: 'Cheese Direct', physicalQty: '5' },
    ]) }));

    const rebuilt = await asOrg(orgA, (tx) => buildPlan(tx, staffActor, { orgId: orgA, storeId: storeA, salesDayId: d.dayId, locationId: kitchen }));
    expect(rebuilt.ok).toBe(false);
    if (rebuilt.ok) return;
    expect(rebuilt.reason).toMatch(/changed after part of this pull was posted\. Void the pull and build the day again\./);

    // and finalize says the same (partlyChanged, not changed)
    const r = await finalize(d.plan.pullId, ['direct'], d.keys);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/changed after part of this pull was posted/);
  });
});

describe('T-388 I9 - R10: every posted line is linked, or the call unwinds', () => {
  it('a confirmed key present in the rebuild but deleted from pos_usage_pull_lines: the call rejects (internal fault) and nothing is written. Mutant: best-effort update -> the line posts unlinked, red', async () => {
    const d = await def618Day();
    await sql`delete from pos_usage_pull_lines where pull_id = ${d.plan.pullId} and line_key = ${d.cheeseKey}`;
    await expect(finalize(d.plan.pullId, ['direct'], d.keys)).rejects.toThrow();
    expect(await usageCount()).toBe(0);
    expect(await onHand(itemCheese)).toBe('10.000');
    expect((await pullRow(d.plan.pullId)).direct).toBeNull();
  });

  it('after a normal post the stored line\'s item and room equal what the usage record posted', async () => {
    const d = await def618Day();
    await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    const stored = await storedLine(d.plan.pullId, d.cheeseKey);
    expect(stored?.usage_record_id).not.toBeNull();
    const [posted] = await sql<{ item_id: string; location_id: string; quantity: string }[]>`
      select l.item_id, r.location_id, l.quantity::text as quantity
      from stock_usage_lines l join stock_usage_records r on r.id = l.record_id where r.id = ${stored!.usage_record_id!}`;
    expect(stored?.item_id).toBe(posted!.item_id);
    expect(stored?.location_id).toBe(posted!.location_id);
    expect(stored?.quantity).toBe(posted!.quantity);
    expect(posted!.item_id).toBe(itemCheese);
  });
});

describe('T-388 I10 - pullHolds is live, not the stamp', () => {
  it('returns the I1 sentence for Coke\'s key before receiving and nothing for it after. Mutant: reads the stamp instead of live stock -> red', async () => {
    const d = await def618Day();
    const before = await asOrg(orgA, (tx) => pullHolds(tx, orgA, d.plan.pullId));
    expect(before.get(d.cokeKey)).toBe(cokeSentence('0'));
    expect(before.has(d.cheeseKey), 'cheese is in stock, so no hold').toBe(false);

    await stockUp(itemCoke, kitchen, '5', '10.0000', '2026-08-02');
    const after = await asOrg(orgA, (tx) => pullHolds(tx, orgA, d.plan.pullId));
    expect(after.has(d.cokeKey)).toBe(false);
    expect(after.size).toBe(0);
  });
});

describe('T-388 I11 - unticked lines do not hold a section', () => {
  it('Coke is short but UNTICKED, every ticked line is in stock: the section is stamped. Mutant: count unticked as held -> red', async () => {
    const d = await def618Day();
    const [s] = await mustFinalize(d.plan.pullId, ['direct'], [d.cheeseKey]);
    expect(s).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect((await pullRow(d.plan.pullId)).direct).not.toBeNull();
    expect(await onHand(itemCheese)).toBe('8.000');
    expect(await onHand(itemCoke)).toBe('0.000');
  });
});

describe('T-388 I12 - a void of a partly posted, unstamped pull reverses exactly the posted records', () => {
  it('I1\'s state, then void: the one posted record is reversed (Cheese back to 10), the pull is void. Mutant: void reads only stamped sections -> red', async () => {
    const d = await def618Day();
    const [first] = await mustFinalize(d.plan.pullId, ['direct'], d.keys);
    expect(first!.finalized, 'sanity: unstamped').toBe(false);
    expect(await onHand(itemCheese)).toBe('8.000');

    const out = await asOrg(orgA, (tx) => voidPosUsagePull(tx, managerActor, { pullId: d.plan.pullId, reason: 'test void' }));
    expect(out).toEqual({ ok: true, reversedRecordCount: 1 });
    expect(await onHand(itemCheese)).toBe('10.000');
    expect((await pullRow(d.plan.pullId)).status).toBe('void');
  });
});
