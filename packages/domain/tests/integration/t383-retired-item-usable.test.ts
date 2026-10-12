import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';

/**
 * T-383 S2b - `docs/tasks/383-item-rename.md` Amendment B2.3 / B2.5, domain legs. TESTER file.
 *
 * A RETIRED item (`items.status = 'inactive'`, set by `setItemStatus`, S2a) stays usable for everything that CONSUMES or
 * MOVES stock it already holds (C1-C10) and is refused, in plain words, for everything that ORDERS, RECEIVES, PRICES, MAPS
 * or goes on a NEW RECIPE (X1-X13). L1 is the picker read `itemsRepo.listUsableItems`.
 *
 * Real Postgres, real `authorize()`, as APP_ROLE under an org principal. Every stock-bearing item is given its stock BEFORE
 * it is retired. Every fixture is sanity-asserted (the item really is `inactive`, the stock really is there) so a leg cannot
 * go green or red on a fixture that silently did not build.
 *
 * What the builder must meet (B2.5, verbatim; this file never imports it, it spells it out):
 *   notActiveItemSentence(status, what, where?) -> 'This item is retired, so it cannot be <what>. Use its replacement, or ask a
 *   super-admin to restore it.' / for `merged`: 'This item was merged into another, so it cannot be <what>. Use the item it
 *   was merged into.'; with `where`, 'This item' becomes '<where>: this item'. A throwing path throws a RefusalError whose
 *   `userMessage` is that sentence; an outcome path returns `{ ok: false, reason: <that sentence> }`.
 *
 * Green-on-HEAD legs (C1-C10, X11-X13 and the control legs) are there to FREEZE behaviour: each names the mutant that turns
 * it red ("add an item-status check to <function>").
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, itemsRepo, tradeRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  acceptOrder,
  addBranchOrderLine,
  buildPlan,
  commitCount,
  createCustomer,
  createDeliveryDocument,
  createItem,
  createPriceList,
  createProductionDraft,
  createRecipe,
  createTradeOrder,
  declareSupplierItem,
  dispatchBranchOrder,
  dispatchTradeOrder,
  finalizeSections,
  fulfilLine,
  markReady,
  openCountSession,
  postProduction,
  postUsage,
  proposeLine,
  quantity,
  receiveDelivery,
  receiveDeliveryDocument,
  receiveTradeOrder,
  recordCount,
  recordCustomerReturn,
  recordReturn,
  saveBranchOrderDraft,
  saveUsageDraft,
  setItemPricing,
  setItemStatus,
  setPrice,
  submitOrder,
  transferNow,
  upsertMap,
  upsertOffering,
  upsertPosItemMap,
  validateInvoiceLines,
} from '@shareat/domain';
import type { LocationLike } from '../../src/stock-locations/rules';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import { testItemCode } from './_fixtures/item-code';
import type { PosV1SoldItemInput } from '../../../db/src/pos-v1/fixtures';

// `listUsableItems` does not exist at HEAD (T-383 S2b). Read off the namespace so L1 fails on its BEHAVIOUR (TypeError at call
// time), not the whole file at import.
type UsableRow = { id: string; name: string; status: string };
const listUsableItems = (tx: Tx, orgId: string, storeId: string): Promise<UsableRow[]> =>
  (itemsRepo as unknown as { listUsableItems: (tx: Tx, orgId: string, storeId: string) => Promise<UsableRow[]> }).listUsableItems(
    tx,
    orgId,
    storeId,
  );

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

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =================================================================================================================
// The sentence (B2.5), spelled out here so a builder cannot bend it to fit its own helper.
// =================================================================================================================
function notActive(status: 'inactive' | 'merged', what: string, where?: string): string {
  const lead = where ? `${where}: this item` : 'This item';
  return status === 'merged'
    ? `${lead} was merged into another, so it cannot be ${what}. Use the item it was merged into.`
    : `${lead} is retired, so it cannot be ${what}. Use its replacement, or ask a super-admin to restore it.`;
}

/** The sentence a person would read: a RefusalError's userMessage, or an outcome's `reason`; null when the call succeeded. */
async function sentenceOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    const r = await fn();
    const o = r as { ok?: unknown; reason?: unknown } | null;
    if (o && typeof o === 'object' && o.ok === false && typeof o.reason === 'string') return o.reason;
    return null;
  } catch (e) {
    const um = (e as { userMessage?: unknown }).userMessage;
    return typeof um === 'string' ? um : `RAW ENGINEER TEXT (no plain-words sentence): ${(e as Error).message}`;
  }
}

