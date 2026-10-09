import { config } from 'dotenv';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-375 S6 - rechecks and the two drift findings. `docs/tasks/375-pos-v1-day-feed.md` section S6, tests R1, R3, S1d and
 * the recheck-lock test R4L (R2 is the server action, `apps/erp/tests/integration/t375-s6-reconciliation-web.test.ts`).
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET: the finding's exact detail text, the batch's exact rows, the
 * POS store id the fetcher receives. Every "none" has a positive control in the same fixture (the same day, a money
 * change, and the finding appears).
 *
 * ## Why these are red on HEAD
 *  - `packages/domain/src/pos/v1-recheck.ts` does not exist: `recheckPosDay` is loaded by a DYNAMIC import inside
 *    `recheckDay()`, so the legs that call it fail with "Failed to resolve import ../../src/pos/v1-recheck" (a missing
 *    module, acceptable for this one new file). Everything else asserts on the target and fails on the assertion:
 *  - the two detectors `posDayFeedDrift` / `posDaySoldItemsDrift` are not registered in `listFindings`, so a finding
 *    that should exist is absent (red on the assertion: "expected [] to have a length of 1").
 *
 * ## Pinned where the spec is silent
 *  - `recheckPosDay(actor, { salesDayId }, fetchers)` takes NO tx and opens its own transactions, so it is called here
 *    bare, on the pool; the builder wraps its transactions in `withOrgPrincipal(actor.orgId, ...)` as the actions do.
 *    `fetchers` is the import's shape `{ sales, soldItems }` (each called with `{ posStoreId, businessDate, kind }`).
 *  - the return value is not read.
 *  - findings are read through `listFindings` (so registration is proven); `posDaySoldItemsDrift`'s key starts
 *    `posDaySoldItemsDrift:` and its severity is not pinned (the spec states only the feed finding's: hard).
 *  - R4L reads "waits" off `pg_stat_activity` (a backend in a row-lock wait other than the holder), the harness of
 *    `t375-s5-usage-from-feed.test.ts`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseBusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import type { PosV1SoldItemInput } from '../../../db/src/pos-v1/fixtures';
import * as D from '@shareat/domain';
import { humanDate as humanDateOf } from '../../src/shared/refusal-leaf';
import { D1_FIGURES, importTestDay, stubFetchers } from './_fixtures/pos-day';
import { asOrgOn, DAY, insertSalesRecheck, R1_FIGURES, s6Fixture, type S6F } from './_fixtures/pos-s6';
import { submitThenVerify } from './_fixtures/sales-day-flow';

const hd = (d: string) => humanDateOf(parseBusinessDate(d));
const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const AB: readonly PosV1SoldItemInput[] = [
  { key: 'A', name: 'A', physicalQty: 3 },
  { key: 'B', name: 'B', physicalQty: 2 },
];
const A4B2: readonly PosV1SoldItemInput[] = [
  { key: 'A', name: 'A', physicalQty: 4 },
  { key: 'B', name: 'B', physicalQty: 2 },
];

const imp = (f: S6F, date: string, o: { figures?: Parameters<typeof importTestDay>[2]['figures']; soldItems?: readonly PosV1SoldItemInput[] } = {}) =>
  asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date, ...o }));
const verify = (f: S6F, dayId: string) => asOrgOn(f.orgId, (tx) => submitThenVerify(tx, f.manager, dayId, f.admin));
const importVerified = async (f: S6F, date: string, o: Parameters<typeof imp>[2] = {}): Promise<string> => {
  const { id } = await imp(f, date, o);
  await verify(f, id);
  return id;
};

type Fetchers = ReturnType<typeof stubFetchers>['fetchers'];
/** `recheckPosDay` is the NEW module (v1-recheck.ts): loaded dynamically so only the legs that call it fail. */
async function recheckDay(actor: Actor, salesDayId: string, fetchers: Fetchers): Promise<unknown> {
  const m = (await import('../../src/pos/v1-recheck')) as unknown as {
    recheckPosDay: (a: Actor, input: { salesDayId: string }, fetchers: Fetchers) => Promise<unknown>;
  };
  return m.recheckPosDay(actor, { salesDayId }, fetchers);
}

const findings = (f: S6F, kind: string) =>
  asOrgOn(f.orgId, async (tx: Tx) => (await D.listFindings(tx, f.orgId, { period: '2026-12' })).findings.filter((x) => x.kind === kind));
const feedDrift = (f: S6F) => findings(f, 'posDayFeedDrift');
const itemsDrift = (f: S6F) => findings(f, 'posDaySoldItemsDrift');

