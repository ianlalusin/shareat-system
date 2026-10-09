import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-373 S1 (DEF-552) - nothing is recorded against a voided sales day.
 * `docs/tasks/373-money-follow-ups.md` section S1, tests T1-T10 and T12 (T11, the picker, is
 * `apps/erp/tests/integration/t373-s1-pos-usage-picker.test.ts`).
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET behaviour (R1-R3, R7). Every refusal has a
 * positive control (the same call on a live day still works).
 *
 * Fixtures: `order-wastage.test.ts` (a fresh org per test, Foodpanda channel) and
 * `pos-usage-pull.test.ts` (injected `fetchSnapshot`, never the live POS). The two-connection gated
 * harness is `t369-s3-sales-day-edit-void.test.ts` T10's, never a bare `Promise.all` race.
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
import * as D from '@shareat/domain';
import { recordOrderWastage } from '../../src/wastage/orders';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import { mkSubmitter, submitThenVerify } from './_fixtures/sales-day-flow';
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

// -----------------------------------------------------------------------------------------------
// Concurrency harness (shape from t369-s3-sales-day-edit-void.test.ts / t366-s1)
// -----------------------------------------------------------------------------------------------
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
async function pollForWaitingBackend(
  bPid: Promise<number>,
  waitEvents: string[],
  settleWatch: Promise<unknown>,
  timeoutMs = 5000,
): Promise<{ pid: number; query: string } | null> {
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

// -----------------------------------------------------------------------------------------------
// Fixture: Lipa (Walk-in remitted, Foodpanda 1220 tracked), a second store with its own day,
// a manager and an admin-less "nobody" (no role), a kitchen with Coke stock, Jan-Mar 2027 open.
// -----------------------------------------------------------------------------------------------
const STOCK_DAY = '2027-01-15';
const D1 = '2027-02-10';
const D2 = '2027-02-11';

async function fixture(hint: string, opts: { instant?: boolean } = {}) {
  const code = uid(`t373s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
    (${orgId}, '2027-01-01', '2027-01-31', 'open'),
    (${orgId}, '2027-02-01', '2027-02-28', 'open'),
    (${orgId}, '2027-03-01', '2027-03-31', 'open')`;
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(h)}, ${`Store ${h}`}, 'multi_room') returning id`)[0]!.id;
  const storeId = await mkStore(`${hint}-lipa`);
  const storeId2 = await mkStore(`${hint}-malvar`);
  const mkPerson = async (name: string, role: string | null) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mkPerson('Manager', 'manager');
  const nobodyId = await mkPerson('Nobody', null);
  const mkChannel = async (name: string, remitted: boolean, receivable: string | null, mode: string) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, wastage_type_mode)
      values (${orgId}, ${storeId}, ${name}, ${remitted}, ${receivable}, ${mode}) returning id`)[0]!.id;
  const walkIn = await mkChannel('Walk-in', true, null, 'tracked');
  const foodpanda = await mkChannel('Foodpanda', false, '1220', opts.instant ? 'instant' : 'tracked');

  // Stock: one kitchen, Coke on hand from STOCK_DAY.
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [kit] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${managerId}) returning id`;
  const kitchen = kit!.id;
  const [coke] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, 'COKE', 'Coke', 'retail', 'pcs', ${managerId}) returning id`;
  const itemCoke = coke!.id;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${`orgs/${orgId}/p-${uid('f')}.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
  const [del] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgId}, ${storeId}, 'purchase', ${STOCK_DAY}, ${file!.id}, ${managerId}) returning id`;
  const locations: LocationLike[] = [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];
  await asOrg(orgId, (tx) =>
    receiveDelivery(tx, {
      orgId, storeId, deliveryId: del!.id, deliveredOn: STOCK_DAY, locations, receivedBy: managerId,
      lines: [{ lineId: '1', itemId: itemCoke, itemKind: 'retail', receivedQuantity: quantity('50'), conversionFactor: '1', unitCost: '10.0000', locationId: kitchen }],
    }),
  );
  const manager = actor(orgId, managerId);
  await asOrg(orgId, (tx) =>
    D.upsertPosItemMap(tx, manager, { orgId, storeId, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1' }),
  );

  // T-375 S5 (S5-lite): the USAGE legs run on a second store LINKED to POS, whose days are imported (usage reads the
  // stored sold items). The typed store above keeps the wastage, withdraw and race legs exactly as they were.
  const storeL = await mkStore(`${hint}-linked`);
  for (const pid of [managerId, nobodyId]) await sql`insert into person_store_scope (person_id, store_id) values (${pid}, ${storeL})`;
  const [chL] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, wastage_type_mode)
    values (${orgId}, ${storeL}, 'Walk-in', true, 'tracked') returning id`;
  const [gcashL] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeL}, 'GCash - linked', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId: storeL, channelId: chL!.id, createdBy: managerId });
  await seedTestTenders(sql, { orgId, storeId: storeL, walletAccountId: gcashL!.id });
  const [kitL] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeL}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${managerId}) returning id`;
  const kitchenL = kitL!.id;
  const [fileL] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${`orgs/${orgId}/p-${uid('f')}.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
  const [delL] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgId}, ${storeL}, 'purchase', ${STOCK_DAY}, ${fileL!.id}, ${managerId}) returning id`;
  await asOrg(orgId, (tx) =>
    receiveDelivery(tx, {
      orgId, storeId: storeL, deliveryId: delL!.id, deliveredOn: STOCK_DAY, receivedBy: managerId,
      locations: [{ id: kitchenL, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      lines: [{ lineId: '1', itemId: itemCoke, itemKind: 'retail', receivedQuantity: quantity('50'), conversionFactor: '1', unitCost: '10.0000', locationId: kitchenL }],
    }),
  );
  await asOrg(orgId, (tx) =>
    D.upsertPosItemMap(tx, manager, { orgId, storeId: storeL, posItemKey: 'coke', posItemName: 'Coke', mode: 'direct', itemId: itemCoke, quantityPerSale: '1' }),
  );
  const submitter = await mkSubmitter(sql, orgId, [storeId, storeL, storeId2]);
  return { orgId, storeId, storeL, kitchenL, storeId2, walkIn, foodpanda, managerId, nobodyId, kitchen, itemCoke, manager, submitter, nobody: actor(orgId, nobodyId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A day IMPORTED on the linked store; its stored sold items (coke 4) are what the usage plan reads. */
async function mkUsageDay(f: Fixture, date: string, opts: { verify?: boolean; orphan?: boolean } = {}): Promise<string> {
  const soldItems = [{ key: 'coke', name: 'Coke', physicalQty: 4 }, ...(opts.orphan ? [{ key: 'mystery', name: 'Mystery', physicalQty: 1 }] : [])];
  const { id } = await asOrg(f.orgId, (tx) =>
    importTestDay(tx, f.manager, { storeId: f.storeL, businessDate: date, soldItems }),
  );
  if (opts.verify) await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, id, f.submitter));
  return id;
}

async function mkDay(f: Fixture, date: string, opts: { verify?: boolean } = {}): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    D.createSalesDay(tx, f.manager, {
      storeId: f.storeId, businessDate: date, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00',
      cashCollected: '1000.00', channels: [{ channelId: f.walkIn, amount: '1000.00' }],
    }),
  );
  if (opts.verify) await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, id, f.submitter));
  return id;
}
const voidDay = (f: Fixture, id: string, reason = 'Entered wrong') => asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, id, reason));