// =================================================================================================================
// The world: one org, four stores (A, B, COM, BR), four people, rooms, a chart, open periods for 2020-2035.
// =================================================================================================================
async function world(hint: string) {
  const code = uid(`t383s2b-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series('2020-01-01'::date, '2035-12-01'::date, interval '1 month') m`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(label)}, ${`Store ${label}`}, 'multi_room') returning id`;
    return s!.id;
  };
  const A = await mkStore('a');
  const B = await mkStore('b');
  const COM = await mkStore('com');
  const BR = await mkStore('br');
  const stores = [A, B, COM, BR];

  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return actor(orgId, p!.id);
  };
  const su = await mkPerson('Super', 'super_admin');
  const adm = await mkPerson('Admin', 'admin');
  const mgr = await mkPerson('Manager', 'manager');

  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, roomCode: string, isDefault: boolean) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${storeId}, ${roomCode}, ${roomCode}, ${lt!.id}, 'operating', ${isDefault}, ${su.personId}) returning id`;
    return r!.id;
  };
  const kitchenA = await mkRoom(A, 'KIT', true);
  const displayA = await mkRoom(A, 'DISP', false);
  const kitchenB = await mkRoom(B, 'KIT', true);
  const kitchenCom = await mkRoom(COM, 'KIT', true);
  const kitchenBr = await mkRoom(BR, 'KIT', true);
  const room = (id: string, isDefault: boolean): LocationLike => ({ id, role: 'operating', purpose: 'normal', isDefault, status: 'active' });
  const rooms: Record<string, LocationLike[]> = {
    [A]: [room(kitchenA, true), room(displayA, false)],
    [B]: [room(kitchenB, true)],
    [COM]: [room(kitchenCom, true)],
    [BR]: [room(kitchenBr, true)],
  };

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${A}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${su.personId})
    returning id`;
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by, credit_terms_days) values (${orgId}, ${`Supplier ${code}`}, ${su.personId}, 30) returning id`;

  return {
    orgId, A, B, COM, BR, su, adm, mgr, kitchenA, displayA, kitchenB, kitchenCom, kitchenBr, rooms,
    fileId: file!.id, supplierId: supplier!.id,
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function mkItem(
  w: World,
  name: string,
  o: { kind?: string; unit?: string; parentSlab?: string } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
    values (${w.orgId}, ${testItemCode()}, ${`${name} ${uid('n')}`}, ${o.kind ?? 'raw_material'}, ${o.unit ?? 'kg'}, ${o.parentSlab ?? null}, ${w.su.personId})
    returning id`;
  return row!.id;
}
const wholesaleItem = async (w: World, name: string): Promise<string> =>
  (await asOrg(w.orgId, (tx) =>
    createItem(tx, w.su, { code: testItemCode(), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  )).id;
const nameOf = async (id: string): Promise<string> => (await sql<{ name: string }[]>`select name from items where id = ${id}`)[0]!.name;
const statusOf = async (id: string): Promise<string> => (await sql<{ status: string }[]>`select status from items where id = ${id}`)[0]!.status;

/** Retire through the real S2a verb, then prove the fixture: the row really is `inactive`. */
async function retire(w: World, itemId: string): Promise<void> {
  await asOrg(w.orgId, (tx) => setItemStatus(tx, w.su, { itemId, status: 'inactive' }));
  expect(await statusOf(itemId), 'fixture: the item must be retired before the leg under test').toBe('inactive');
}

/** Real stock through a real receipt (layers + journal), the same path a delivery takes. */
async function stockIn(w: World, storeId: string, locationId: string, itemId: string, qty: string, cost = '100.0000', kind = 'raw_material'): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${w.orgId}, ${storeId}, 'purchase', '2026-08-01', ${w.fileId}, ${w.su.personId}) returning id`;
  const res = await asOrg(w.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: w.orgId, storeId, deliveryId: d!.id, deliveredOn: '2026-08-01', locations: w.rooms[storeId]!, receivedBy: w.su.personId,
      lines: [{ lineId: '1', itemId, itemKind: kind, receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId }],
    }),
  );
  if (!res.ok) throw new Error(`stockIn fixture failed: ${res.reason}`);
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}
async function onHandAtStore(itemId: string, storeId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and store_id = ${storeId}`;
  return r!.t;
}
/** Movements of `itemId` whose sign is `negative`. A consumption must land on the RETIRED item's own ledger. */
async function movementCount(itemId: string, sign: 'in' | 'out'): Promise<number> {
  const rows =
    sign === 'out'
      ? await sql<{ n: number }[]>`select count(*)::int as n from stock_movements where item_id = ${itemId} and quantity < 0`
      : await sql<{ n: number }[]>`select count(*)::int as n from stock_movements where item_id = ${itemId} and quantity > 0`;
  return rows[0]?.n ?? 0;
}
const count = async (table: string, orgId: string): Promise<number> =>
  (await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where org_id = '${orgId}'`))[0]!.n;

// =================================================================================================================
// C1-C4: usage, wastage, transfer, count.
// =================================================================================================================
describe('C1-C4 - a retired item with stock can still be used, wasted, moved and counted', () => {
  it('C1 usage: 2 of 5 -> on-hand 3, the movement is on the retired item. GREEN on HEAD. Mutant: saveUsageDraft/postUsage refuse an item whose status is not active -> red', async () => {
    const w = await world('c1');
    const item = await mkItem(w, 'C1 Pork');
    await stockIn(w, w.A, w.kitchenA, item, '5');
    await retire(w, item);
    expect(await onHand(item, w.kitchenA), 'fixture: stock before the leg').toBe('5.000');

    const draft = await asOrg(w.orgId, (tx) =>
      saveUsageDraft(tx, w.mgr, { orgId: w.orgId, storeId: w.A, locationId: w.kitchenA, kind: 'usage', usedOn: '2026-08-20', lines: [{ itemId: item, quantity: '2' }] }),
    );
    expect(draft.ok, draft.ok ? '' : draft.reason).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(w.orgId, (tx) => postUsage(tx, w.mgr, { recordId: draft.recordId }));
    expect(posted.ok, posted.ok ? '' : posted.reason).toBe(true);
    expect(await onHand(item, w.kitchenA)).toBe('3.000');
    expect(await movementCount(item, 'out')).toBe(1);
  });

  it('C2 wastage (a usage record with a wastage reasonCode): same screen, same result. GREEN on HEAD. Mutant: a status check on the wastage path -> red', async () => {
    const w = await world('c2');
    const item = await mkItem(w, 'C2 Chicken');
    await stockIn(w, w.A, w.kitchenA, item, '5');
    await retire(w, item);

    const draft = await asOrg(w.orgId, (tx) =>
      saveUsageDraft(tx, w.mgr, {
        orgId: w.orgId, storeId: w.A, locationId: w.kitchenA, kind: 'wastage', reasonCode: 'spoilage', usedOn: '2026-08-20',
        lines: [{ itemId: item, quantity: '2' }],
      }),
    );
    expect(draft.ok, draft.ok ? '' : draft.reason).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(w.orgId, (tx) => postUsage(tx, w.mgr, { recordId: draft.recordId }));
    expect(posted.ok, posted.ok ? '' : posted.reason).toBe(true);
    expect(await onHand(item, w.kitchenA)).toBe('3.000');
    expect(await movementCount(item, 'out')).toBe(1);
  });

  it('C3 transfer: transferNow of 1 between two rooms of A. GREEN on HEAD. Mutant: a status check in transferNow (or dispatch/receiveTransfer) -> red', async () => {
    const w = await world('c3');
    const item = await mkItem(w, 'C3 Beef');
    await stockIn(w, w.A, w.kitchenA, item, '5');
    await retire(w, item);

    const res = await asOrg(w.orgId, (tx) =>
      transferNow(tx, { storeId: w.A, fromLocationId: w.kitchenA, toLocationId: w.displayA, lines: [{ itemId: item, quantity: '1' }], actor: w.mgr }),
    );
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    expect(await onHand(item, w.kitchenA)).toBe('4.000');
    expect(await onHand(item, w.displayA)).toBe('1.000');
  });

  it('C4 count: recorded down to 0 and committed -> on-hand 0 (and the count line is for the retired item). GREEN on HEAD. Mutant: a status check in recordCount/commitCount -> red', async () => {
    const w = await world('c4');
    const item = await mkItem(w, 'C4 Rice');
    await stockIn(w, w.A, w.kitchenA, item, '5');
    await retire(w, item);

    const opened = await asOrg(w.orgId, (tx) => openCountSession(tx, w.mgr, { storeId: w.A, locationIds: [w.kitchenA], countedOn: '2026-08-20' }));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const rec = await asOrg(w.orgId, (tx) =>
      recordCount(tx, w.mgr, { sessionId: opened.sessionId, itemId: item, locationId: w.kitchenA, countedQuantity: quantity('0') }),
    );
    expect(rec.ok, rec.ok ? '' : rec.reason).toBe(true);
    const committed = await asOrg(w.orgId, (tx) => commitCount(tx, w.mgr, { sessionId: opened.sessionId }));
    expect(committed.ok, committed.ok ? '' : committed.reason).toBe(true);
    expect(await onHand(item, w.kitchenA)).toBe('0.000');
    expect(await movementCount(item, 'out')).toBe(1);
  });
});

