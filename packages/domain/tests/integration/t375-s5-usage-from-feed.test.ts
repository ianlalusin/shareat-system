import { config } from 'dotenv';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-375 S5 (S5-lite) - usage reads the sold items the import stored. `docs/tasks/375-pos-v1-day-feed.md` section S5,
 * tests U1-U13 (SI1-SI4 are `tests/unit/t375-s5-sold-items.test.ts`, W1 is `apps/erp/tests/integration/
 * t375-s5-pos-usage-page.test.ts`, G5 is `tests/unit/t375-s5-no-live-usage-fetch.test.ts`).
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET: the spec's sentences word for word, exact quantities, the
 * pinned feed id. Every refusal has a positive control.
 *
 * ## Why these are red on HEAD
 * HEAD's `buildPlan` / `finalizeSections` call POS LIVE (`fetchPosSoldItemsLive`). In this file `POS_API_URL` is unset
 * and `fetch` is a spy that throws, so on HEAD every call throws "POS_API_URL or POS_API_KEY is not configured" BEFORE
 * it reaches any assertion about the target - red on the first target assertion (a plan that should exist, a sentence
 * that should be returned). No leg is red on a missing module.
 *
 * ## Fixture (spec "Tests")
 * A LINKED store; maps A -> Cheese direct x1, B -> Buns direct x0.5 (and R -> a recipe on Cheese, used only by U12);
 * day D imported with sold items {A: 3, B: 2} (the import's `sold_items` row = F1); `fetch` stubbed to a spy that
 * records calls and throws; `POS_API_URL` unset. Cheese and Buns are stocked at the kitchen, so a finalize really posts.
 *
 * ## How the target is read where the spec is silent (a question to the builder, not a test edit)
 *  - the plan outcome carries `soldItemsFeed: { id, fetchedAt, purpose }` (spec BUILDER); read through a cast so the
 *    file COMPILES before the builder adds it;
 *  - `buildPlan` / `finalizeSections` return `{ ok: false, reason }` for every business refusal (this module's
 *    convention) and THROW only `AuthorizationError`;
 *  - quantities are `Quantity` strings: 3 is '3.000', 0.5 x 2 is '1.000';
 *  - U4 says "both records reversed"; with Cheese and Buns both resolving to the kitchen, U1 makes ONE record (spec U1:
 *    "one usage record at the pull's location"), so U4 asserts every record the pull made is reversed and counts it.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseBusinessDate } from '@shareat/core/datetime';
import { POS_V1_SOLD_ITEMS_FIELDS as I } from '../../../db/src/pos-v1/wire';
import type { PosV1SoldItemInput } from '../../../db/src/pos-v1/fixtures';
import * as D from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { humanDate as humanDateOf } from '../../src/shared/refusal-leaf';
import type { LocationLike } from '../../src/stock-locations/rules';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import { mkSubmitter, submitThenVerify } from './_fixtures/sales-day-flow';
import { insertRecheckBatch } from './_fixtures/pos-sold-items';
import { testItemCode } from './_fixtures/item-code';

