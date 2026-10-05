import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S7 (DEF-578) - voiding a POS usage pull. `docs/tasks/374-money-push-follow-ups.md` section S7,
 * tests T1-T10 (T11 is `packages/db/tests/integration/t374-s7-pull-void-shape.test.ts`, T12 is the
 * web test in `apps/erp`).
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET behaviour (R7-R12, review changes R7 and R8),
 * and every refusal has a positive control (the same call, allowed, in the same file).
 *
 * ## How the target is read where the spec is silent (a question to the tester, not a test edit)
 *  - `voidPosUsagePull(tx, actor, { pullId, reason })` THROWS every refusal (a RefusalError carrying
 *    `userMessage`); it returns `{ ok: true, reversedRecordCount }` on success. Spec: "Returns
 *    { ok: true, reversedRecordCount } or throws."
 *  - `voidUsage` keeps its Outcome shape: R10's refusal arrives as `{ ok: false, reason }`. The helper
 *    `refusalText` also accepts a throw, so either reading passes.
 *  - R10's date is written "{d MMM YYYY}" with no formatter named; `humanDate` and "20 May 2026" both pass
 *    (the same latitude T-373 S1's T12 gave R7).
 *
 * ## Fixture
 * T-375 S5 (S5-lite): the store is LINKED to POS and each day is IMPORTED (`importTestDay`), so `buildPlan` /
 * `finalizeSections` read the stored `sold_items` feed; there is no injected snapshot and no live POS call.
 * `pos-usage-pull.test.ts` and
 * `t373-s1-voided-day-writers.test.ts` (fresh org per test, the gated two-connection harness).
 * Two meat items (5110 / 1310) in two operating rooms, so a finalized pull makes TWO usage records, one per room.
 * The sales day is in a past month (D); today's month is created beside it, so "the sales day's month"
 * and "today's month" can be closed independently.
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
import { toBusinessDate } from '@shareat/core/datetime';
import * as D from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import { closedStockPeriodSentence } from '../../src/stock/period-guard';
import { humanDate } from '../../src/shared/refusal-leaf';
import type { LocationLike } from '../../src/stock-locations/rules';

const sql = postgres(url, { max: 12 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// ---- concurrency harness (verbatim shape of t373-s1-voided-day-writers.test.ts) ---------------
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

// ---- fixture ------------------------------------------------------------------------------------
const STOCK_DAY = '2026-05-02';
const DAY = '2026-05-20'; // the sales day D, in a past month
const REASON = 'POS corrected two receipts';

async function fixture(hint: string) {
  const code = uid(`t374s7-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const today = toBusinessDate();
  const todayStart = `${today.slice(0, 7)}-01`;
  // Contiguous months from the sales day's month to today's month ("Periods close in order").
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series('2026-05-01'::date, ${todayStart}::date, interval '1 month') m`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Lipa', 'multi_room') returning id`;
  const storeId = store!.id;
  const mkPerson = async (name: string, role: string | null) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staffer', 'staff');
  const nobodyId = await mkPerson('Nobody', null);
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, wastage_type_mode)
    values (${orgId}, ${storeId}, 'Walk-in', true, 'tracked') returning id`;
  const walkIn = ch!.id;
  // T-375 S5: linked to POS, with the tenders D1's methods resolve to.
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId, channelId: walkIn, createdBy: managerId });
  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (c: string, name: string, isDefault: boolean) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${storeId}, ${c}, ${name}, ${type!.id}, 'operating', ${isDefault}, ${managerId}) returning id`)[0]!.id;
  const kitchen = await mkRoom('KIT', 'Kitchen', true);
  const display = await mkRoom('DISP', 'Display', false);
  const locations: LocationLike[] = [
    { id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
    { id: display, role: 'operating', purpose: 'normal', isDefault: false, status: 'active' },
  ];
  const mkItem = async (c: string, name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${c}, ${name}, 'meat_slab', 'kg', ${managerId}) returning id`)[0]!.id;
  const cheese = await mkItem('CHEESE', 'Cheese');
  const rice = await mkItem('RICE', 'Rice');

  const stockUp = async (itemId: string, locationId: string, qty: string, cost: string) => {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
      values (${orgId}, ${`orgs/${orgId}/p-${uid('f')}.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
    const [del] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgId}, ${storeId}, 'purchase', ${STOCK_DAY}, ${file!.id}, ${managerId}) returning id`;
    await asOrg(orgId, (tx) =>
      receiveDelivery(tx, {
        orgId, storeId, deliveryId: del!.id, deliveredOn: STOCK_DAY, locations, receivedBy: managerId,
        lines: [{ lineId: '1', itemId, itemKind: 'meat_slab', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId }],
      }),
    );
  };
  await stockUp(cheese, kitchen, '50', '10.0000');
  await stockUp(rice, display, '50', '8.0000');

  const manager = actor(orgId, managerId);
  await asOrg(orgId, async (tx) => {
    await D.upsertPosItemMap(tx, manager, { orgId, storeId, posItemKey: 'cheese', posItemName: 'Cheese', mode: 'direct', itemId: cheese, quantityPerSale: '1' });
    await D.upsertPosItemMap(tx, manager, { orgId, storeId, posItemKey: 'rice', posItemName: 'Rice', mode: 'direct', itemId: rice, quantityPerSale: '1', locationId: display });
  });
  return {
    orgId, storeId, walkIn, managerId, staffId, nobodyId, kitchen, display, cheese, rice, today,
    manager, staff: actor(orgId, staffId), nobody: actor(orgId, nobodyId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** cheese 4 (kitchen), rice 3 (display), plus an unmapped item so the orphan section is real. */
const SOLD = [
  { key: 'cheese', name: 'Cheese', physicalQty: 4 },
  { key: 'rice', name: 'Rice', physicalQty: 3 },
  { key: 'mystery', name: 'Mystery', physicalQty: 1 },
];

/** A day IMPORTED from POS (its `sold_items` feed is what the plan reads); was a typed `createSalesDay`. */
async function mkDay(f: Fixture, date: string, opts: { verify?: boolean } = {}): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date, soldItems: SOLD }));
  if (opts.verify) await asOrg(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, id));
  return id;
}
const plan = (f: Fixture, salesDayId: string, who: Actor = f.manager) =>
  asOrg(f.orgId, (tx) => D.buildPlan(tx, who, { orgId: f.orgId, storeId: f.storeId, salesDayId, locationId: f.kitchen }));
const finalize = (f: Fixture, pullId: string, keys: string[], sections: ('direct' | 'recipe' | 'orphan')[] = ['direct', 'recipe', 'orphan']) =>
  asOrg(f.orgId, (tx) => D.finalizeSections(tx, f.manager, { pullId, sections, confirmedKeys: keys }));

/** A pull on a fresh day. `all` finalizes every section (pull -> finalized); `direct` only the direct one (pull stays planned). */
async function pulled(f: Fixture, mode: 'none' | 'direct' | 'all', opts: { date?: string; verify?: boolean } = {}) {
  const dayId = await mkDay(f, opts.date ?? DAY, { verify: opts.verify });
  const built = await plan(f, dayId);
  if (!built.ok) throw new Error(`fixture: buildPlan refused: ${built.reason}`);
  const keys = built.lines.map((l) => l.key);
  if (mode !== 'none') {
    const out = await finalize(f, built.pullId, keys, mode === 'all' ? ['direct', 'recipe', 'orphan'] : ['direct']);
    if (!out.ok) throw new Error(`fixture: finalize refused: ${out.reason}`);
  }
  const records = (
    await sql<{ id: string }[]>`select distinct usage_record_id as id from pos_usage_pull_lines where pull_id = ${built.pullId} and usage_record_id is not null`
  ).map((r) => r.id);
  return { dayId, pullId: built.pullId, keys, records };
}

// `D.voidPosUsagePull` does not exist on HEAD; it is read through `any` so the file COMPILES and each leg
// fails at runtime with "voidPosUsagePull is not a function" - the real reason it is red.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const voidFn = (): ((tx: Tx, who: Actor, input: { pullId: string; reason: string }) => Promise<{ ok: true; reversedRecordCount: number }>) => {
  const fn = (D as any).voidPosUsagePull;
  if (typeof fn !== 'function') throw new Error('voidPosUsagePull is not exported from @shareat/domain (no function on HEAD)');
  return fn;
};
const voidPull = (f: Fixture, pullId: string, reason = REASON, who: Actor = f.manager) =>
  asOrg(f.orgId, (tx) => voidFn()(tx, who, { pullId, reason }));

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED - ${what} succeeded instead (the defect this leg targets)`);
}
/** The sentence a person would see, whether the function returned `{ ok: false }` or threw. */
async function refusalText(p: Promise<unknown>, what: string): Promise<string> {
  let value: unknown;
  try {
    value = await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return e.userMessage ?? String(e.message ?? err);
  }
  const v = value as { ok?: boolean; reason?: string };
  if (v && v.ok === false && typeof v.reason === 'string') return v.reason;
  throw new Error(`NOT REFUSED - ${what} succeeded instead (the defect this leg targets)`);
}