// =================================================================================================================
// C5-C6: the POS usage pull against a retired item (direct map and recipe map).
// =================================================================================================================
const ZERO_FIGURES = { paidTotal: 0, receiptCount: 0, packageOnly: 0, discounts: 0, charges: 0, methods: {} };
const sold = (key: string, qty: number): PosV1SoldItemInput[] => [{ key, name: key, physicalQty: qty }];

/** Store A linked to POS, with the tenders D1's methods resolve to (the pos-usage-pull.test.ts fixture, S5-lite). */
async function linkPos(w: World): Promise<void> {
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${w.orgId}, ${w.A}, 'Walk-in', true) returning id`;
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${w.orgId}, ${w.A}, 'GCash - A', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId: w.orgId, storeId: w.A, channelId: ch!.id, createdBy: w.mgr.personId });
  await seedTestTenders(sql, { orgId: w.orgId, storeId: w.A, walletAccountId: gcash!.id });
}
async function salesDay(w: World, businessDate: string, soldItems: PosV1SoldItemInput[]): Promise<string> {
  const { id } = await asOrg(w.orgId, (tx) =>
    importTestDay(tx, w.mgr, { storeId: w.A, businessDate, soldItems, ...(soldItems.length === 0 ? { figures: ZERO_FIGURES } : {}) }),
  );
  return id;
}
/** Plan a day and finalise the given section; returns the finalise outcome's first section. */
async function pull(w: World, dayId: string, section: 'direct' | 'recipe') {
  const plan = await asOrg(w.orgId, (tx) => buildPlan(tx, w.mgr, { orgId: w.orgId, storeId: w.A, salesDayId: dayId, locationId: w.kitchenA }));
  expect(plan.ok, plan.ok ? '' : plan.reason).toBe(true);
  if (!plan.ok) throw new Error('plan failed');
  const result = await asOrg(w.orgId, (tx) =>
    finalizeSections(tx, w.mgr, { pullId: plan.pullId, sections: [section], confirmedKeys: plan.lines.map((l) => l.key) }),
  );
  expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  if (!result.ok) throw new Error('finalize failed');
  return { plan, outcome: result.sections[0]! };
}

describe('C5-C6 - POS usage pull still depletes a retired item (direct map, recipe map)', () => {
  it('C5 direct map: 11 sold -> the retired item is depleted (50 -> 39), nothing blocked. GREEN on HEAD. Mutant: buildPlan/finalizeSections skip or block a line whose item is not active -> red', async () => {
    const w = await world('c5');
    await linkPos(w);
    const item = await mkItem(w, 'C5 Coke');
    await stockIn(w, w.A, w.kitchenA, item, '50', '10.0000');
    const mapped = await asOrg(w.orgId, (tx) =>
      upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '1' }),
    );
    expect(mapped.ok, mapped.ok ? '' : mapped.reason).toBe(true); // made while ACTIVE: X9 would refuse it once retired
    await retire(w, item);
    const day = await salesDay(w, '2026-08-20', sold('coke', 11));

    const { plan, outcome } = await pull(w, day, 'direct');
    expect(plan.lines.find((l) => l.posItemKey === 'coke')?.itemId).toBe(item);
    expect(outcome).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect(await onHand(item, w.kitchenA)).toBe('39.000');
    expect(await movementCount(item, 'out')).toBe(1);
  });

  it('C6 recipe map: a recipe whose ingredient is retired still depletes it (4 sold x 0.5 -> 10 down to 8). GREEN on HEAD. Mutant: recipe explosion drops a retired ingredient -> red', async () => {
    const w = await world('c6');
    await linkPos(w);
    const ingredient = await mkItem(w, 'C6 Cheese');
    const output = await mkItem(w, 'C6 Box');
    await stockIn(w, w.A, w.kitchenA, ingredient, '10', '50.0000');
    const [recipe] = await sql<{ id: string }[]>`
      insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
      values (${w.orgId}, ${uid('Box')}, ${output}, 1, ${w.su.personId}) returning id`;
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipe!.id}, ${ingredient}, 0.5, 'kg')`;
    const mapped = await asOrg(w.orgId, (tx) =>
      upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'box', posItemName: 'Box', mode: 'recipe', recipeId: recipe!.id }),
    );
    expect(mapped.ok, mapped.ok ? '' : mapped.reason).toBe(true);
    await retire(w, ingredient);
    const day = await salesDay(w, '2026-08-20', sold('box', 4));

    const { plan, outcome } = await pull(w, day, 'recipe');
    expect(plan.lines.find((l) => l.itemId === ingredient), 'the retired ingredient must be in the plan').toBeDefined();
    expect(outcome).toMatchObject({ ok: true, postedLineCount: 1, held: [], finalized: true });
    expect(await onHand(ingredient, w.kitchenA)).toBe('8.000');
  });
});