const hd = (d: string) => humanDateOf(parseBusinessDate(d));
const sql = postgres(url, { max: 12 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const fetchSpy = vi.fn(async (..._args: unknown[]) => {
  throw new Error('LIVE POS FETCH: usage must read the stored feed, never call POS');
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
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
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

// ---- concurrency harness (verbatim shape of t374-s7-void-pos-usage-pull.test.ts) --------------------
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function trackPid<T>(op: (tx: Tx) => Promise<T>): { op: (tx: Tx) => Promise<T>; pid: Promise<number> } {
  const pid = deferred<number>();
  return {
    pid: pid.promise,
    op: async (tx) => {
      const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
      pid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
      return op(tx);
    },
  };
}
async function pollForWaitingBackend(bPid: Promise<number>, waitEvents: string[], settleWatch: Promise<unknown>, timeoutMs = 5000) {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<{ pid: number; query: string } | null> => {
    const pid = await Promise.race([bPid, settled.then(() => 0)]);
    if (!pid) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number; query: string }[]>`
        select pid, query from pg_stat_activity
        where datname = current_database() and pid = ${pid}
          and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  })();
  return Promise.race([poll, settled.then(() => null)]);
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
async function runConcurrencyLeg<TA, TB>(
  orgId: string,
  opA: (tx: Tx) => Promise<TA>,
  opB: (tx: Tx) => Promise<TB>,
  waitEvents: string[],
): Promise<{ aResult: Settled<TA>; bResult: Settled<TB>; bWaited: boolean }> {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aPromise: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  await aReady.promise;
  const trackedB = trackPid(opB);
  const bPromise: Promise<Settled<TB>> = asOrg(orgId, trackedB.op).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  const waiting = await pollForWaitingBackend(trackedB.pid, waitEvents, bPromise, 5000);
  gate.resolve();
  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited: !!waiting };
}
const ROW_LOCK = ['transactionid', 'tuple'];

// ---- fixture ---------------------------------------------------------------------------------------
const DAY = '2027-01-10'; // D
const DAY2 = '2027-01-11';
const TYPED = '2027-01-09';
const AB: readonly PosV1SoldItemInput[] = [
  { key: 'A', name: 'A', physicalQty: 3 },
  { key: 'B', name: 'B', physicalQty: 2 },
];
const ABR: readonly PosV1SoldItemInput[] = [...AB, { key: 'R', name: 'R', physicalQty: 10 }];
const A4B2: readonly PosV1SoldItemInput[] = [
  { key: 'A', name: 'A', physicalQty: 4 },
  { key: 'B', name: 'B', physicalQty: 2 },
];
const ZERO_FIGURES = { paidTotal: 0, receiptCount: 0, packageOnly: 0, discounts: 0, charges: 0, methods: {} };

async function fixture(hint: string, o: { link?: boolean } = {}) {
  const code = uid(`t375s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  // Contiguous open months: the stock-in month (Dec 2026), the sales days' month (Jan 2027) and one after.
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series('2026-12-01'::date, '2027-02-01'::date, interval '1 month') m`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, ${name}, 'multi_room') returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas'); // never linked
  const mkPerson = async (name: string, role: string | null, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await mkPerson('Manager', 'manager', [storeId, store2Id]);
  const staffId = await mkPerson('Staffer', 'staff', [storeId]);
  const nobodyId = await mkPerson('Nobody', null, [storeId, store2Id]);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });

  const mkChannel = async (sid: string) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${sid}, 'Walk-in', true) returning id`)[0]!.id;
  const walkIn = await mkChannel(storeId);
  const walkIn2 = await mkChannel(store2Id);
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (sid: string, c: string) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sid}, ${c}, 'Kitchen', ${type!.id}, 'operating', true, ${managerId}) returning id`)[0]!.id;
  const kitchen = await mkRoom(storeId, 'KIT');
  const kitchen2 = await mkRoom(store2Id, 'KIT');
  const locations: LocationLike[] = [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];
  const mkItem = async (c: string, name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, ${name}, 'meat_slab', 'kg', ${managerId}) returning id`)[0]!.id;
  const cheese = await mkItem('CHEESE', 'Cheese');
  const buns = await mkItem('BUNS', 'Buns');
  for (const itemId of [cheese, buns]) {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
      values (${orgId}, ${`orgs/${orgId}/p-${uid('f')}.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
    const [del] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgId}, ${storeId}, 'purchase', '2026-12-02', ${file!.id}, ${managerId}) returning id`;
    await asOrg(orgId, (tx) =>
      receiveDelivery(tx, {
        orgId, storeId, deliveryId: del!.id, deliveredOn: '2026-12-02', locations, receivedBy: managerId,
        lines: [{ lineId: '1', itemId, itemKind: 'meat_slab', receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '10.0000', locationId: kitchen }],
      }),
    );
  }
  const [recipe] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
    values (${orgId}, 'R Box', ${cheese}, 1, ${managerId}) returning id`;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipe!.id}, ${cheese}, 0.2, 'g')`;

  const manager = actorOf(orgId, managerId);
  await asOrg(orgId, async (tx) => {
    await D.upsertPosItemMap(tx, manager, { orgId, storeId, posItemKey: 'A', posItemName: 'A', mode: 'direct', itemId: cheese, quantityPerSale: '1' });
    await D.upsertPosItemMap(tx, manager, { orgId, storeId, posItemKey: 'B', posItemName: 'B', mode: 'direct', itemId: buns, quantityPerSale: '0.5', confirmShared: true });
    await D.upsertPosItemMap(tx, manager, { orgId, storeId, posItemKey: 'R', posItemName: 'R', mode: 'recipe', recipeId: recipe!.id });
  });

  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });
  const linkNow = () => linkTestStore(sql, { orgId, storeId, channelId: walkIn, createdBy: managerId });
  const posStoreId = o.link === false ? '' : (await linkNow()).posStoreId;

const submitter = await mkSubmitter(sql, orgId, [storeId, store2Id]);
  return {
    orgId, storeId, store2Id, walkIn, walkIn2, kitchen, kitchen2, cheese, buns, managerId, staffId, nobodyId, posStoreId, linkNow,
    manager, submitter, staff: actorOf(orgId, staffId), nobody: actorOf(orgId, nobodyId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const imp = async (f: F, date: string, soldItems: readonly PosV1SoldItemInput[] = AB, figures?: Parameters<typeof importTestDay>[2]['figures']): Promise<string> =>
  (await asOrg(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date, soldItems, figures }))).id;
const plan = (f: F, salesDayId: string, who: Actor = f.manager, storeId = f.storeId, locationId = f.kitchen) =>
  asOrg(f.orgId, (tx) => D.buildPlan(tx, who, { orgId: f.orgId, storeId, salesDayId, locationId }));
const fin = (f: F, pullId: string, keys: string[], sections: ('direct' | 'recipe' | 'orphan')[] = ['direct'], who: Actor = f.manager) =>
  asOrg(f.orgId, (tx) => D.finalizeSections(tx, who, { pullId, sections, confirmedKeys: keys }));
const recheck = (f: F, date: string, o: Partial<Parameters<typeof insertRecheckBatch>[1]> = {}) =>
  asOrg(f.orgId, (tx) =>
    insertRecheckBatch(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: date, posStoreId: f.posStoreId, fetchedBy: f.managerId, soldItems: AB, ...o }),
  );