const recheckFeeds = (f: S6F, date: string) =>
  sql<{ id: string; kind: string; batch_id: string; pos_store_id: string; purpose: string }[]>`
    select id, kind, batch_id, pos_store_id, purpose from pos_v1_day_feeds
     where store_id = ${f.storeId} and business_date = ${date} and purpose = 'recheck' order by fetched_at, kind`;

const FEED_DRIFT_DETAIL = (date: string) =>
  `Lipa's POS figures for ${hd(date)} changed after the day was posted: ₱1,050.00 paid then, ₱1,000.00 now. Post a correction from the day's page.`;

// =====================================================================================================
describe('R1 - a recheck after verify is a posDayFeedDrift finding when the money moved', () => {
  it('verified D1 day; recheckPosDay with P 1,000.00 (a voided 50.00 cash receipt, K 550.00) -> ONE posDayFeedDrift with the exact text; the recheck batch holds both kinds', async () => {
    const f = await s6Fixture(sql, 'r1');
    const dayId = await importVerified(f, DAY);
    expect(await feedDrift(f), 'control: nothing has drifted yet').toEqual([]);

    const stub = stubFetchers({ figures: R1_FIGURES });
    await recheckDay(f.manager, dayId, stub.fetchers);

    const found = await feedDrift(f);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'posDayFeedDrift',
      key: `posDayFeedDrift:${dayId}`,
      storeId: f.storeId,
      severity: 'hard',
      detail: FEED_DRIFT_DETAIL(DAY),
    });

    const rows = await recheckFeeds(f, DAY);
    expect(rows.map((r) => r.kind).sort(), 'both kinds, captured together').toEqual(['sales', 'sold_items']);
    expect(new Set(rows.map((r) => r.batch_id)).size, 'one batch').toBe(1);
    for (const r of rows) expect(r.pos_store_id, "POS's own id").toBe(f.posStoreId);
    expect(stub.calls.map((c) => c.kind).sort()).toEqual(['sales', 'sold_items']);
    for (const c of stub.calls) expect({ posStoreId: c.posStoreId, businessDate: c.businessDate }).toEqual({ posStoreId: f.posStoreId, businessDate: DAY });
  });

  it('control: a recheck that differs only in the guest count (receipt count 25 against 20; the body and hash differ) -> none; then the same day with a money change -> one', async () => {
    const f = await s6Fixture(sql, 'r1c');
    const dayId = await importVerified(f, DAY);
    await recheckDay(f.manager, dayId, stubFetchers({ figures: { ...D1_FIGURES, receiptCount: 25 } }).fetchers);
    const sales = await sql<{ content_hash: string }[]>`
      select content_hash from pos_v1_day_feeds where store_id = ${f.storeId} and business_date = ${DAY} and kind = 'sales'`;
    expect(new Set(sales.map((r) => r.content_hash)).size, 'control: the stored body really did change').toBe(2);
    expect(await feedDrift(f), 'a guest-count-only change is not a money change').toEqual([]);

    await recheckDay(f.manager, dayId, stubFetchers({ figures: R1_FIGURES }).fetchers);
    expect(await feedDrift(f), 'control: the same fixture does detect a money change').toHaveLength(1);
  });

  it('control: an UNVERIFIED day with a newer feed is no finding (it re-imports); verifying it makes the same newer feed one', async () => {
    const f = await s6Fixture(sql, 'r1u');
    const { id } = await imp(f, DAY);
    await asOrgOn(f.orgId, (tx) =>
      insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: DAY, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures: R1_FIGURES }),
    );
    expect(await feedDrift(f), 'open day').toEqual([]);
    await verify(f, id);
    const found = await feedDrift(f);
    expect(found, 'control: verified, the same newer feed now counts').toHaveLength(1);
    expect(found[0]).toMatchObject({ key: `posDayFeedDrift:${id}`, storeId: f.storeId, severity: 'hard', detail: FEED_DRIFT_DETAIL(DAY) });
  });

  it('an OPEN day may be rechecked (orchestrator ruling): a batch of both kinds is stored and there is no finding', async () => {
    const f = await s6Fixture(sql, 'r1o');
    const { id } = await imp(f, DAY);
    const stub = stubFetchers({ figures: R1_FIGURES });
    await recheckDay(f.manager, id, stub.fetchers);
    expect((await recheckFeeds(f, DAY)).map((r) => r.kind).sort()).toEqual(['sales', 'sold_items']);
    expect(await feedDrift(f), 'an unverified day is no finding').toHaveLength(0);
  });

  it('a person without verify_sales_day is refused (the capability is proven), nothing is stored; the manager is not', async () => {
    const f = await s6Fixture(sql, 'r1a');
    const dayId = await importVerified(f, DAY);
    const stub = stubFetchers({ figures: R1_FIGURES });
    const err = await recheckDay(f.plainStaff, dayId, stub.fetchers).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await recheckFeeds(f, DAY)).toHaveLength(0);
    expect(stub.calls, 'authorized before POS is called').toHaveLength(0);

    await recheckDay(f.manager, dayId, stub.fetchers);
    expect(await recheckFeeds(f, DAY), 'control: the manager rechecks').toHaveLength(2);
  });
});