const wastageInput = (f: Fixture, salesDayId: string, extra: Record<string, unknown> = {}) => ({
  storeId: f.storeId, salesDayId, channel: 'Foodpanda', amount: '100.00', reason: 'remade order', openedOn: D1, ...extra,
});
const wastageOp = (f: Fixture, who: Actor, salesDayId: string, extra: Record<string, unknown> = {}) => (tx: Tx) =>
  recordOrderWastage(tx, who, wastageInput(f, salesDayId, extra) as Parameters<typeof recordOrderWastage>[2]);
const wastage = (f: Fixture, salesDayId: string, extra: Record<string, unknown> = {}, who: Actor = f.manager) =>
  asOrg(f.orgId, wastageOp(f, who, salesDayId, extra));
const instant = { disposition: 'absorbed' };

const plan = (f: Fixture, salesDayId: string, who: Actor = f.manager) =>
  asOrg(f.orgId, (tx) => D.buildPlan(tx, who, { orgId: f.orgId, storeId: f.storeL, salesDayId, locationId: f.kitchenL }));
const finalize = (f: Fixture, pullId: string, keys: string[]) =>
  asOrg(f.orgId, (tx) => D.finalizeSections(tx, f.manager, { pullId, sections: ['direct'], confirmedKeys: keys }));

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED - ${what} succeeded instead (the defect this leg targets)`);
}

const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await q) as unknown as { n: string }[])[0]!.n);
const wastageRows = (f: Fixture) => count(sql`select count(*)::text as n from order_wastages where org_id = ${f.orgId}`);
const pullRows = (f: Fixture) => count(sql`select count(*)::text as n from pos_usage_pulls where org_id = ${f.orgId}`);
const entryRows = (f: Fixture) => count(sql`select count(*)::text as n from journal_entries where org_id = ${f.orgId}`);
const wastageEntryRows = (f: Fixture) => count(sql`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'order_wastage'`);
const usageRows = (f: Fixture) => count(sql`select count(*)::text as n from stock_usage_records where org_id = ${f.orgId}`);
const moveRows = (f: Fixture) => count(sql`select count(*)::text as n from stock_movements where org_id = ${f.orgId}`);

const voidedSentence = (date: string, doing: string) => `The sales day for ${humanDate(date as never)} has been voided, so ${doing} can't be recorded against it.`;