// =================================================================================================================
// C7-C10: production input, supplier return, branch order filled after the retire, customer return.
// =================================================================================================================
describe('C7-C10 - production input, supplier return, branch order, customer return', () => {
  it('C7 production input: a retired slab goes in, slices come out (posted). GREEN on HEAD. Mutant: createProductionDraft/postProduction refuse a non-active input -> red', async () => {
    const w = await world('c7');
    const slab = await mkItem(w, 'C7 Slab', { kind: 'meat_slab' });
    const sliceA = await mkItem(w, 'C7 Slice A', { kind: 'meat_sliced', parentSlab: slab });
    const sliceB = await mkItem(w, 'C7 Slice B', { kind: 'meat_sliced', parentSlab: slab });
    const sliceC = await mkItem(w, 'C7 Slice C', { kind: 'meat_sliced', parentSlab: slab });
    await stockIn(w, w.A, w.kitchenA, slab, '100', '300.0000', 'meat_slab');
    await retire(w, slab);

    const draft = await asOrg(w.orgId, (tx) =>
      createProductionDraft(tx, w.mgr, {
        orgId: w.orgId, storeId: w.A, locationId: w.kitchenA, kind: 'slice', producedOn: '2026-08-10', labourCost: '1000.00',
        inputs: [{ itemId: slab, quantity: '100', unit: 'kg' }],
        outputs: [
          { itemId: sliceA, quantity: '40', unit: 'kg' },
          { itemId: sliceB, quantity: '35', unit: 'kg' },
          { itemId: sliceC, quantity: '22', unit: 'kg' },
        ],
      }),
    );
    expect(draft.ok, draft.ok ? '' : draft.reason).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(w.orgId, (tx) => postProduction(tx, w.mgr, { recordId: draft.recordId }));
    expect(posted.ok, posted.ok ? '' : (posted as { reason: string }).reason).toBe(true); // a WARNING is allowed (B2.2), a refusal is not
    expect(await onHand(slab, w.kitchenA)).toBe('0.000');
    expect(await onHand(sliceA, w.kitchenA)).toBe('40.000');
  });

  it('C8 supplier return of an earlier delivery line: 10 of 30 go back. GREEN on HEAD. Mutant: recordReturn refuses a non-active item -> red', async () => {
    const w = await world('c8');
    const item = await mkItem(w, 'C8 Pork');
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
      values (${w.orgId}, ${w.A}, 'supplier', ${w.supplierId}, '2026-01-05', ${w.fileId}, ${w.su.personId}) returning id`;
    const [dl] = await sql<{ id: string }[]>`
      insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
      values (${d!.id}, '1', ${item}, 30, 30, 'kg', '1', '100.0000', ${w.kitchenA}) returning id`;
    const received = await asOrg(w.orgId, (tx) =>
      receiveDelivery(tx, {
        orgId: w.orgId, storeId: w.A, deliveryId: d!.id, deliveredOn: '2026-01-05', locations: w.rooms[w.A]!, receivedBy: w.su.personId,
        lines: [{ lineId: '1', itemId: item, itemKind: 'raw_material', receivedQuantity: quantity('30.000'), conversionFactor: '1', unitCost: '100.0000', locationId: w.kitchenA }],
      }),
    );
    expect(received.ok).toBe(true);
    await retire(w, item);
    expect(await onHand(item, w.kitchenA), 'fixture: stock before the leg').toBe('30.000');

    const res = await asOrg(w.orgId, (tx) =>
      recordReturn(tx, {
        storeId: w.A, supplierId: w.supplierId, deliveryId: d!.id, returnedOn: '2026-01-06', reason: 'damaged',
        lines: [{ itemId: item, itemKind: 'raw_material', locationId: w.kitchenA, quantity: quantity('10.000'), deliveryLineId: dl!.id }],
        actor: w.mgr,
      }),
    );
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    expect(await onHand(item, w.kitchenA)).toBe('20.000');
    expect(await movementCount(item, 'out')).toBe(1);
  });

  it('C9 branch order accepted while active, items retired, then fulfil + dispatch + receive all succeed and move stock on the retired items. GREEN on HEAD. Mutant: a status check in fulfilLine, markReady, dispatchBranchOrder or receiveTradeOrder -> red', async () => {
    const w = await world('c9');
    const c = await commissary(w);
    await stockIn(w, w.COM, w.kitchenCom, c.pork, '100', '300.0000');
    const draft = await asOrg(w.orgId, (tx) =>
      saveBranchOrderDraft(tx, w.mgr, { branchStoreId: w.BR, commissaryStoreId: w.COM, orderDate: '2026-08-20', lines: [{ itemId: c.pork, quantity: '20' }] }),
    );
    await asOrg(w.orgId, (tx) => submitOrder(tx, w.mgr, { orderId: draft.orderId }));
    await asOrg(w.orgId, (tx) => acceptOrder(tx, w.mgr, { orderId: draft.orderId }));
    await retire(w, c.pork); // the commissary's item AND the branch's item are both retired before the goods move
    await retire(w, c.porkBr);

    const [line] = await asOrg(w.orgId, (tx) => tradeRepo.linesFor(tx, w.orgId, draft.orderId));
    await asOrg(w.orgId, (tx) => fulfilLine(tx, w.mgr, { orderId: draft.orderId, lineId: line!.id, quantity: '18' }));
    await asOrg(w.orgId, (tx) => markReady(tx, w.mgr, { orderId: draft.orderId }));
    await asOrg(w.orgId, (tx) => dispatchBranchOrder(tx, w.mgr, { orderId: draft.orderId }));
    expect(await onHandAtStore(c.pork, w.COM), 'dispatch relieves the retired commissary item').toBe('82.000');
    await asOrg(w.orgId, (tx) => receiveTradeOrder(tx, w.mgr, { orderId: draft.orderId, receivedOn: '2026-08-21' }));
    expect(await onHandAtStore(c.porkBr, w.BR), 'receipt lands on the retired branch item').toBe('18.000');
  });

  it('C10 customer return of a sale made while active: 10 back into stock. GREEN on HEAD. Mutant: recordCustomerReturn refuses a non-active item -> red', async () => {
    const w = await world('c10');
    const item = await wholesaleItem(w, 'C10 Beef');
    await stockIn(w, w.A, w.kitchenA, item, '50', '90.0000');
    const customer = await asOrg(w.orgId, (tx) => createCustomer(tx, w.adm, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
    const order = await asOrg(w.orgId, (tx) =>
      createTradeOrder(tx, w.mgr, { storeId: w.A, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId: item, quantity: '10', rate: '500' }] }),
    );
    await asOrg(w.orgId, (tx) => dispatchTradeOrder(tx, w.mgr, { orderId: order.orderId }));
    const [line] = await asOrg(w.orgId, (tx) => tradeRepo.linesFor(tx, w.orgId, order.orderId));
    await retire(w, item);
    expect(await onHand(item, w.kitchenA), 'fixture: 50 stocked - 10 sold').toBe('40.000');

    const res = await asOrg(w.orgId, (tx) =>
      recordCustomerReturn(tx, { tradeOrderId: order.orderId, returnedOn: '2026-01-15', reason: 'Wrong item shipped.', lines: [{ tradeOrderLineId: line!.id, quantity: '10' }], actor: w.mgr }),
    );
    expect(res.ok, res.ok ? '' : (res as { reason: string }).reason).toBe(true);
    expect(await onHand(item, w.kitchenA)).toBe('50.000');
  });
});

// =================================================================================================================
// The commissary world (links, offerings, maps) used by C9, X3, X4, X12, X13.
// =================================================================================================================
async function commissary(w: World) {
  const pork = await mkItem(w, 'Pork belly');
  const porkBr = await mkItem(w, 'Pork belly branch');
  const sauce = await mkItem(w, 'Bulgogi sauce');
  const sauceBr = await mkItem(w, 'Bulgogi sauce branch');
  const tofu = await mkItem(w, 'Tofu');
  const tofuBr = await mkItem(w, 'Tofu branch');
  await sql`insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by) values (${w.orgId}, ${w.COM}, ${w.BR}, ${w.su.personId})`;
  for (const [item, cost] of [[pork, '310.0000'], [sauce, '95.0000'], [tofu, '40.0000']] as const) {
    await sql`insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by) values (${w.orgId}, ${w.COM}, ${item}, ${cost}, ${w.su.personId})`;
  }
  await sql`insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
    values (${w.orgId}, ${`Store br (internal) ${uid('c')}`}, 'internal', ${w.BR}, ${w.su.personId})`;
  const [cogs] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${w.orgId} and "group" = 'COGS' order by category limit 1`;
  for (const [from, to] of [[pork, porkBr], [sauce, sauceBr], [tofu, tofuBr]] as const) {
    await sql`insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, is_ledger_only, expense_category_id, created_by)
      values (${w.orgId}, ${w.COM}, ${w.BR}, ${from}, ${to}, false, ${cogs!.id}, ${w.su.personId})`;
  }
  return { pork, porkBr, sauce, sauceBr, tofu, tofuBr };
}

/** A branch order with a SAUCE line, accepted, so a second item can be proposed or added to it. */
async function acceptedOrderWithSauce(w: World, sauce: string): Promise<string> {
  const { orderId } = await asOrg(w.orgId, (tx) =>
    saveBranchOrderDraft(tx, w.mgr, { branchStoreId: w.BR, commissaryStoreId: w.COM, orderDate: '2026-08-20', lines: [{ itemId: sauce, quantity: '4' }] }),
  );
  await asOrg(w.orgId, (tx) => submitOrder(tx, w.mgr, { orderId }));
  await asOrg(w.orgId, (tx) => acceptOrder(tx, w.mgr, { orderId }));
  return orderId;
}
const orderLineCount = async (orderId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from trade_order_lines where order_id = ${orderId}`)[0]!.n;

// =================================================================================================================
// X1-X13: the refuse half.
// =================================================================================================================
const RED_ACCEPTS = 'It ACCEPTED a retired item; B2.3 says it must refuse in words.';
const RED_RAW = 'It refuses, but with raw engineer text; B2.3 says a plain-words sentence.';

describe('X1-X13 - ORDER / RECEIVE / PRICE / MAP / NEW RECIPE refuse a retired item, in words, writing nothing', () => {
  it('X1 supplier invoice line: the exact sentence (retired) and the merged sentence. RED on HEAD (raw Error with the item name). Mutants: drop the check -> red; `=== inactive` instead of `!== active` -> the merged leg red', async () => {
    const w = await world('x1');
    const item = await mkItem(w, 'X1 Pork');
    const mergedAway = await mkItem(w, 'X1 Old Duplicate');
    const winner = await mkItem(w, 'X1 Winner');
    await sql`update items set status = 'merged', merged_into_id = ${winner} where id = ${mergedAway}`;
    expect(await statusOf(mergedAway), 'fixture').toBe('merged');
    await retire(w, item);
    const lineFor = (itemId: string) => ({ itemId, quantity: '1', purchaseUnit: 'kg' as const, conversionFactor: '1', unitPrice: '100', lineTotal: '100.00' });
    const run = (itemId: string) => sentenceOf(() => asOrg(w.orgId, (tx) => validateInvoiceLines(tx, w.orgId, [lineFor(itemId)], '100.00', w.A)));

    expect(await run(item), RED_RAW).toBe(notActive('inactive', 'bought or received', 'Line 1'));
    expect(await run(mergedAway), RED_RAW).toBe(notActive('merged', 'bought or received', 'Line 1'));
    const active = await mkItem(w, 'X1 Active');
    expect(await run(active), 'control: an active item passes').toBeNull();
  });

  it('X2 declare a supplier for an item: the sentence, nothing written. RED on HEAD (raw Error). Mutant: drop the check -> red', async () => {
    const w = await world('x2');
    const item = await mkItem(w, 'X2 Pork');
    await retire(w, item);
    const before = await count('supplier_items', w.orgId);
    const s = await sentenceOf(() => asOrg(w.orgId, (tx) => declareSupplierItem(tx, w.adm, { supplierId: w.supplierId, itemId: item })));
    expect(s, RED_RAW).toBe(notActive('inactive', 'bought from a supplier'));
    expect(await count('supplier_items', w.orgId)).toBe(before);
    const active = await mkItem(w, 'X2 Active');
    expect(await sentenceOf(() => asOrg(w.orgId, (tx) => declareSupplierItem(tx, w.adm, { supplierId: w.supplierId, itemId: active }))), 'control').toBeNull();
  });

  it('X3 branch order line (addBranchOrderLine -> buildBranchLine): the sentence, no line added. RED on HEAD (raw Error). Mutant: drop the check -> red; control leg (an active offered item) stays green', async () => {
    const w = await world('x3');
    const c = await commissary(w);
    const { orderId } = await asOrg(w.orgId, (tx) =>
      saveBranchOrderDraft(tx, w.mgr, { branchStoreId: w.BR, commissaryStoreId: w.COM, orderDate: '2026-08-20', lines: [{ itemId: c.sauce, quantity: '4' }] }),
    );
    await retire(w, c.pork);
    const before = await orderLineCount(orderId);
    const s = await sentenceOf(() => asOrg(w.orgId, (tx) => addBranchOrderLine(tx, w.mgr, { orderId, itemId: c.pork, quantity: '2' })));
    expect(s, RED_RAW).toBe(notActive('inactive', 'ordered'));
    expect(await orderLineCount(orderId)).toBe(before);
    expect(await sentenceOf(() => asOrg(w.orgId, (tx) => addBranchOrderLine(tx, w.mgr, { orderId, itemId: c.tofu, quantity: '2' }))), 'control: an active offered item').toBeNull();
    expect(await orderLineCount(orderId)).toBe(before + 1);
  });

  it('X4 commissary proposes a line: the sentence, no line added. RED on HEAD (raw Error). Mutant: drop the check -> red', async () => {
    const w = await world('x4');
    const c = await commissary(w);
    const orderId = await acceptedOrderWithSauce(w, c.sauce);
    await retire(w, c.pork);
    const before = await orderLineCount(orderId);
    const s = await sentenceOf(() => asOrg(w.orgId, (tx) => proposeLine(tx, w.mgr, { orderId, itemId: c.pork, quantity: '2' })));
    expect(s, RED_RAW).toBe(notActive('inactive', 'added to an order'));
    expect(await orderLineCount(orderId)).toBe(before);
    expect(await sentenceOf(() => asOrg(w.orgId, (tx) => proposeLine(tx, w.mgr, { orderId, itemId: c.tofu, quantity: '2' }))), 'control: an active item').toBeNull();
  });

  it('X5 trade order line: the sentence naming the line, no order written. RED on HEAD (raw Error). Mutant: drop the check -> red', async () => {
    const w = await world('x5');
    const item = await wholesaleItem(w, 'X5 Beef');
    const customer = await asOrg(w.orgId, (tx) => createCustomer(tx, w.adm, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));
    await retire(w, item);
    const before = await count('trade_orders', w.orgId);
    const s = await sentenceOf(() =>
      asOrg(w.orgId, (tx) => createTradeOrder(tx, w.mgr, { storeId: w.A, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId: item, quantity: '1', rate: '500' }] })),
    );
    expect(s, RED_RAW).toBe(notActive('inactive', 'ordered', 'Line 1'));
    expect(await count('trade_orders', w.orgId)).toBe(before);
    const active = await wholesaleItem(w, 'X5 Active');
    expect(
      await sentenceOf(() => asOrg(w.orgId, (tx) => createTradeOrder(tx, w.mgr, { storeId: w.A, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId: active, quantity: '1', rate: '500' }] }))),
      'control',
    ).toBeNull();
  });

  it('X6 supplier delivery drafted: refused, no delivery written. RED on HEAD (it admits it). Mutant: drop the new check -> red', async () => {
    const w = await world('x6');
    const item = await mkItem(w, 'X6 Pork');
    await retire(w, item);
    const draftOf = (itemId: string) => ({
      storeId: w.A, kind: 'purchase' as const, supplierId: null, referenceNo: null, deliveredOn: '2026-09-01', proofFileId: w.fileId,
      lines: [{ itemId, orderedQuantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitCost: '300.0000', locationId: w.kitchenA }],
    });
    const before = await count('deliveries', w.orgId);
    const s = await sentenceOf(() => asOrg(w.orgId, (tx) => createDeliveryDocument(tx, w.mgr, draftOf(item))));
    expect(s, RED_ACCEPTS).toBe(notActive('inactive', 'received', 'Line 1'));
    expect(await count('deliveries', w.orgId)).toBe(before);
    const active = await mkItem(w, 'X6 Active');
    expect(await sentenceOf(() => asOrg(w.orgId, (tx) => createDeliveryDocument(tx, w.mgr, draftOf(active)))), 'control').toBeNull();
  });

  it('X7 supplier delivery received after the retire: refused, nothing written (still draft, no movement). RED on HEAD. Control: a COMMISSARY delivery of a retired item still receives (green on HEAD). Mutants: drop the check -> red; drop the commissary exception -> the control red', async () => {
    const w = await world('x7');
    const item = await mkItem(w, 'X7 Pork');
    const created = await asOrg(w.orgId, (tx) =>
      createDeliveryDocument(tx, w.mgr, {
        storeId: w.A, kind: 'purchase', supplierId: null, referenceNo: null, deliveredOn: '2026-09-01', proofFileId: w.fileId,
        lines: [{ itemId: item, orderedQuantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitCost: '300.0000', locationId: w.kitchenA }],
      }),
    );
    const [dl] = await sql<{ id: string }[]>`select id from delivery_lines where delivery_id = ${created.deliveryId}`;
    await retire(w, item);
    const s = await sentenceOf(() =>
      asOrg(w.orgId, (tx) => receiveDeliveryDocument(tx, w.mgr, { deliveryId: created.deliveryId, lines: [{ lineId: dl!.id, receivedQuantity: '10' }] })),
    );
    expect(s, RED_ACCEPTS).toBe(notActive('inactive', 'received', 'Line 1'));
    expect((await sql<{ status: string }[]>`select status from deliveries where id = ${created.deliveryId}`)[0]!.status).toBe('draft');
    expect(await movementCount(item, 'in'), 'nothing written before the refusal').toBe(0);

    // Control: a commissary delivery is a MOVE of goods another store already dispatched, so it is not refused.
    const moved = await mkItem(w, 'X7 Moved');
    const [cd] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, created_by) values (${w.orgId}, ${w.A}, 'commissary', '2026-09-01', ${w.su.personId}) returning id`;
    const [cl] = await sql<{ id: string }[]>`
      insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
      values (${cd!.id}, '1', ${moved}, 10, 'kg', '1', '300.0000', ${w.kitchenA}) returning id`;
    await retire(w, moved);
    const ok = await asOrg(w.orgId, (tx) => receiveDeliveryDocument(tx, w.mgr, { deliveryId: cd!.id, lines: [{ lineId: cl!.id, receivedQuantity: '10' }] }));
    expect(ok.ok, ok.ok ? '' : (ok as unknown as { reason: string }).reason).toBe(true);
    expect(await movementCount(moved, 'in')).toBe(1);
  });

  it('X8 item price: refused, no pricing row written. RED on HEAD (it admits it). Mutant: drop the new check -> red', async () => {
    const w = await world('x8');
    const item = await mkItem(w, 'X8 Pork');
    await retire(w, item);
    const before = await count('item_pricing', w.orgId);
    const s = await sentenceOf(() => asOrg(w.orgId, (tx) => setItemPricing(tx, w.adm, { itemId: item, pricingMode: 'fixed', fixedAmount: '350' })));
    expect(s, RED_ACCEPTS).toBe(notActive('inactive', 'given a new price'));
    expect(await count('item_pricing', w.orgId)).toBe(before);
    const active = await mkItem(w, 'X8 Active');
    expect(await sentenceOf(() => asOrg(w.orgId, (tx) => setItemPricing(tx, w.adm, { itemId: active, pricingMode: 'fixed', fixedAmount: '350' }))), 'control').toBeNull();
  });

  describe('X9 POS map (direct mode)', () => {
    it('a NEW direct map to a retired item is refused with the outcome reason, no map written. RED on HEAD (it admits it). Mutant: drop the new check -> red', async () => {
      const w = await world('x9a');
      const item = await mkItem(w, 'X9 Coke');
      await retire(w, item);
      const before = await count('pos_item_maps', w.orgId);
      const r = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '1' }),
      );
      expect(r.ok, RED_ACCEPTS).toBe(false);
      expect(r.ok ? null : r.reason).toBe(notActive('inactive', 'mapped to a POS item'));
      expect(await count('pos_item_maps', w.orgId)).toBe(before);
      const active = await mkItem(w, 'X9 Active');
      const okMap = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'tea', posItemName: 'Tea', mode: 'direct', itemId: active, quantityPerSale: '1' }),
      );
      expect(okMap.ok, 'control: an active item maps').toBe(true);
    });

    it('CONTROL (green on HEAD): editing the quantity of an EXISTING direct map that already points at the now-retired item still saves, by editMapId and by key. Mutant: X9 without the same-item exception -> red', async () => {
      const w = await world('x9b');
      const item = await mkItem(w, 'X9 Existing');
      const made = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '1' }),
      );
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      await retire(w, item);

      const byId = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '2', editMapId: made.mapId }),
      );
      expect(byId.ok, byId.ok ? '' : byId.reason).toBe(true);
      // By key (no editMapId) the existing sharing gate (`findOtherActiveDirectMapByItem`) sees the map as "another" map on this
      // item and asks for confirmShared; that is today's behaviour and is unrelated to retiring, so the leg confirms it.
      const byKey = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '3', confirmShared: true }),
      );
      expect(byKey.ok, byKey.ok ? '' : byKey.reason).toBe(true);
      expect((await sql<{ q: string }[]>`select quantity_per_sale::text q from pos_item_maps where id = ${made.mapId}`)[0]!.q).toBe('3.000000');
    });

    it('an edit that CHANGES the POS item key while pointing at a retired item is refused (the exception is the same map, same key). RED until the builder fix. Mutant: the exception ignores the key -> red', async () => {
      const w = await world('x9d');
      const item = await mkItem(w, 'X9 Rekey');
      const made = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '1' }),
      );
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      await retire(w, item);
      const r = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'pepsi', posItemName: 'Pepsi', mode: 'direct', itemId: item, quantityPerSale: '1', editMapId: made.mapId, confirmShared: true }),
      );
      expect(r.ok, RED_ACCEPTS).toBe(false);
      expect(r.ok ? null : r.reason).toBe(notActive('inactive', 'mapped to a POS item'));
      expect((await sql<{ k: string }[]>`select pos_item_key k from pos_item_maps where id = ${made.mapId}`)[0]!.k).toBe('coke');
    });

    it('editing an ENDED (inactive) map that points at a retired item is refused: only a live map keeps the exception. RED until the builder fix. Mutant: the exception accepts an ended map -> red', async () => {
      const w = await world('x9e');
      const item = await mkItem(w, 'X9 Ended');
      const made = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '1' }),
      );
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      await sql`update pos_item_maps set status = 'inactive' where id = ${made.mapId}`;
      expect((await sql<{ s: string }[]>`select status s from pos_item_maps where id = ${made.mapId}`)[0]!.s, 'fixture: the map is ended').toBe('inactive');
      await retire(w, item);
      const r = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: item, quantityPerSale: '2', editMapId: made.mapId }),
      );
      expect(r.ok, RED_ACCEPTS).toBe(false);
      expect(r.ok ? null : r.reason).toBe(notActive('inactive', 'mapped to a POS item'));
    });

    it('re-pointing an existing map at a DIFFERENT retired item is refused (the exception is for the SAME item only). RED on HEAD (it admits it). Mutant: the exception widened to any retired item -> red', async () => {
      const w = await world('x9c');
      const current = await mkItem(w, 'X9 Current');
      const other = await mkItem(w, 'X9 Other');
      const made = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: current, quantityPerSale: '1' }),
      );
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      await retire(w, other);
      const r = await asOrg(w.orgId, (tx) =>
        upsertPosItemMap(tx, w.mgr, { orgId: w.orgId, storeId: w.A, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: other, quantityPerSale: '1', editMapId: made.mapId }),
      );
      expect(r.ok, RED_ACCEPTS).toBe(false);
      expect(r.ok ? null : r.reason).toBe(notActive('inactive', 'mapped to a POS item'));
      expect((await sql<{ item_id: string }[]>`select item_id from pos_item_maps where id = ${made.mapId}`)[0]!.item_id).toBe(current);
    });
  });

  describe('X10 new recipe', () => {
    const recipeOf = (w: World, outputItemId: string, lineItemId: string) => ({
      orgId: w.orgId, name: uid('Recipe'), outputItemId, outputQuantity: '1', lines: [{ itemId: lineItemId, quantity: '1', unit: 'kg' }],
    });

    it('a retired OUTPUT is refused ("The output: ..."), no recipe written. RED on HEAD (it admits it). Mutant: drop the output check -> red', async () => {
      const w = await world('x10a');
      const retiredOut = await mkItem(w, 'X10 Out');
      const ingredient = await mkItem(w, 'X10 In');
      await retire(w, retiredOut);
      const before = await count('production_recipes', w.orgId);
      const r = await asOrg(w.orgId, (tx) => createRecipe(tx, w.adm, recipeOf(w, retiredOut, ingredient)));
      expect(r.ok, RED_ACCEPTS).toBe(false);
      expect(r.ok ? null : r.reason).toBe(notActive('inactive', 'put on a new recipe', 'The output'));
      expect(await count('production_recipes', w.orgId)).toBe(before);
      const activeOut = await mkItem(w, 'X10 Active Out');
      expect((await asOrg(w.orgId, (tx) => createRecipe(tx, w.adm, recipeOf(w, activeOut, ingredient)))).ok, 'control: all active').toBe(true);
    });

    it('a retired INGREDIENT is refused ("Ingredient line n: ..."), no recipe written. RED on HEAD (it admits it). Mutant: drop the line check -> red', async () => {
      const w = await world('x10b');
      const output = await mkItem(w, 'X10 Out');
      const activeIn = await mkItem(w, 'X10 In A');
      const retiredIn = await mkItem(w, 'X10 In B');
      await retire(w, retiredIn);
      const before = await count('production_recipes', w.orgId);
      const r = await asOrg(w.orgId, (tx) =>
        createRecipe(tx, w.adm, {
          orgId: w.orgId, name: uid('Recipe'), outputItemId: output, outputQuantity: '1',
          lines: [{ itemId: activeIn, quantity: '1', unit: 'kg' }, { itemId: retiredIn, quantity: '1', unit: 'kg' }],
        }),
      );
      expect(r.ok, RED_ACCEPTS).toBe(false);
      expect(r.ok ? null : r.reason).toBe(notActive('inactive', 'put on a new recipe', 'Ingredient line 2'));
      expect(await count('production_recipes', w.orgId)).toBe(before);
    });
  });

  it('X11 customer price-list rate (UNCHANGED, already plain words): "<name> is inactive - reactivate it ...". GREEN on HEAD. Mutant: the builder routes it through notActiveItemSentence -> red', async () => {
    const w = await world('x11');
    const item = await wholesaleItem(w, 'X11 Beef');
    const list = await asOrg(w.orgId, (tx) => createPriceList(tx, w.adm, { name: uid('Wholesale') }));
    await retire(w, item);
    const before = await count('price_list_items', w.orgId).catch(() => -1);
    const s = await sentenceOf(() => asOrg(w.orgId, (tx) => setPrice(tx, w.adm, { priceListId: list.id, itemId: item, rate: '380.00' })));
    expect(s).toBe(`${await nameOf(item)} is inactive — reactivate it before quoting a rate.`);
    expect(await count('price_list_items', w.orgId).catch(() => -1)).toBe(before);
    const active = await wholesaleItem(w, 'X11 Active');
    expect(await sentenceOf(() => asOrg(w.orgId, (tx) => setPrice(tx, w.adm, { priceListId: list.id, itemId: active, rate: '380.00' }))), 'control').toBeNull();
  });

  it('X12 commissary offering (UNCHANGED): "<name> is inactive, not active - only an active item can be offered.". GREEN on HEAD. Mutant: rerouted through the new sentence -> red', async () => {
    const w = await world('x12');
    const item = await mkItem(w, 'X12 Pork');
    await retire(w, item);
    const before = await count('commissary_item_offerings', w.orgId);
    const s = await sentenceOf(() => asOrg(w.orgId, (tx) => upsertOffering(tx, w.su, { commissaryStoreId: w.COM, itemId: item })));
    expect(s).toBe(`${await nameOf(item)} is inactive, not active — only an active item can be offered.`);
    expect(await count('commissary_item_offerings', w.orgId)).toBe(before);
    const active = await mkItem(w, 'X12 Active');
    expect(await sentenceOf(() => asOrg(w.orgId, (tx) => upsertOffering(tx, w.su, { commissaryStoreId: w.COM, itemId: active }))), 'control').toBeNull();
  });

  it('X13 commissary item map (UNCHANGED): "<name> is inactive, not active." for the commissary item and for the branch item. GREEN on HEAD. Mutant: rerouted through the new sentence -> red', async () => {
    const w = await world('x13');
    await sql`insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by) values (${w.orgId}, ${w.COM}, ${w.BR}, ${w.su.personId})`;
    const retiredCom = await mkItem(w, 'X13 Com');
    const retiredBr = await mkItem(w, 'X13 Br');
    const activeCom = await mkItem(w, 'X13 Active Com');
    const activeBr = await mkItem(w, 'X13 Active Br');
    await retire(w, retiredCom);
    await retire(w, retiredBr);
    const before = await count('commissary_item_map', w.orgId);
    const map = (commissaryItemId: string, branchItemId: string) =>
      sentenceOf(() => asOrg(w.orgId, (tx) => upsertMap(tx, w.su, { commissaryStoreId: w.COM, branchStoreId: w.BR, commissaryItemId, branchItemId, isLedgerOnly: true })));
    expect(await map(retiredCom, activeBr)).toBe(`${await nameOf(retiredCom)} is inactive, not active.`);
    expect(await map(activeCom, retiredBr)).toBe(`${await nameOf(retiredBr)} is inactive, not active.`);
    expect(await count('commissary_item_map', w.orgId)).toBe(before);
    expect(await map(activeCom, activeBr), 'control: both active').toBeNull();
  });
});