const num = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await q) as unknown as { n: string }[])[0]!.n);
const reversalEntries = (f: Fixture) =>
  num(sql`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'usage' and reversal_of_entry_id is not null`);
const reversalMoves = (f: Fixture) =>
  num(sql`select count(*)::text as n from stock_movements where org_id = ${f.orgId} and source_type = 'usage_void'`);
const onHand = async (itemId: string, loc: string): Promise<string> =>
  (await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and location_id = ${loc}`)[0]!.t;
// The audit columns do not exist on HEAD, so they are read with `select *` and picked in JS: a missing column is then
// an `undefined` the assertion reports, not a SQL error that hides which assertion was the first to fail.
const pullRow = async (id: string) => {
  const [r] = await sql<Record<string, unknown>[]>`select * from pos_usage_pulls where id = ${id}`;
  return r as { status: string; voided_at?: Date | null; voided_by?: string | null; void_reason?: string | null };
};
const recordRows = (ids: string[]) =>
  sql<{ id: string; status: string; voided_by: string | null; void_reason: string | null }[]>`
    select id, status, voided_by, void_reason from stock_usage_records where id = any(${ids}::uuid[]) order by id`;
const usageRecordCount = (f: Fixture) => num(sql`select count(*)::text as n from stock_usage_records where org_id = ${f.orgId}`);
/** Closes every month up to and including the one holding `date`, oldest first (periods close in order). */
async function closePeriodOf(f: Fixture, date: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${date}::date and status = 'open' order by starts_on`;
  for (const r of rows) await sql`update fiscal_periods set status = 'closed' where id = ${r.id}`;
}