// -----------------------------------------------------------------------------------------------
// T1 - wastage on a withdrawn (unverified) day
// -----------------------------------------------------------------------------------------------
describe('T1 - wastage on a withdrawn day', () => {
  it('refused with the voided sentence (date, no uuid); zero wastage rows, zero entries', async () => {
    const f = await fixture('t1');
    const id = await mkDay(f, D1);
    await voidDay(f, id);
    const entriesBefore = await entryRows(f);

    const r = await rejection(wastage(f, id), 'recording wastage against a withdrawn day');
    expect(r.userMessage).toBe(voidedSentence(D1, 'wastage'));
    expect(r.userMessage).not.toMatch(UUID);
    expect(await wastageRows(f)).toBe(0);
    expect(await entryRows(f)).toBe(entriesBefore);
  });

  it('control: the same call on an open day records', async () => {
    const f = await fixture('t1c');
    const id = await mkDay(f, D1);
    const rec = await wastage(f, id);
    expect(rec.id).toBeTruthy();
    expect(await wastageRows(f)).toBe(1);
  });
});

// -----------------------------------------------------------------------------------------------
// T2 - wastage on a voided VERIFIED day, instant absorbed channel (this one posts money)
// -----------------------------------------------------------------------------------------------
describe('T2 - wastage on a voided verified day, instant channel', () => {
  it('control: before the void it posts; after the void it is refused and posts nothing', async () => {
    const f = await fixture('t2', { instant: true });
    const id = await mkDay(f, D1, { verify: true });

    const before = await wastage(f, id, instant);
    expect(before.journalEntryId, 'control: an instant absorbed wastage on a live day must post').toBeTruthy();
    expect(await wastageEntryRows(f)).toBe(1);

    await voidDay(f, id);
    const rows = await wastageRows(f);
    const entries = await wastageEntryRows(f);

    const r = await rejection(wastage(f, id, instant), 'an instant wastage against a voided verified day');
    expect(r.userMessage).toBe(voidedSentence(D1, 'wastage'));
    expect(await wastageRows(f)).toBe(rows);
    expect(await wastageEntryRows(f)).toBe(entries);
  });
});