// =====================================================================================================
describe('R3 - a recheck of a day imported under an earlier link refuses (T-382 R9a); a later day is rechecked with the current link id', () => {
  it('relink the store to a new POS id, then recheck an old day -> REFUSED with the unlinked sentence and the fetcher is NOT called; control: a day imported after the relink is rechecked with the NEW id', async () => {
    const f = await s6Fixture(sql, 'r3');
    const oldDay = await importVerified(f, DAY);

    const newPosId = `pos-new-${Date.now()}`;
    await sql`update pos_v1_store_links set pos_store_id = ${newPosId} where store_id = ${f.storeId}`;

    const stubOld = stubFetchers({ figures: R1_FIGURES });
    const err = await recheckDay(f.manager, oldDay, stubOld.fetchers).then(() => null, (e) => e);
    expect(err, 'R9a: the basis came from an earlier link').toBeInstanceOf(Error);
    expect(String((err as { userMessage?: string }).userMessage ?? (err as Error).message)).toBe(
      "Lipa isn't linked to a POS store, so its POS figures can't be read.",
    );
    expect(stubOld.calls, 'POS is not asked').toHaveLength(0);
    expect(await recheckFeeds(f, DAY), 'no recheck feed stored').toHaveLength(0);

    const day2 = '2027-01-11';
    const newDay = await importVerified(f, day2);
    const stubNew = stubFetchers({ figures: R1_FIGURES });
    await recheckDay(f.manager, newDay, stubNew.fetchers);
    expect(stubNew.calls).toHaveLength(2);
    for (const c of stubNew.calls) expect(c.posStoreId, 'control: a day whose basis was fetched with the new id').toBe(newPosId);
  });
});