const reimport = async (f: F, date: string, soldItems: readonly PosV1SoldItemInput[]) => imp(f, date, soldItems);

type Planned = Extract<Awaited<ReturnType<typeof plan>>, { ok: true }>;
async function mustPlan(f: F, dayId: string): Promise<Planned> {
  const p = await plan(f, dayId);
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  return p;
}
const feedOf = (p: unknown) => (p as { soldItemsFeed?: { id: string; fetchedAt: Date; purpose: string } }).soldItemsFeed;
const directKeys = (p: Planned) => p.lines.filter((l) => l.section === 'direct' && !l.blocked).map((l) => l.key);
const recipeKeys = (p: Planned) => p.lines.filter((l) => l.section === 'recipe' && !l.blocked).map((l) => l.key);
const reasonOf = (r: { ok: boolean; reason?: string }): string => {
  expect(r.ok, 'must be refused').toBe(false);
  return String(r.reason);
};

const num = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await q) as unknown as { n: string }[])[0]!.n);
const pullCount = (f: F) => num(sql`select count(*)::text as n from pos_usage_pulls where org_id = ${f.orgId}`);
const usageCount = (f: F) => num(sql`select count(*)::text as n from stock_usage_records where org_id = ${f.orgId}`);
const onHand = async (itemId: string): Promise<string> =>
  (await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId}`)[0]!.t;
const soldItemsFeeds = (f: F, date: string) =>
  sql<{ id: string; purpose: string; fetched_at: Date }[]>`
    select id, purpose, fetched_at from pos_v1_day_feeds
     where store_id = ${f.storeId} and business_date = ${date} and kind = 'sold_items' order by fetched_at, id`;
const pullRow = async (id: string) => {
  const [r] = await sql<Record<string, unknown>[]>`select * from pos_usage_pulls where id = ${id}`;
  return r as { status: string; pos_v1_day_feed_id: string | null; direct_finalized_at: Date | null; recipe_finalized_at: Date | null; location_id: string };
};
const pullLines = (pullId: string) =>
  sql`select id, section, line_key, quantity, usage_record_id from pos_usage_pull_lines where pull_id = ${pullId} order by id`;
const directLinks = (pullId: string) =>
  sql`select id, line_key, usage_record_id from pos_usage_pull_lines where pull_id = ${pullId} and section = 'direct' order by id`;

const S = {
  changed: (d: string) => `POS's sold items for ${hd(d)} changed after this plan was built. Build the plan again.`,
  preS5: "This plan was built before usage read POS's stored sold items. Build the plan again.",
  partlyChanged: (d: string) => `POS's sold items for ${hd(d)} changed after part of this pull was posted. Void the pull and build the day again.`,
  partlyNoPin: 'Part of this pull was posted before usage read POS\'s stored sold items. Void the pull and build the day again.',
  noItems: (d: string, total: string) => `POS sent no sold items for ${hd(d)}, but the day has ${total} in sales, so usage can't be pulled. Tell the office.`,
  unreadable: (d: string) => `POS's stored sold items for ${hd(d)} can't be read, so usage can't be pulled. Tell the office.`,
  unlinked: (store: string) => `${store} isn't linked to a POS store yet, so its usage can't be pulled. An admin links it under Settings › POS link.`,
  typed: (store: string, d: string) =>
    `${store}'s sales for ${hd(d)} were typed in before it was linked to POS, so there are no POS sold items to pull. Record that day's usage by hand under Inventory › Usage & wastage.`,
};