// =================================================================================================================
// L1: itemsRepo.listUsableItems(tx, orgId, storeId)
// =================================================================================================================
// SPEC DEFECT (B2.5 L1 "retired -2 -> not"): the leg cannot be built. `stock_movements_no_negative_on_hand_trg` (migrations 0063/0142)
// refuses any movement that would leave an (item, location) below zero, so a store's on-hand can never be negative and the `<> 0`
// mutant is equivalent to `> 0`. The +3 then -3 leg (a sum of exactly zero) is what separates `> 0` from `>= 0`.
describe('L1 - listUsableItems: active, plus retired items with stock ABOVE zero at THIS store', () => {
  /** A raw ledger line: no layers, no journal; this read only sums `quantity` per store. */
  async function ledger(w: World, itemId: string, storeId: string, locationId: string, qty: string): Promise<void> {
    await sql`
      insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${w.orgId}, ${storeId}, ${locationId}, ${itemId}, now(), ${qty}, 'opening', 'test_seed', ${crypto.randomUUID()}, ${w.su.personId})`;
  }

  it('lists exactly the usable items at store A; the +5 item is not listed at store B; another org never leaks. RED on HEAD (listUsableItems does not exist). Mutants: `>= 0` for `> 0` -> the +3-3 leg red (a `<> 0` mutant is EQUIVALENT, see SPEC DEFECT above); no store filter -> the store-B leg red; no org filter -> the other-org leg red', async () => {
    const w = await world('l1');
    const activeNoStock = await mkItem(w, 'L1 Active');
    const retiredPlus5 = await mkItem(w, 'L1 Retired plus five');
    const retiredNetZero = await mkItem(w, 'L1 Retired plus three minus three');
    const mergedWithStock = await mkItem(w, 'L1 Merged with stock');
    const winner = await mkItem(w, 'L1 Winner');
    await ledger(w, retiredPlus5, w.A, w.kitchenA, '5');
    await ledger(w, retiredNetZero, w.A, w.kitchenA, '3');
    await ledger(w, retiredNetZero, w.A, w.kitchenA, '-3');
    await ledger(w, mergedWithStock, w.A, w.kitchenA, '4');
    for (const id of [retiredPlus5, retiredNetZero]) await retire(w, id);
    await sql`update items set status = 'merged', merged_into_id = ${winner} where id = ${mergedWithStock}`;
    expect(await statusOf(mergedWithStock), 'fixture').toBe('merged');
    expect(await onHandAtStore(retiredPlus5, w.A), 'fixture').toBe('5.000');
    expect(await onHandAtStore(retiredNetZero, w.A), 'fixture').toBe('0.000');

    // Another org: a retired item with stock above zero, in its own store. The A and B reads go through asOrg (RLS on). The cross-org leg
    // ALSO runs on the test's own owner connection (`sql`, which bypasses row-level security, as every fixture insert here does), so
    // there only the query's own org filter can keep the other org's item out.
    const other = await world('l1-other');
    const otherItem = await mkItem(other, 'L1 Other org retired');
    // An ACTIVE item of the other org needs no stock to be offered, so only the org filter keeps it out (the movement org filter cannot).
    const otherActive = await mkItem(other, 'L1 Other org active');
    // Migration 0194 (T-398 S1): the other org's item can no longer hold stock at THIS org's store (w.A), because
    // stock_movements (org_id, store_id) is a same-org composite FK. That fixture is impossible by construction, so the leg now asserts
    // the DB refuses it (23503 naming the constraint). The org filter is still proven by the ACTIVE other-org item above (it needs no
    // stock, so only items.org_id can exclude it), and the other org's retired item holds +9 at its OWN store.
    const crossOrg = await sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${other.orgId}, ${w.A}, ${w.kitchenA}, ${otherItem}, now(), 9, 'opening', 'test_seed', ${crypto.randomUUID()}, ${other.su.personId})`.then(
      () => null,
      (e: { code?: string; constraint_name?: string }) => e,
    );
    expect(crossOrg?.code, 'a cross-org stock movement is refused by the DB').toBe('23503');
    expect(crossOrg?.constraint_name).toBe('stock_movements_store_id_same_org_fk');
    await sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${other.orgId}, ${other.A}, ${other.kitchenA}, ${otherItem}, now(), 9, 'opening', 'test_seed', ${crypto.randomUUID()}, ${other.su.personId})`;
    await retire(other, otherItem);

    const idsAt = async (storeId: string) => (await asOrg(w.orgId, (tx) => listUsableItems(tx, w.orgId, storeId))).map((r) => r.id);
    const ownerIds = (await drizzle(sql).transaction((tx) => listUsableItems(tx as unknown as Tx, w.orgId, w.A))).map((r) => r.id);
    expect(ownerIds, 'sanity: the owner connection sees the real rows').toContain(retiredPlus5);
    expect(ownerIds, "another org's ACTIVE item is never listed (RLS bypassed: only items.org_id can exclude it)").not.toContain(otherActive);
    expect(ownerIds, 'the repo query own org filter keeps another org out (RLS bypassed)').not.toContain(otherItem);
    const atA = await idsAt(w.A);
    expect(atA).toContain(activeNoStock);
    expect(atA).toContain(retiredPlus5);
    expect(atA, 'retired +3 then -3 is used up').not.toContain(retiredNetZero);
    expect(atA, 'merged never').not.toContain(mergedWithStock);
    expect(atA, 'another org never').not.toContain(otherItem);
    const atB = await idsAt(w.B);
    expect(atB, 'the +5 is at store A, not B').not.toContain(retiredPlus5);
    expect(atB, 'an active item is usable at every store').toContain(activeNoStock);
  });
});