// =====================================================================================================
describe('S1d - posDaySoldItemsDrift: a finalized usage pull whose pinned sold items are older than a differing recheck', () => {
  const SOLD_ITEMS_DETAIL = (date: string) =>
    `Lipa: POS's sold items for ${hd(date)} changed after usage was posted. Void the POS usage pull and pull it again; the new pull reads the latest check.`;

  const plan = (f: S6F, salesDayId: string) =>
    asOrgOn(f.orgId, (tx) => D.buildPlan(tx, f.manager, { orgId: f.orgId, storeId: f.storeId, salesDayId, locationId: f.kitchen }));
  async function pullAndFinalize(f: S6F, dayId: string): Promise<string> {
    const p = await plan(f, dayId);
    if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
    const keys = p.lines.filter((l) => l.section === 'direct' && !l.blocked).map((l) => l.key);
    const out = await asOrgOn(f.orgId, (tx) => D.finalizeSections(tx, f.manager, { pullId: p.pullId, sections: ['direct'], confirmedKeys: keys }));
    if (!out.ok) throw new Error(`fixture: finalize refused: ${out.reason}`);
    return p.pullId;
  }

  it('finalized pull on F1 {A 3, B 2}; a recheck {A 4, B 2} -> ONE posDaySoldItemsDrift with the exact text, and no posDayFeedDrift (the money did not move)', async () => {
    const f = await s6Fixture(sql, 's1d', { stock: true });
    const dayId = await importVerified(f, DAY, { soldItems: AB });
    await pullAndFinalize(f, dayId);
    expect(await itemsDrift(f), 'control: a finalized pull with nothing newer is no finding').toEqual([]);

    await recheckDay(f.manager, dayId, stubFetchers({ figures: D1_FIGURES, soldItems: A4B2 }).fetchers);
    const found = await itemsDrift(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.key.startsWith('posDaySoldItemsDrift:')).toBe(true);
    expect(found[0]).toMatchObject({ storeId: f.storeId, detail: SOLD_ITEMS_DETAIL(DAY) });
    expect(await feedDrift(f), 'only the items moved').toEqual([]);
  });

  it('control: a recheck with IDENTICAL items (a different order and names) -> none; a differing one -> one', async () => {
    const f = await s6Fixture(sql, 's1dc', { stock: true });
    const dayId = await importVerified(f, DAY, { soldItems: AB });
    await pullAndFinalize(f, dayId);
    await recheckDay(f.manager, dayId, stubFetchers({ figures: D1_FIGURES, soldItems: [{ key: 'B', name: 'other', physicalQty: 2 }, { key: 'A', name: 'other', physicalQty: 3 }] }).fetchers);
    expect(await itemsDrift(f), 'newer but identical items').toEqual([]);
    await recheckDay(f.manager, dayId, stubFetchers({ figures: D1_FIGURES, soldItems: A4B2 }).fetchers);
    expect(await itemsDrift(f), 'control: the differing recheck is a finding').toHaveLength(1);
  });

  it('control: no pull at all -> none even with a differing recheck; void the pull and pull again (reads the latest check) -> the finding clears', async () => {
    const f = await s6Fixture(sql, 's1dv', { stock: true });
    const dayId = await importVerified(f, DAY, { soldItems: AB });
    await recheckDay(f.manager, dayId, stubFetchers({ figures: D1_FIGURES, soldItems: A4B2 }).fetchers);
    expect(await itemsDrift(f), 'no pull: nothing was posted on the old items').toEqual([]);

    // The pull is made on the LATEST feed here, so build the drifted state the other way round: pull, then recheck again.
    const pullId = await pullAndFinalize(f, dayId);
    expect(await itemsDrift(f), 'a pull on the latest check is current').toEqual([]);
    await recheckDay(f.manager, dayId, stubFetchers({ figures: D1_FIGURES, soldItems: [{ key: 'A', name: 'A', physicalQty: 5 }, { key: 'B', name: 'B', physicalQty: 2 }] }).fetchers);
    expect(await itemsDrift(f)).toHaveLength(1);

    const voided = await asOrgOn(f.orgId, (tx) => D.voidPosUsagePull(tx, f.manager, { pullId, reason: 'POS changed' }));
    expect(voided.ok).toBe(true);
    expect(await itemsDrift(f), 'a voided pull is not a finding').toEqual([]);
    const again = await pullAndFinalize(f, dayId);
    expect(again, 'a NEW pull').not.toBe(pullId);
    expect(await itemsDrift(f), 'the new pull reads the latest check').toEqual([]);
  });
});