// =====================================================================================================
describe('U1 - plan and finalize read the stored feed; POS is never called', () => {
  it('plan: lines direct:A 3.000 and direct:B 1.000, pinned to F1, soldItemsFeed = F1 import; finalize posts Cheese 3 and Buns 1 at the pull location dated D; 0 fetch calls', async () => {
    const f = await fixture('u1');
    const dayId = await imp(f, DAY);
    const [f1] = await soldItemsFeeds(f, DAY);
    expect(f1, 'control: the import stored a sold_items feed').toBeDefined();

    const p = await mustPlan(f, dayId);
    expect(p.lines.filter((l) => l.section === 'direct').map((l) => [l.key, l.quantity])).toEqual([
      ['direct:A', '3.000'],
      ['direct:B', '1.000'],
    ]);
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id).toBe(f1!.id);
    const sf = feedOf(p);
    expect(sf?.id).toBe(f1!.id);
    expect(sf?.purpose).toBe('import');
    expect(sf?.fetchedAt.getTime()).toBe(f1!.fetched_at.getTime());
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    const out = await fin(f, p.pullId, directKeys(p));
    expect(out.ok, out.ok ? '' : out.reason).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    const records = await sql<{ id: string; location_id: string; used_on: string }[]>`
      select id, location_id, to_char(used_on, 'YYYY-MM-DD') as used_on from stock_usage_records where org_id = ${f.orgId}`;
    expect(records, 'one usage record').toHaveLength(1);
    expect(records[0]!.location_id).toBe(f.kitchen);
    expect(records[0]!.used_on).toBe(DAY);
    const lines = await sql<{ item_id: string; quantity: string }[]>`select item_id, quantity from stock_usage_lines where record_id = ${records[0]!.id}`;
    expect(Object.fromEntries(lines.map((l) => [l.item_id, l.quantity]))).toEqual({ [f.cheese]: '3.000', [f.buns]: '1.000' });
    expect(await onHand(f.cheese)).toBe('97.000');
    expect(await onHand(f.buns)).toBe('99.000');
  });
});

describe('U2 - a recheck is the latest feed', () => {
  it('a recheck batch for D with {A 4, B 2} (row F2) -> buildPlan pins F2 and plans A 4.000', async () => {
    const f = await fixture('u2');
    const dayId = await imp(f, DAY);
    const f2 = (await recheck(f, DAY, { soldItems: A4B2 })).ids.sold_items!;
    const p = await mustPlan(f, dayId);
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id).toBe(f2);
    expect(feedOf(p)?.id).toBe(f2);
    expect(feedOf(p)?.purpose).toBe('recheck');
    expect(p.lines.find((l) => l.key === 'direct:A')?.quantity).toBe('4.000');
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('control: with no recheck the pin is F1 and A is 3.000', async () => {
    const f = await fixture('u2c');
    const dayId = await imp(f, DAY);
    const [f1] = await soldItemsFeeds(f, DAY);
    const p = await mustPlan(f, dayId);
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id).toBe(f1!.id);
    expect(p.lines.find((l) => l.key === 'direct:A')?.quantity).toBe('3.000');
  });
});