// -----------------------------------------------------------------------------------------------
// T3 - another store's day
// -----------------------------------------------------------------------------------------------
describe("T3 - another store's day", () => {
  it('refused "That sales day belongs to another store."; nothing written', async () => {
    const f = await fixture('t3');
    const [other] = await sql<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.storeId2}, ${D1}, 0, 0, 0, ${f.managerId}) returning id`;
    const r = await rejection(wastage(f, other!.id), "wastage against another store's day");
    expect(r.userMessage).toBe('That sales day belongs to another store.');
    expect(await wastageRows(f)).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// T4 - buildPlan on a withdrawn day
// -----------------------------------------------------------------------------------------------
describe('T4 - buildPlan on a withdrawn day', () => {
  it('returns { ok: false } with the voided sentence ("usage"); zero pulls', async () => {
    const f = await fixture('t4');
    const id = await mkUsageDay(f, D1);
    await voidDay(f, id);
    const out = await plan(f, id);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(voidedSentence(D1, 'usage'));
    expect(out.reason).not.toMatch(UUID);
    expect(await pullRows(f)).toBe(0);
  });

  it('control: an open day builds', async () => {
    const f = await fixture('t4c');
    const id = await mkUsageDay(f, D1);
    const out = await plan(f, id);
    expect(out.ok).toBe(true);
    expect(await pullRows(f)).toBe(1);
  });
});

// -----------------------------------------------------------------------------------------------
// T5 - finalizeSections on a day voided after the plan was built (the money leg)
// -----------------------------------------------------------------------------------------------
describe('T5 - finalizeSections after the day is voided', () => {
  it('refused with the sentence; no usage record, no movement, no entry, no section marked finalized', async () => {
    const f = await fixture('t5');
    const id = await mkUsageDay(f, D1, { verify: true });
    const built = await plan(f, id);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await voidDay(f, id); // a verified void is not blocked by a planned pull

    const usage = await usageRows(f);
    const moves = await moveRows(f);
    const entries = await entryRows(f);

    const out = await finalize(f, built.pullId, built.lines.map((l) => l.key));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(voidedSentence(D1, 'usage'));
    expect(await usageRows(f)).toBe(usage);
    expect(await moveRows(f)).toBe(moves);
    expect(await entryRows(f)).toBe(entries);
    const [p] = await sql<{ d: Date | null; r: Date | null; o: Date | null }[]>`
      select direct_finalized_at as d, recipe_finalized_at as r, orphan_finalized_at as o from pos_usage_pulls where id = ${built.pullId}`;
    expect([p!.d, p!.r, p!.o]).toEqual([null, null, null]);
  });

  it('control: the same pull on a live day finalizes and posts usage', async () => {
    const f = await fixture('t5c');
    const id = await mkUsageDay(f, D1, { verify: true });
    const built = await plan(f, id);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const usage = await usageRows(f);
    const out = await finalize(f, built.pullId, built.lines.map((l) => l.key));
    expect(out.ok).toBe(true);
    expect(await usageRows(f)).toBe(usage + 1);
  });
});

// -----------------------------------------------------------------------------------------------
// T6 - race, void first: wastage vs withdraw (the OUTCOME is the red assertion; the wait gates the harness)
// -----------------------------------------------------------------------------------------------
describe('T6 - A withdraws (uncommitted), B records wastage', () => {
  it('B waits on the day row, then is refused with the voided sentence; zero wastage rows', async () => {
    const f = await fixture('t6');
    const id = await mkDay(f, D1);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => D.voidSalesDay(tx, f.manager, id, 'Typed wrong'),
      wastageOp(f, f.manager, id),
      ROW_LOCK,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'harness gate: B must have waited behind the void').toBe(true);
    expect(bResult.status, 'B must be refused once the void commits').toBe('rejected');
    expect((bResult as { reason: { userMessage?: string } }).reason.userMessage).toBe(voidedSentence(D1, 'wastage'));
    expect(await wastageRows(f)).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// T7 - race, writer first: pins the FK lock (green on HEAD)
// -----------------------------------------------------------------------------------------------
describe('T7 - A records wastage (uncommitted), B withdraws the day', () => {
  it('B waits, then is refused with the existing wastage blocker sentence; the day stays open', async () => {
    const f = await fixture('t7');
    const id = await mkDay(f, D1);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      wastageOp(f, f.manager, id),
      (tx) => D.voidSalesDay(tx, f.manager, id, 'Typed wrong'),
      ROW_LOCK,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'B never waited: the withdraw did not queue behind the writer').toBe(true);
    expect(bResult.status).toBe('rejected');
    expect((bResult as { reason: { userMessage?: string } }).reason.userMessage).toBe(
      "Wastage is recorded against this day, so it can't be withdrawn. Edit its figures instead.", // T-375 S4 (V13): typed day, unlinked store
    );
    const [day] = await sql<{ status: string }[]>`select status from sales_days where id = ${id}`;
    expect(day!.status).toBe('open');
    expect(await wastageRows(f)).toBe(1);
  });
});

// -----------------------------------------------------------------------------------------------
// T8 - race, buildPlan vs withdraw, void first
// -----------------------------------------------------------------------------------------------
describe('T8 - A withdraws (uncommitted), B builds a plan', () => {
  it('B waits, then gets { ok: false } with the voided sentence ("usage"); no pull row', async () => {
    const f = await fixture('t8');
    const id = await mkUsageDay(f, D1);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => D.voidSalesDay(tx, f.manager, id, 'Typed wrong'),
      (tx) => D.buildPlan(tx, f.manager, { orgId: f.orgId, storeId: f.storeL, salesDayId: id, locationId: f.kitchenL }),
      ROW_LOCK,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'harness gate: B must have waited behind the void').toBe(true);
    expect(bResult.status, `buildPlan returns an Outcome, it does not throw: ${bResult.status === 'rejected' ? String((bResult.reason as Error).message) : ''}`).toBe('fulfilled');
    const out = (bResult as { value: D.BuildPlanOutcome }).value;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(voidedSentence(D1, 'usage'));
    expect(await pullRows(f)).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// T9 - two writers do not block each other (FOR SHARE, not FOR UPDATE)
// -----------------------------------------------------------------------------------------------
describe('T9 - two wastage writers on one day do not block', () => {
  it('B records and commits while A is still open; both rows exist after A commits', async () => {
    const f = await fixture('t9');
    const id = await mkDay(f, D1);
    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aPromise = asOrg(f.orgId, async (tx) => {
      const v = await wastageOp(f, f.manager, id, { reason: 'first' })(tx);
      aReady.resolve();
      await gate.promise;
      return v;
    });
    aPromise.catch(() => undefined);
    await aReady.promise;

    const bDone = wastage(f, id, { reason: 'second' }).then(() => 'committed' as const, (e) => `rejected: ${String((e as Error).message)}`);
    const timeout = new Promise<'blocked'>((res) => setTimeout(() => res('blocked'), 4000));
    const first = await Promise.race([bDone, timeout]);
    gate.resolve();
    await aPromise;
    await bDone;

    expect(first, 'B must commit while A is still open (a shared lock, not an exclusive one)').toBe('committed');
    expect(await wastageRows(f)).toBe(2);
  });
});

// -----------------------------------------------------------------------------------------------
// T10 - authorize first, before any voided-day refusal (T-364 order)
// -----------------------------------------------------------------------------------------------
describe('T10 - the capability check comes first', () => {
  it('recordOrderWastage without record_order_wastage on a VOIDED day -> AuthorizationError, not the voided sentence', async () => {
    const f = await fixture('t10a');
    const id = await mkDay(f, D1);
    await voidDay(f, id);
    const r = await rejection(wastage(f, id, {}, f.nobody), 'an unauthorised wastage on a voided day');
    expect(r.err).toBeInstanceOf(AuthorizationError);
    expect(r.userMessage ?? r.message).not.toContain('has been voided');
  });

  it('buildPlan without record_stock_movement on a VOIDED day -> AuthorizationError', async () => {
    const f = await fixture('t10b');
    const id = await mkUsageDay(f, D1);
    await voidDay(f, id);
    const r = await rejection(plan(f, id, f.nobody), 'an unauthorised plan on a voided day');
    expect(r.err).toBeInstanceOf(AuthorizationError);
    expect(await pullRows(f)).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// T12 (R7) - one date, one live pull, across a void
// -----------------------------------------------------------------------------------------------
describe('T12 - the same date cannot be pulled twice across a void', () => {
  const r7 = /^Stock usage for (.+) was already pulled against the voided day, so pulling it again would count it twice\.$/;

  it('D1 verified + finalized pull, voided; replacement D2 same date -> { ok: false } with the R7 sentence; nothing new written', async () => {
    const f = await fixture('t12');
    const d1 = await mkUsageDay(f, D1, { verify: true });
    const built = await plan(f, d1);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const fin = await finalize(f, built.pullId, built.lines.map((l) => l.key));
    expect(fin.ok).toBe(true); // usage posted on D1
    await voidDay(f, d1);
    const d2 = await mkUsageDay(f, D1); // 0177 freed the date

    const pulls = await pullRows(f);
    const usage = await usageRows(f);
    const moves = await moveRows(f);

    const out = await plan(f, d2);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const m = r7.exec(out.reason);
    expect(m, `reason was: ${out.reason}`).not.toBeNull();
    // The spec writes the date as "{d MMM YYYY}" in R7 but names no formatter; accept humanDate or d MMM YYYY.
    expect([humanDate(D1 as never), '10 Feb 2027']).toContain(m![1]);
    expect(out.reason).not.toMatch(UUID);
    expect(await pullRows(f)).toBe(pulls);
    expect(await usageRows(f)).toBe(usage);
    expect(await moveRows(f)).toBe(moves);
  });

  it('(a) voided D1 with a merely PLANNED pull (nothing posted) does not block the replacement D2', async () => {
    const f = await fixture('t12a');
    const d1 = await mkUsageDay(f, D1, { verify: true });
    const built = await plan(f, d1);
    expect(built.ok).toBe(true);
    await voidDay(f, d1);
    const d2 = await mkUsageDay(f, D1);
    const out = await plan(f, d2);
    expect(out.ok, `reason: ${out.ok ? '' : out.reason}`).toBe(true);
  });

  it('(b) voided D1 with ONE section finalized (pull status still planned) refuses D2 with the R7 sentence', async () => {
    const f = await fixture('t12b');
    // T-377 S2: finalize now finishes a pull whose other open sections are all empty, so the day carries an unmapped item
    // (an orphan line) to keep a non-empty section open and the pull genuinely `planned` after the direct section posts.
    const d1 = await mkUsageDay(f, D1, { verify: true, orphan: true });
    const built = await plan(f, d1);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((await finalize(f, built.pullId, built.lines.map((l) => l.key))).ok).toBe(true);
    const [p] = await sql<{ status: string }[]>`select status from pos_usage_pulls where id = ${built.pullId}`;
    expect(p!.status).toBe('planned');
    await voidDay(f, d1);
    const d2 = await mkUsageDay(f, D1);
    const out = await plan(f, d2);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(r7);
  });

  it('control: D1 withdrawn while it had NO pull -> a replacement D2 for the same date builds', async () => {
    const f = await fixture('t12c1');
    const d1 = await mkUsageDay(f, D1);
    await voidDay(f, d1);
    const d2 = await mkUsageDay(f, D1);
    const out = await plan(f, d2);
    expect(out.ok).toBe(true);
  });

  it('control: another date at the same store builds even though a voided day carries a pull', async () => {
    const f = await fixture('t12c2');
    const d1 = await mkUsageDay(f, D1, { verify: true });
    const built = await plan(f, d1);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await voidDay(f, d1);
    const other = await mkUsageDay(f, D2);
    const out = await plan(f, other);
    expect(out.ok).toBe(true);
  });
});