// =====================================================================================================
describe('R4L - the recheck\'s feed insert holds the day FOR UPDATE (S5-lite audit)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  async function waiterExists(holderPid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql`
        select pid from pg_stat_activity
         where datname = current_database() and pid <> ${holderPid} and wait_event_type = 'Lock'
           and wait_event in ('transactionid', 'tuple')`;
      if (rows.length > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it('a recheck waits while another transaction holds the day FOR UPDATE, writes nothing meanwhile, and completes after it commits; control: with no lock it completes at once', async () => {
    const f = await s6Fixture(sql, 'r4l');
    const dayId = await importVerified(f, DAY);
    const stub = stubFetchers({ figures: R1_FIGURES });

    // Control: no lock held -> the recheck completes (and the fetchers are the same ones the lock leg uses).
    await recheckDay(f.manager, dayId, stub.fetchers);
    expect(await recheckFeeds(f, DAY), 'control: an unlocked recheck writes its batch').toHaveLength(2);

    const release = deferred<void>();
    const held = deferred<number>();
    const holder = asOrgOn(f.orgId, async (tx) => {
      await tx.execute(dsql`select id from sales_days where id = ${dayId} for update`);
      const rows = (await tx.execute(dsql`select pg_backend_pid() as pid`)) as unknown as { pid: number }[];
      held.resolve(Number(rows[0]!.pid));
      await release.promise;
    });
    const holderPid = await held.promise;

    let settled = false;
    const rechecking = recheckDay(f.manager, dayId, stub.fetchers).then(
      () => {
        settled = true;
        return null;
      },
      (e: unknown) => {
        settled = true;
        return e;
      },
    );
    try {
      const waited = await waiterExists(holderPid, 4000);
      expect(waited, 'the recheck must be waiting on the day lock').toBe(true);
      expect(settled, 'and must not have finished while the lock is held').toBe(false);
      expect(await recheckFeeds(f, DAY), 'nothing written while the day is locked').toHaveLength(2);
    } finally {
      release.resolve();
      await holder;
    }
    expect(await rechecking, 'the recheck succeeds once the lock is released').toBeNull();
    expect(await recheckFeeds(f, DAY), 'its batch is written after the lock is released').toHaveLength(4);
  });
});

// =====================================================================================================
// Audit additions (S6 audit): D importer without verify_sales_day, E relabel / method mix, F found:false.
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

describe('D - the 7-day recheck runs for an importer WITHOUT verify_sales_day', () => {
  async function recheckRecent(actor: Actor, storeId: string, beforeDate: string, fetchers: Fetchers): Promise<unknown> {
    const m = (await import('../../src/pos/v1-recheck')) as unknown as {
      recheckRecentDays: (a: Actor, storeId: string, beforeDate: string, fetchers: Fetchers) => Promise<unknown>;
    };
    return m.recheckRecentDays(actor, storeId, beforeDate, fetchers);
  }
  it('a cashier who can import (submit_sales_day, not verify_sales_day) triggers the recheck: batches stored for D-1 and D-2; control: a person who cannot import checks nothing', async () => {
    const f = await s6Fixture(sql, 'd1');
    await importVerified(f, '2027-01-09');
    await importVerified(f, '2027-01-08');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Cashier') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${f.orgId}, ${f.storeId}, ${p!.id}, ${`SE-${Date.now()}`}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId: f.orgId, storeId: f.storeId, employmentId: emp!.id, personId: p!.id, setBy: f.managerId });
    const cashier: Actor = { personId: p!.id, orgId: f.orgId };

    await recheckRecent(f.plainStaff, f.storeId, DAY, stubFetchers({ figures: R1_FIGURES }).fetchers).catch(() => null);
    expect(await recheckFeeds(f, '2027-01-09'), 'control: someone who cannot import checks nothing').toHaveLength(0);
    expect(await recheckFeeds(f, '2027-01-08')).toHaveLength(0);

    await recheckRecent(cashier, f.storeId, DAY, stubFetchers({ figures: R1_FIGURES }).fetchers);
    for (const d of ['2027-01-09', '2027-01-08']) {
      expect((await recheckFeeds(f, d)).map((r) => r.kind).sort(), `${d}: a batch of both kinds`).toEqual(['sales', 'sold_items']);
    }
  });
});

describe('E - what counts as a payment-method change', () => {
  it('a method key that only changes spelling ("Gcash " for "GCash") is no drift; control: a real amount change is', async () => {
    const f = await s6Fixture(sql, 'e1');
    const dayId = await importVerified(f, DAY);
    await recheckDay(f.manager, dayId, stubFetchers({ figures: { ...D1_FIGURES, methods: { Cash: 700, 'Gcash ': 350 } } }).fetchers);
    expect(await feedDrift(f), 'the same tender under another spelling').toEqual([]);
    await recheckDay(f.manager, dayId, stubFetchers({ figures: R1_FIGURES }).fetchers);
    expect(await feedDrift(f), 'control: a real amount change').toHaveLength(1);
  });

  it('a method-mix-only change (same 1,050.00 paid: Cash 600 / GCash 450) -> a drift whose detail says the payment methods changed', async () => {
    const f = await s6Fixture(sql, 'e2');
    const dayId = await importVerified(f, DAY);
    await recheckDay(f.manager, dayId, stubFetchers({ figures: { ...D1_FIGURES, methods: { Cash: 600, GCash: 450 } } }).fetchers);
    const found = await feedDrift(f);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: `posDayFeedDrift:${dayId}`,
      detail: `Lipa's POS payment methods for ${hd(DAY)} changed after the day was posted (₱1,050.00 in total either way). Post a correction from the day's page.`,
    });
  });
});

describe('F - a recheck where POS says found:false', () => {
  it('on a verified day with sales stores NO batch and logs a warning naming the date; control: found:true stores one', async () => {
    const f = await s6Fixture(sql, 'f1');
    const dayId = await importVerified(f, DAY);
    const warn = vi.spyOn(logger, 'warn');
    spies.push(warn);

    await recheckDay(f.manager, dayId, stubFetchers({ figures: { found: false } }).fetchers).catch(() => null);
    expect(await recheckFeeds(f, DAY), 'nothing stored for a "no data" answer').toHaveLength(0);
    const logged = warn.mock.calls.map((c) => JSON.stringify(c.map((a) => (a instanceof Error ? a.message : a))));
    expect(logged.some((l) => l.includes(DAY) || l.includes(hd(DAY))), `a warning names the date (saw ${logged.length} warnings)`).toBe(true);

    await recheckDay(f.manager, dayId, stubFetchers({ figures: R1_FIGURES }).fetchers);
    expect(await recheckFeeds(f, DAY), 'control: found:true is stored').toHaveLength(2);
  });
});