describe('U3 - finalize refuses a newer DIFFERENT feed, and only that', () => {
  it('plan (pin F1); re-import D with {A 4, B 2} (F3) -> the changed sentence; 0 usage records; no section stamped', async () => {
    const f = await fixture('u3');
    const dayId = await imp(f, DAY);
    const p = await mustPlan(f, dayId);
    await reimport(f, DAY, A4B2);
    const out = await fin(f, p.pullId, directKeys(p));
    expect(reasonOf(out)).toBe(S.changed(DAY));
    expect(await usageCount(f)).toBe(0);
    expect((await pullRow(p.pullId)).direct_finalized_at, 'no section stamped').toBeNull();
    expect(await onHand(f.cheese)).toBe('100.000');
  });

  it('control 1: a re-import with IDENTICAL items {B 2, A 3} (F3\') posts Cheese 3', async () => {
    const f = await fixture('u3c1');
    const dayId = await imp(f, DAY);
    const p = await mustPlan(f, dayId);
    await reimport(f, DAY, [{ key: 'B', name: 'other name', physicalQty: 2 }, { key: 'A', name: 'other name', physicalQty: 3 }]);
    expect((await soldItemsFeeds(f, DAY)).length, 'control: the re-import stored a newer feed').toBe(2);
    const out = await fin(f, p.pullId, directKeys(p));
    expect(out.ok, out.ok ? '' : out.reason).toBe(true);
    expect(await onHand(f.cheese)).toBe('97.000');
  });

  it('control 2: after F3, building again re-pins to F3 and finalize posts Cheese 4', async () => {
    const f = await fixture('u3c2');
    const dayId = await imp(f, DAY);
    const p = await mustPlan(f, dayId);
    await reimport(f, DAY, A4B2);
    expect(reasonOf(await fin(f, p.pullId, directKeys(p)))).toBe(S.changed(DAY));
    const f3 = (await soldItemsFeeds(f, DAY)).at(-1)!;
    const again = await mustPlan(f, dayId);
    expect(again.pullId).toBe(p.pullId);
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id, 'the refresh rewrites the pin').toBe(f3.id);
    const out = await fin(f, again.pullId, directKeys(again));
    expect(out.ok, out.ok ? '' : out.reason).toBe(true);
    expect(await onHand(f.cheese)).toBe('96.000');
  });
});