// -----------------------------------------------------------------------------------------------
// T1 - the happy path: all of it, dated on the sales day, who/when/why recorded
// -----------------------------------------------------------------------------------------------
describe('T1 - void a finalized pull on an open-month day', () => {
  it('pull void with who/when/why; every record void; stock back; COGS reversed ON THE SALES DAY; 1310 and 5110 net zero', async () => {
    const f = await fixture('t1');
    const p = await pulled(f, 'all');
    expect(p.records).toHaveLength(2); // one per room: the control that the fixture really made two records
    expect((await pullRow(p.pullId)).status).toBe('finalized');
    expect(await onHand(f.cheese, f.kitchen)).toBe('46.000');
    expect(await onHand(f.rice, f.display)).toBe('47.000');
    const [pre] = await sql<{ n: string }[]>`
      select coalesce(sum(l.debit - l.credit),0)::text as n from journal_lines l join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id where e.org_id = ${f.orgId} and e.source_type = 'usage' and e.entry_date = ${DAY} and a.code = '5110'`;
    expect(Number(pre!.n), 'control: before the void the day carries cost in 5110').toBeGreaterThan(0);

    const before = Date.now();
    const out = await voidPull(f, p.pullId);
    expect(out).toMatchObject({ ok: true, reversedRecordCount: 2 });

    const row = await pullRow(p.pullId);
    expect(row.status).toBe('void');
    expect(row.voided_by).toBe(f.managerId);
    expect(row.void_reason).toBe(REASON);
    expect(row.voided_at, 'voided_at is recorded').toBeInstanceOf(Date);
    expect(row.voided_at!.getTime()).toBeGreaterThanOrEqual(before - 60_000);

    for (const r of await recordRows(p.records)) {
      expect(r.status).toBe('void');
      expect(r.voided_by).toBe(f.managerId);
      expect(r.void_reason).toBe(REASON);
    }
    expect(await onHand(f.cheese, f.kitchen)).toBe('50.000');
    expect(await onHand(f.rice, f.display)).toBe('50.000');

    // Each COGS entry is reversed, and its reversal is dated the SALES DAY (R12), not today.
    for (const rid of p.records) {
      const originals = await sql<{ id: string; status: string }[]>`
        select id, status from journal_entries where org_id = ${f.orgId} and source_type = 'usage' and source_id like ${rid + ':%'} and reversal_of_entry_id is null`;
      expect(originals.length).toBeGreaterThan(0);
      for (const o of originals) {
        expect(o.status).toBe('reversed');
        const [rev] = await sql<{ entry_date: string; memo: string }[]>`
          select to_char(entry_date,'YYYY-MM-DD') as entry_date, memo from journal_entries where reversal_of_entry_id = ${o.id}`;
        expect(rev!.entry_date, 'the reversal is dated the sales day').toBe(DAY);
        expect(rev!.memo).not.toMatch(/prior period/);
      }
    }
    for (const code of ['1310', '5110']) {
      const [net] = await sql<{ n: string }[]>`
        select coalesce(sum(l.debit - l.credit),0)::text as n from journal_lines l join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id where e.org_id = ${f.orgId} and e.source_type = 'usage' and e.entry_date = ${DAY} and a.code = ${code}`;
      expect(Number(net!.n), `${code} nets to zero for the sales day`).toBe(0);
    }
    // The stock movements are dated the sales day too.
    const moves = await sql<{ d: string }[]>`
      select to_char(moved_at at time zone 'UTC','YYYY-MM-DD') as d from stock_movements where org_id = ${f.orgId} and source_type = 'usage_void'`;
    expect(moves).toHaveLength(2);
    for (const m of moves) expect(m.d).toBe(DAY);
  });

  it('a manager is allowed (Q1 default a: the people who may void a usage record)', async () => {
    const f = await fixture('t1q');
    const p = await pulled(f, 'all');
    expect((await voidPull(f, p.pullId, REASON, f.manager)).ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T2 - R12 fallback: the sales day's stock month is closed, today's is open
// -----------------------------------------------------------------------------------------------
describe("T2 - the sales day's month is closed, today's is open", () => {
  it('the reversal is dated TODAY and tagged [prior period]; movements dated today; records and pull void', async () => {
    const f = await fixture('t2');
    const p = await pulled(f, 'all');
    await closePeriodOf(f, DAY);

    const out = await voidPull(f, p.pullId);
    expect(out).toMatchObject({ ok: true, reversedRecordCount: 2 });
    expect((await pullRow(p.pullId)).status).toBe('void');

    const revs = await sql<{ entry_date: string; memo: string }[]>`
      select to_char(entry_date,'YYYY-MM-DD') as entry_date, memo from journal_entries
      where org_id = ${f.orgId} and source_type = 'usage' and reversal_of_entry_id is not null`;
    expect(revs.length).toBeGreaterThan(0);
    for (const r of revs) {
      expect(r.entry_date).toBe(f.today);
      expect(r.memo.startsWith('[prior period] ')).toBe(true);
    }
    const moves = await sql<{ d: string }[]>`
      select to_char(moved_at at time zone 'UTC','YYYY-MM-DD') as d from stock_movements where org_id = ${f.orgId} and source_type = 'usage_void'`;
    expect(moves).toHaveLength(2);
    for (const m of moves) expect(m.d).toBe(f.today);
    expect(await onHand(f.cheese, f.kitchen)).toBe('50.000');
  });
});

// -----------------------------------------------------------------------------------------------
// T3 - both months closed: the closed-month sentence for TODAY, nothing written
// -----------------------------------------------------------------------------------------------
describe('T3 - the sales day month and today month are both closed', () => {
  it("refused with the closed-month sentence for today's date (no uuid); pull still finalized, records posted, zero reversals", async () => {
    const f = await fixture('t3');
    const p = await pulled(f, 'all');
    await closePeriodOf(f, DAY);
    await closePeriodOf(f, f.today);

    const r = await rejection(voidPull(f, p.pullId), 'a void with both months closed');
    const expected = await asOrg(f.orgId, (tx) => closedStockPeriodSentence(tx, f.orgId, f.today, 'voided'));
    expect(expected).not.toBeNull();
    expect(r.userMessage).toBe(expected);
    expect(r.userMessage).toContain(humanDate(f.today as never));
    expect(r.userMessage).not.toMatch(UUID);

    expect((await pullRow(p.pullId)).status).toBe('finalized');
    expect((await recordRows(p.records)).every((x) => x.status === 'posted')).toBe(true);
    expect(await reversalEntries(f)).toBe(0);
    expect(await reversalMoves(f)).toBe(0);
  });

  it('control: with only the sales day month closed (today open) the same call succeeds', async () => {
    const f = await fixture('t3c');
    const p = await pulled(f, 'all');
    await closePeriodOf(f, DAY);
    expect((await voidPull(f, p.pullId)).ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T3b (review change R7) - the ALL-OR-NONE leg: a refusal on the SECOND record unwinds the first
// -----------------------------------------------------------------------------------------------
describe('T3b - a room frozen by an open count refuses one record; the whole void unwinds', () => {
  /**
   * `stock_movements_check_not_frozen_trg` (migration 0068, 0123) raises for ANY insert into a room held by an
   * open/counting/reviewing count session, bar a count_adjustment of that session's own: confirmed at source.
   * The reversal movement is an insert, so it is refused in the frozen room. `reverseConsumption` always inserts
   * one, so the refusal is the DB's, thrown, and only for the record in that room.
   *
   * The repo's record order is not the tester's to set. Two legs freeze each room in turn: in one of them the
   * frozen room is necessarily the SECOND record, so the first has already been reversed in the transaction when
   * the throw comes. Both legs must leave NOTHING behind.
   */
  it.each([['kitchen'], ['display']] as const)('freeze the %s: throws; pull finalized, BOTH records posted, zero reversals, on_hand unchanged', async (frozen) => {
    const f = await fixture(`t3b-${frozen}`);
    const p = await pulled(f, 'all');
    expect(p.records).toHaveLength(2);
    const room = frozen === 'kitchen' ? f.kitchen : f.display;
    const [s] = await sql<{ id: string }[]>`
      insert into count_sessions (org_id, store_id, status, counted_on, opened_by)
      values (${f.orgId}, ${f.storeId}, 'open', '2026-08-20', ${f.managerId}) returning id`;
    await sql`insert into count_session_locations (session_id, location_id) values (${s!.id}, ${room})`;

    const r = await rejection(voidPull(f, p.pullId), 'a void with one record in a frozen room');
    expect(r.message).toMatch(/frozen/i);

    expect((await pullRow(p.pullId)).status, 'the pull must NOT be marked void').toBe('finalized');
    expect((await recordRows(p.records)).map((x) => x.status)).toEqual(['posted', 'posted']);
    expect(await reversalEntries(f)).toBe(0);
    expect(await reversalMoves(f)).toBe(0);
    expect(await onHand(f.cheese, f.kitchen)).toBe('46.000');
    expect(await onHand(f.rice, f.display)).toBe('47.000');
  });

  it('control: nothing frozen, the same pull voids both records', async () => {
    const f = await fixture('t3bc');
    const p = await pulled(f, 'all');
    expect(await voidPull(f, p.pullId)).toMatchObject({ ok: true, reversedRecordCount: 2 });
  });
});

// -----------------------------------------------------------------------------------------------
// T4 / T5 - planned pull, partly finalized pull
// -----------------------------------------------------------------------------------------------
describe('T4 - a planned pull', () => {
  it('voids with zero reversals; status void with who/why', async () => {
    const f = await fixture('t4');
    const p = await pulled(f, 'none');
    expect(p.records).toHaveLength(0);
    const out = await voidPull(f, p.pullId);
    expect(out).toMatchObject({ ok: true, reversedRecordCount: 0 });
    const row = await pullRow(p.pullId);
    expect(row).toMatchObject({ status: 'void', voided_by: f.managerId, void_reason: REASON });
    expect(await reversalEntries(f)).toBe(0);
    expect(await reversalMoves(f)).toBe(0);
  });
});

describe('T5 - a partly finalized pull (direct only)', () => {
  it('reverses its direct records and voids the pull', async () => {
    const f = await fixture('t5');
    const p = await pulled(f, 'direct');
    expect(p.records).toHaveLength(2);
    expect((await pullRow(p.pullId)).status, 'control: still planned, one section finalized').toBe('planned');
    const out = await voidPull(f, p.pullId);
    expect(out).toMatchObject({ ok: true, reversedRecordCount: 2 });
    expect((await pullRow(p.pullId)).status).toBe('void');
    expect((await recordRows(p.records)).every((x) => x.status === 'void')).toBe(true);
    expect(await onHand(f.cheese, f.kitchen)).toBe('50.000');
  });
});

// -----------------------------------------------------------------------------------------------
// T6 - refusals in sentences
// -----------------------------------------------------------------------------------------------
describe('T6 - second void, blank reason', () => {
  it('a second void -> "already voided"; nothing further written; no uuid', async () => {
    const f = await fixture('t6a');
    const p = await pulled(f, 'all');
    expect((await voidPull(f, p.pullId)).ok).toBe(true); // control: the first void works
    const reversals = await reversalEntries(f);
    const r = await rejection(voidPull(f, p.pullId, 'again'), 'a second void');
    expect(r.userMessage).toBe('This POS usage pull was already voided.');
    expect(r.userMessage).not.toMatch(UUID);
    expect(await reversalEntries(f)).toBe(reversals);
    expect((await pullRow(p.pullId)).void_reason, 'the first reason is not overwritten').toBe(REASON);
  });

  it.each([[''], ['   ']])('a blank reason (%j) -> its sentence; the pull is untouched', async (reason) => {
    const f = await fixture('t6b');
    const p = await pulled(f, 'all');
    const r = await rejection(voidPull(f, p.pullId, reason), 'a void with no reason');
    expect(r.userMessage).toBe('Say why this pull is being voided.');
    expect(r.userMessage).not.toMatch(UUID);
    expect((await pullRow(p.pullId)).status).toBe('finalized');
    expect(await reversalEntries(f)).toBe(0);
    // control: with a reason the same pull voids
    expect((await voidPull(f, p.pullId)).ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T7 - authorize first (T-364 order)
// -----------------------------------------------------------------------------------------------
describe('T7 - void_usage_record is checked first', () => {
  it.each([['nobody'], ['staff']] as const)('%s -> AuthorizationError on a live pull; nothing written', async (who) => {
    const f = await fixture(`t7-${who}`);
    const p = await pulled(f, 'all');
    const r = await rejection(voidPull(f, p.pullId, REASON, who === 'nobody' ? f.nobody : f.staff), 'an unauthorised void');
    expect(r.err).toBeInstanceOf(AuthorizationError);
    expect((await pullRow(p.pullId)).status).toBe('finalized');
    expect(await reversalEntries(f)).toBe(0);
  });

  it('AuthorizationError even on an already-void pull and with a blank reason (not the business sentences)', async () => {
    const f = await fixture('t7b');
    const p = await pulled(f, 'all');
    expect((await voidPull(f, p.pullId)).ok).toBe(true);
    const a = await rejection(voidPull(f, p.pullId, REASON, f.nobody), 'an unauthorised void of a void pull');
    expect(a.err).toBeInstanceOf(AuthorizationError);
    expect(a.userMessage ?? a.message).not.toContain('already voided');
    const b = await rejection(voidPull(f, p.pullId, '', f.nobody), 'an unauthorised blank-reason void');
    expect(b.err).toBeInstanceOf(AuthorizationError);
    expect(b.userMessage ?? b.message).not.toContain('Say why');
  });
});

// -----------------------------------------------------------------------------------------------
// T8 - R10: a pull-made record cannot be voided on its own
// -----------------------------------------------------------------------------------------------
describe('T8 - voidUsage on a pull-made record', () => {
  const r10 = [
    `This usage came from the POS pull for ${humanDate(DAY as never)}. Void the pull instead, so the day can be pulled again.`,
    'This usage came from the POS pull for 20 May 2026. Void the pull instead, so the day can be pulled again.',
  ];

  it('refused with R10 sentence; nothing reversed; the record stays posted', async () => {
    const f = await fixture('t8');
    const p = await pulled(f, 'all');
    const text = await refusalText(
      asOrg(f.orgId, (tx) => D.voidUsage(tx, f.manager, { recordId: p.records[0]!, reason: 'wrong' })),
      'voiding a pull-made usage record on its own',
    );
    expect(r10).toContain(text);
    expect(text).not.toMatch(UUID);
    expect((await recordRows(p.records)).every((x) => x.status === 'posted')).toBe(true);
    expect(await reversalEntries(f)).toBe(0);
    expect(await reversalMoves(f)).toBe(0);
  });

  it("a PARTLY finalized pull's record (pull still 'planned', i.e. not void) is refused too", async () => {
    const f = await fixture('t8p');
    const p = await pulled(f, 'direct');
    const text = await refusalText(
      asOrg(f.orgId, (tx) => D.voidUsage(tx, f.manager, { recordId: p.records[0]!, reason: 'wrong' })),
      "voiding a partly-finalized pull's record on its own",
    );
    expect(r10).toContain(text);
  });

  it('control: a hand-entered usage record still voids', async () => {
    const f = await fixture('t8c');
    const id = await asOrg(f.orgId, async (tx) => {
      const d = await D.saveUsageDraft(tx, f.manager, {
        orgId: f.orgId, storeId: f.storeId, locationId: f.kitchen, kind: 'usage', usedOn: STOCK_DAY,
        lines: [{ itemId: f.cheese, quantity: '2' }],
      });
      if (!d.ok) throw new Error(d.reason);
      const posted = await D.postUsage(tx, f.manager, { recordId: d.recordId });
      if (!posted.ok) throw new Error(posted.reason);
      return d.recordId;
    });
    const out = await asOrg(f.orgId, (tx) => D.voidUsage(tx, f.manager, { recordId: id, reason: 'typed twice' }));
    expect(out.ok).toBe(true);
    expect((await recordRows([id]))[0]!.status).toBe('void');
  });

  it('R10 comes AFTER authorize: a person without the capability gets AuthorizationError, not the sentence', async () => {
    const f = await fixture('t8a');
    const p = await pulled(f, 'all');
    const r = await rejection(
      asOrg(f.orgId, (tx) => D.voidUsage(tx, f.nobody, { recordId: p.records[0]!, reason: 'wrong' })),
      'an unauthorised voidUsage on a pull-made record',
    );
    expect(r.err).toBeInstanceOf(AuthorizationError);
  });

  it("after the pull is voided the record is void and the existing 'not posted' refusal applies (R10 no longer fires)", async () => {
    const f = await fixture('t8v');
    const p = await pulled(f, 'all');
    expect((await voidPull(f, p.pullId)).ok).toBe(true);
    expect((await recordRows(p.records)).every((x) => x.status === 'void')).toBe(true);
    const text = await refusalText(
      asOrg(f.orgId, (tx) => D.voidUsage(tx, f.manager, { recordId: p.records[0]!, reason: 'again' })),
      'voiding a record the pull already voided',
    );
    expect(text).toMatch(/not posted/);
    expect(text).not.toMatch(/Void the pull instead/);
  });
});

// -----------------------------------------------------------------------------------------------
// T9 - R11: the paths that were dead
// -----------------------------------------------------------------------------------------------
describe('T9 - a voided pull frees its day', () => {
  it('leg 1: an UNVERIFIED day with a pull cannot be withdrawn (new sentence) -> void the pull -> withdraw succeeds', async () => {
    const f = await fixture('t9a');
    const p = await pulled(f, 'all'); // unverified day
    const blocked = await rejection(
      asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, p.dayId, 'Entered wrong')),
      'withdrawing a day that has a live pull',
    );
    expect(blocked.userMessage).toBe('This day has a POS usage pull. Void it first under Inventory › POS usage.');
    expect(blocked.userMessage).not.toMatch(UUID);
    const [still] = await sql<{ status: string }[]>`select status from sales_days where id = ${p.dayId}`;
    expect(still!.status, 'the day was not withdrawn').toBe('open');

    expect((await voidPull(f, p.pullId)).ok).toBe(true);
    await asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, p.dayId, 'Entered wrong'));
    const [after] = await sql<{ status: string }[]>`select status from sales_days where id = ${p.dayId}`;
    expect(after!.status).toBe('voided');
  });

  it('control: a day with NO pull is withdrawn without any of this', async () => {
    const f = await fixture('t9c');
    const dayId = await mkDay(f, DAY);
    await asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, dayId, 'Entered wrong'));
    const [r] = await sql<{ status: string }[]>`select status from sales_days where id = ${dayId}`;
    expect(r!.status).toBe('voided');
  });

  it("leg 2 (T-373 T12's shape): verified D1 with a finalized pull, D1 voided, replacement D2 same date -> refused -> void D1's pull -> builds", async () => {
    const f = await fixture('t9b');
    const p = await pulled(f, 'all', { verify: true });
    await asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, p.dayId, 'Entered wrong'));
    const d2 = await mkDay(f, DAY); // the same business date, freed by the day void

    const refused = await plan(f, d2);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/^Stock usage for .+ was already pulled against the voided day, so pulling it again would count it twice\.$/);

    expect((await voidPull(f, p.pullId)).ok).toBe(true); // the pull's own day is voided: the void must still work
    const built = await plan(f, d2);
    expect(built.ok, built.ok ? '' : built.reason).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T10 - R9: the void and a finalize serialize on the pull row
// -----------------------------------------------------------------------------------------------
describe('T10 - A voids the pull (uncommitted), B finalizes the same pull', () => {
  it('B waits on the pull row, then is refused "this pull has been voided"; zero usage records', async () => {
    const f = await fixture('t10');
    const p = await pulled(f, 'none');
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => voidFn()(tx, f.manager, { pullId: p.pullId, reason: REASON }),
      (tx) => D.finalizeSections(tx, f.manager, { pullId: p.pullId, sections: ['direct'], confirmedKeys: p.keys }),
      ROW_LOCK,
    );
    expect(aResult.status, aResult.status === 'rejected' ? String((aResult.reason as Error).message) : '').toBe('fulfilled');
    expect(bWaited, 'harness gate: B must have waited behind the void (finalize takes the same pull lock)').toBe(true);
    expect(bResult.status, 'finalizeSections returns an Outcome, it does not throw').toBe('fulfilled');
    const out = (bResult as { value: D.FinalizeResult }).value;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('this pull has been voided');
    expect(await usageRecordCount(f)).toBe(0);
    expect((await pullRow(p.pullId)).status).toBe('void');
    expect(await onHand(f.cheese, f.kitchen)).toBe('50.000');
  });

  it('control: with no void in flight the same finalize posts', async () => {
    const f = await fixture('t10c');
    const p = await pulled(f, 'none');
    const out = await finalize(f, p.pullId, p.keys, ['direct']);
    expect(out.ok).toBe(true);
    expect(await usageRecordCount(f)).toBe(2);
  });
});

// -----------------------------------------------------------------------------------------------
// T13 - audit 1: Refresh must not wipe the pull -> usage-record links a void relies on
// -----------------------------------------------------------------------------------------------
describe('T13 - Refresh after a section is finalized', () => {
  it('a refresh rewrites only unfinalized sections; the direct links survive; the void then reverses every direct record (net zero)', async () => {
    const f = await fixture('t13');
    const p = await pulled(f, 'direct');
    expect(p.records, 'control: the direct section made one record per room').toHaveLength(2);
    const directLines = () =>
      sql`select id, line_key, usage_record_id from pos_usage_pull_lines where pull_id = ${p.pullId} and section = 'direct' order by id`;
    const before = await directLines();

    const again = await plan(f, p.dayId);
    expect(again.ok, 'a partly finalized pull can be refreshed').toBe(true);
    expect(await directLines(), 'direct lines and their links are untouched').toEqual(before);

    const out = await voidPull(f, p.pullId);
    expect(out).toMatchObject({ ok: true, reversedRecordCount: 2 });
    expect((await recordRows(p.records)).every((x) => x.status === 'void')).toBe(true);
    expect(await onHand(f.cheese, f.kitchen)).toBe('50.000');
    expect(await onHand(f.rice, f.display)).toBe('50.000');
  });

  it('finalize Direct -> an hour passes -> Recipe is stale -> rebuild refreshes only Recipe -> finalize Recipe works -> void reverses both', async () => {
    const f = await fixture('t13s');
    const p = await pulled(f, 'direct');
    const directBefore = await sql`select id, line_key, usage_record_id from pos_usage_pull_lines where pull_id = ${p.pullId} and section = 'direct' order by id`;
    await sql`update pos_usage_pulls set snapshot_taken_at = now() - interval '2 hours' where id = ${p.pullId}`;
    const stale = await finalize(f, p.pullId, p.keys, ['recipe']);
    expect(stale.ok).toBe(false);
    expect(JSON.stringify(stale)).toContain('SNAPSHOT_STALE');

    const rebuilt = await plan(f, p.dayId);
    expect(rebuilt.ok, 'the rest of a partly finalized pull can be rebuilt').toBe(true);
    const [row] = await sql<{ fresh: boolean }[]>`select snapshot_taken_at > now() - interval '5 minutes' as fresh from pos_usage_pulls where id = ${p.pullId}`;
    expect(row!.fresh).toBe(true);
    expect(await sql`select id, line_key, usage_record_id from pos_usage_pull_lines where pull_id = ${p.pullId} and section = 'direct' order by id`).toEqual(directBefore);

    const fin = await finalize(f, p.pullId, p.keys, ['recipe']);
    expect(fin.ok).toBe(true);
    const out = await voidPull(f, p.pullId);
    expect(out).toMatchObject({ ok: true, reversedRecordCount: 2 });
    expect(await onHand(f.cheese, f.kitchen)).toBe('50.000');
  });

  it('control: a still-unfinalized plan can be refreshed', async () => {
    const f = await fixture('t13c');
    const p = await pulled(f, 'none');
    const again = await plan(f, p.dayId);
    expect(again.ok).toBe(true);
  });
});