describe('U4 - a voided pull frees the day; the next plan reads the latest feed', () => {
  it('finalize, void (a manager, a reason) -> every record reversed; a recheck F2 {A 5, B 2} and buildPlan -> a NEW pull pinned to F2, A 5.000; the voided pull keeps F1; 0 fetch calls', async () => {
    const f = await fixture('u4');
    const dayId = await imp(f, DAY);
    const [f1] = await soldItemsFeeds(f, DAY);
    const p = await mustPlan(f, dayId);
    expect((await fin(f, p.pullId, directKeys(p))).ok).toBe(true);
    const records = await usageCount(f);
    expect(records, 'control: the finalize made a record').toBeGreaterThan(0);

    const out = await asOrg(f.orgId, (tx) => D.voidPosUsagePull(tx, f.manager, { pullId: p.pullId, reason: 'POS corrected' }));
    expect(out).toMatchObject({ ok: true, reversedRecordCount: records });
    expect(await onHand(f.cheese)).toBe('100.000');
    expect((await pullRow(p.pullId)).status).toBe('void');

    const f2 = (await recheck(f, DAY, { soldItems: [{ key: 'A', name: 'A', physicalQty: 5 }, { key: 'B', name: 'B', physicalQty: 2 }] })).ids.sold_items!;
    const next = await mustPlan(f, dayId);
    expect(next.pullId, 'a NEW pull').not.toBe(p.pullId);
    expect((await pullRow(next.pullId)).pos_v1_day_feed_id).toBe(f2);
    expect(next.lines.find((l) => l.key === 'direct:A')?.quantity).toBe('5.000');
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id, 'the voided pull keeps what it was pinned to').toBe(f1!.id);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe('U5 - a typed day on a store that is now linked is refused (Q-D)', () => {
  it('a VERIFIED typed day, created while unlinked, then the store is linked -> the typed-day sentence; no pull row', async () => {
    const f = await fixture('u5', { link: false });
    const typed = (
      await asOrg(f.orgId, (tx) =>
        D.createSalesDay(tx, f.manager, {
          storeId: f.storeId, businessDate: TYPED, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00',
          cashCollected: '1000.00', channels: [{ channelId: f.walkIn, amount: '1000.00' }],
        }),
      )
    ).id;
    await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, typed, f.submitter));
    await f.linkNow();

    const out = await plan(f, typed);
    expect(reasonOf(out)).toBe(S.typed('Lipa', TYPED));
    expect(await pullCount(f)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // control: the same (now linked) store's IMPORTED day plans
    const imported = await imp(f, DAY2);
    expect((await plan(f, imported)).ok).toBe(true);
  });
});

describe('U6 - an unlinked store refuses usage in a sentence (R9)', () => {
  it('Batangas (never linked) with a typed open day -> the unlinked sentence; no pull row; 0 fetch calls', async () => {
    const f = await fixture('u6');
    const typed = (
      await asOrg(f.orgId, (tx) =>
        D.createSalesDay(tx, f.manager, {
          storeId: f.store2Id, businessDate: TYPED, totalSales: '500.00', unliSales: '500.00', alaCarteSales: '0.00',
          cashCollected: '500.00', channels: [{ channelId: f.walkIn2, amount: '500.00' }],
        }),
      )
    ).id;
    const out = await plan(f, typed, f.manager, f.store2Id, f.kitchen2);
    expect(reasonOf(out)).toBe(S.unlinked('Batangas'));
    expect(await pullCount(f)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // control (U1): the linked store's imported day plans
    expect((await plan(f, await imp(f, DAY))).ok).toBe(true);
  });
});

describe('U7 - a pull built before S5-lite (no pin) is refused at finalize and fixed by building again', () => {
  it('pre-S5 pull by raw SQL -> the pre-S5-lite sentence; nothing posted; control: build again pins F1 and finalize posts', async () => {
    const f = await fixture('u7');
    const dayId = await imp(f, DAY);
    const [f1] = await soldItemsFeeds(f, DAY);
    const [raw] = await sql<{ id: string }[]>`
      insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at, status)
      values (${f.orgId}, ${f.storeId}, ${dayId}, ${f.kitchen}, now(), 'planned') returning id`;
    expect((await pullRow(raw!.id)).pos_v1_day_feed_id, 'control: the fixture pull really has no pin').toBeNull();

    const out = await fin(f, raw!.id, ['direct:A', 'direct:B']);
    expect(reasonOf(out)).toBe(S.preS5);
    expect(await usageCount(f)).toBe(0);
    expect((await pullRow(raw!.id)).direct_finalized_at).toBeNull();

    const again = await mustPlan(f, dayId);
    expect(again.pullId).toBe(raw!.id);
    expect((await pullRow(raw!.id)).pos_v1_day_feed_id).toBe(f1!.id);
    const ok = await fin(f, again.pullId, directKeys(again));
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);
    expect(await onHand(f.cheese)).toBe('97.000');
  });
});

describe('U8 - the newer-feed check runs under the day lock', () => {
  it('plan (pin F1). A: a re-import with {A 4, B 2}, uncommitted (holds D FOR UPDATE). B: finalize waits on the lock; A commits -> B returns the changed sentence; 0 usage records', async () => {
    const f = await fixture('u8');
    const dayId = await imp(f, DAY);
    const p = await mustPlan(f, dayId);
    const keys = directKeys(p);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: DAY, soldItems: A4B2 }),
      (tx) => D.finalizeSections(tx, f.manager, { pullId: p.pullId, sections: ['direct'], confirmedKeys: keys }),
      ROW_LOCK,
    );
    expect(aResult.status, aResult.status === 'rejected' ? String((aResult.reason as Error).message) : '').toBe('fulfilled');
    expect(bWaited, 'harness gate: finalize must have waited behind the re-import (it takes the day lock first)').toBe(true);
    expect(bResult.status, bResult.status === 'rejected' ? String((bResult.reason as Error).message) : '').toBe('fulfilled');
    expect(reasonOf((bResult as { value: { ok: boolean; reason?: string } }).value)).toBe(S.changed(DAY));
    expect(await usageCount(f)).toBe(0);
  });

  it('control: with no re-import in flight the same finalize posts', async () => {
    const f = await fixture('u8c');
    const p = await mustPlan(f, await imp(f, DAY));
    expect((await fin(f, p.pullId, directKeys(p))).ok).toBe(true);
    expect(await usageCount(f)).toBe(1);
  });
});

describe('U9 - an unreadable latest feed is refused at plan', () => {
  it('a recheck whose physicalQty is "x" -> the unreadable sentence; no pull row; control: a readable day plans', async () => {
    const f = await fixture('u9');
    const dayId = await imp(f, DAY);
    await recheck(f, DAY, { soldItemsRaw: { [I.found]: true, [I.items]: [{ [I.itemKey]: 'A', [I.itemName]: 'A', [I.physicalQty]: 'x' }] } });
    expect(reasonOf(await plan(f, dayId))).toBe(S.unreadable(DAY));
    expect(await pullCount(f)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    const readable = await imp(f, DAY2);
    expect((await plan(f, readable)).ok).toBe(true);
  });
});

describe('U10 (I5) - found false plans empty only on a PHP 0 day', () => {
  it('a PHP 0 imported day whose sold_items row is found:false -> ok, zero lines, pinned to that feed', async () => {
    const f = await fixture('u10a');
    const dayId = await imp(f, DAY, [], ZERO_FIGURES);
    const [feed] = await soldItemsFeeds(f, DAY);
    expect(feed, 'control: the import stored a sold_items feed even on a zero day').toBeDefined();
    const [d] = await sql<{ total_sales: string }[]>`select total_sales from sales_days where id = ${dayId}`;
    expect(Number(d!.total_sales), 'control: the day really is PHP 0').toBe(0);

    const p = await plan(f, dayId);
    expect(p.ok, p.ok ? '' : p.reason).toBe(true);
    if (!p.ok) return;
    expect(p.lines).toHaveLength(0);
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id).toBe(feed!.id);
  });

  it('negative: day D (PHP 1,100.00) with a later found:false recheck -> the no-items sentence naming PHP 1,100.00; no pull row', async () => {
    const f = await fixture('u10b');
    const dayId = await imp(f, DAY);
    const [d] = await sql<{ total_sales: string }[]>`select total_sales from sales_days where id = ${dayId}`;
    expect(d!.total_sales, 'control: the day carries 1,100.00').toBe('1100.00');
    await recheck(f, DAY, { soldItems: [], found: false });
    expect(reasonOf(await plan(f, dayId))).toBe(S.noItems(DAY, '₱1,100.00'));
    expect(await pullCount(f)).toBe(0);
  });
});

describe('U11 (I1, I2) - authorize first; finalize needs its own capability', () => {
  it('a person without record_stock_movement on an UNLINKED store -> AuthorizationError, not the unlinked sentence', async () => {
    const f = await fixture('u11a');
    const typed = (
      await asOrg(f.orgId, (tx) =>
        D.createSalesDay(tx, f.manager, {
          storeId: f.store2Id, businessDate: TYPED, totalSales: '500.00', unliSales: '500.00', alaCarteSales: '0.00',
          cashCollected: '500.00', channels: [{ channelId: f.walkIn2, amount: '500.00' }],
        }),
      )
    ).id;
    await expect(plan(f, typed, f.nobody, f.store2Id, f.kitchen2)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await pullCount(f)).toBe(0);
  });

  it('without it on D -> AuthorizationError and no pull row; control: staff (who has it) plans D', async () => {
    const f = await fixture('u11b');
    const dayId = await imp(f, DAY);
    await expect(plan(f, dayId, f.nobody)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await pullCount(f)).toBe(0);
    expect((await plan(f, dayId, f.staff)).ok).toBe(true);
  });

  it('with record_stock_movement but not finalize_pos_usage_pull -> finalize refused; control: the manager posts (U1)', async () => {
    const f = await fixture('u11c');
    const p = (await plan(f, await imp(f, DAY), f.staff)) as Planned;
    expect(p.ok).toBe(true);
    await expect(fin(f, p.pullId, directKeys(p), ['direct'], f.staff)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await usageCount(f)).toBe(0);
    const ok = await fin(f, p.pullId, directKeys(p));
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);
    expect(await usageCount(f)).toBe(1);
  });
});

describe('U12 (stock hole) - a partly finalized pull never moves its pin', () => {
  async function partly(hint: string) {
    const f = await fixture(hint);
    const dayId = await imp(f, DAY, ABR);
    const [f1] = await soldItemsFeeds(f, DAY);
    const p = await mustPlan(f, dayId);
    expect(recipeKeys(p), 'control: the fixture has a recipe line to finalize later').toHaveLength(1);
    const direct = await fin(f, p.pullId, directKeys(p));
    expect(direct.ok, direct.ok ? '' : direct.reason).toBe(true);
    expect(await onHand(f.cheese), 'control: Direct posted Cheese 3').toBe('97.000');
    return { f, dayId, f1: f1!, p };
  }

  it('Direct posted; re-import D with {A 4, B 2, R 10} (F3); Recipe finalize -> the changed sentence; buildPlan again -> the partly-posted sentence; the pin is still F1; no line rewritten', async () => {
    const { f, dayId, f1, p } = await partly('u12');
    await reimport(f, DAY, [{ key: 'A', name: 'A', physicalQty: 4 }, { key: 'B', name: 'B', physicalQty: 2 }, { key: 'R', name: 'R', physicalQty: 10 }]);
    const linesBefore = await pullLines(p.pullId);
    const usageBefore = await usageCount(f);

    // a pull with a finalized section: the rebuild would be refused too, so finalize says void-and-rebuild
    expect(reasonOf(await fin(f, p.pullId, recipeKeys(p), ['recipe']))).toBe(S.partlyChanged(DAY));
    expect(await usageCount(f)).toBe(usageBefore);

    expect(reasonOf(await plan(f, dayId))).toBe(S.partlyChanged(DAY));
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id, 'the pin is still F1').toBe(f1.id);
    expect(await pullLines(p.pullId), 'no line rewritten, no link touched').toEqual(linesBefore);
  });

  it('positive control: a re-import with IDENTICAL items (F3\') -> buildPlan ok, the pin stays F1 (not F3\'), Direct lines and their usage-record links untouched, and Recipe then finalizes', async () => {
    const { f, dayId, f1, p } = await partly('u12c');
    const directBefore = await directLinks(p.pullId);
    expect(directBefore.every((r) => r.usage_record_id), 'control: the direct lines are linked to a record').toBe(true);
    await reimport(f, DAY, [{ key: 'R', name: 'r', physicalQty: 10 }, { key: 'B', name: 'b', physicalQty: 2 }, { key: 'A', name: 'a', physicalQty: 3 }]);
    const feeds = await soldItemsFeeds(f, DAY);
    expect(feeds.length, 'control: a newer feed exists').toBe(2);

    const again = await plan(f, dayId);
    expect(again.ok, again.ok ? '' : again.reason).toBe(true);
    if (!again.ok) return;
    expect(again.pullId).toBe(p.pullId);
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id, 'the pin stays F1').toBe(f1.id);
    expect(feedOf(again)?.id).toBe(f1.id);
    expect(await directLinks(p.pullId)).toEqual(directBefore);

    const recipe = await fin(f, p.pullId, recipeKeys(again), ['recipe']);
    expect(recipe.ok, recipe.ok ? '' : recipe.reason).toBe(true);
    expect(recipe.ok && recipe.sections[0]).toMatchObject({ ok: true, postedLineCount: 1 });
  });

  it('leg b: a partly finalized pull with a NULL pin (raw SQL fixture) -> the no-pin partly-posted sentence', async () => {
    const { f, dayId, p } = await partly('u12b');
    await sql`update pos_usage_pulls set pos_v1_day_feed_id = null where id = ${p.pullId}`;
    expect(reasonOf(await plan(f, dayId))).toBe(S.partlyNoPin);
    expect((await pullRow(p.pullId)).pos_v1_day_feed_id, 'nothing written').toBeNull();
  });
});

describe('U13 - an unreadable newer feed at finalize refuses (never "no change")', () => {
  it('plan (pin F1); a recheck whose physicalQty is "x" -> finalize returns the unreadable sentence; 0 usage records; no section stamped', async () => {
    const f = await fixture('u13');
    const p = await mustPlan(f, await imp(f, DAY));
    await recheck(f, DAY, { soldItemsRaw: { [I.found]: true, [I.items]: [{ [I.itemKey]: 'A', [I.itemName]: 'A', [I.physicalQty]: 'x' }] } });
    expect(reasonOf(await fin(f, p.pullId, directKeys(p)))).toBe(S.unreadable(DAY));
    expect(await usageCount(f)).toBe(0);
    expect((await pullRow(p.pullId)).direct_finalized_at, 'no section stamped').toBeNull();
  });

  it('control: a readable IDENTICAL recheck lets the same finalize post', async () => {
    const f = await fixture('u13c');
    const p = await mustPlan(f, await imp(f, DAY));
    await recheck(f, DAY, { soldItems: AB });
    const out = await fin(f, p.pullId, directKeys(p));
    expect(out.ok, out.ok ? '' : out.reason).toBe(true);
    expect(await usageCount(f)).toBe(1);
  });
});
