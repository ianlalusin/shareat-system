import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-396 S1 - the 06:00 Manila POS day-import job (`posDayImportSweep`). `docs/tasks/396-link-remaining-stores-and-
 * morning-import.md` S1 tests 1-15 (+ 3b, 3c, 4b, 9b, 10b) and the "Audit 2026-10-17" / "Orchestrator rulings" amendments.
 *
 * TESTER, not BUILDER. Every case names the mutant it kills (the spec's table). Nothing here edits source.
 *
 * ## Why these are red on HEAD
 * `packages/domain/src/pos/day-import-job.ts` does not exist and `importSalesDay` has no `ifAbsent` / `source` option.
 * The job is loaded DYNAMICALLY (`sweep()`), so each leg fails on its own ("Failed to resolve import ../../src/pos/
 * day-import-job"), never the whole file at collection. Legs that call `importSalesDay` with the new option are red
 * on the assertion. The F-legs (fixture sanity) run against code that EXISTS and are green on HEAD, so a red job leg
 * can only be the job's.
 *
 * ## The contract the tests assume where the spec is silent (a question to the builder, never a test edit)
 *  - `posDayImportSweep({ orgId, now: Date, trigger: 'cron'|'manual', dryRun: boolean, fetchers?: ImportFetchers })`
 *    -> `{ outcomes, hadFailures }` (the `usageAutoPostSweep` shape). `fetchers` is the SAME pair the import and the
 *    recheck take (`{ sales, soldItems }`), threaded to both;
 *  - what a run says is read from its `scheduler_runs` row (`posted_count`, `skipped_count`, `failed_count`, `outcome`,
 *    `failures` jsonb): a failure line is `{ subjectId: <v2 store id>, subjectName, reason }`, a notice has `kind:
 *    'notice'`. A line's TEXT is `subjectName + ' ' + reason` (the spec's examples put the store and date in either);
 *  - a dry run writes no `scheduler_runs` row; "output lists what would import" is read as the dates appearing anywhere
 *    in the returned value (`JSON.stringify(result)`), ISO or "12 Jan" form;
 *  - `importSalesDay`'s new options ride on the INPUT object: `{ storeId, businessDate, ifAbsent: true, source: 'cron' }`;
 *    it returns `{ id, skipped: true }` for a present day and `{ notFound: true }` for POS `found:false`.
 *    (One helper, `callImport`, is the only place that shape lives.)
 *
 * ## The principal gap (DEF-218) - read this before trusting a green run
 * The old comment in `recurring-expenses-job.test.ts` says integration tests connect as a superuser and cannot see a
 * missing `withOrgPrincipal`. That stopped being true on 2026-09-12: `tests/integration/setup.ts` points `DATABASE_URL`
 * (what `transaction()` resolves) at the restricted role `shareat_test_runner` (non-superuser, no BYPASSRLS) and only
 * `SYSTEM_DATABASE_URL` at the owner. So a job that reads a link or imports a day inside a BARE `transaction` sees zero
 * rows / is refused 42501 here. R0 pins the two facts that make that so (the role is armed; a principal-less read sees
 * nothing) so this file cannot silently turn vacuous if someone runs with `INTEGRATION_RESTRICTED_ROLE=0`; every job leg
 * then proves the principal by importing at all (a bare-`transaction` job lists no links and imports nothing: test 1 red).
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
import { voidSalesDay } from '../../src/sales-days/verify';
import { PosNotConfiguredError, PosUnreachableError } from '../../src/pos/v1-feed';
import { humanDate as humanDateOf } from '../../src/shared/refusal-leaf';
import { posV1SalesBody, posV1SoldItemsBody, type PosV1SalesFigures } from '../../../db/src/pos-v1/fixtures';
import { mkSubmitter, submitThenVerify } from './_fixtures/sales-day-flow';
import { D1_FIGURES, D2B_FIGURES, D1_SOLD_ITEMS, importTestDay, linkTestStore, seedTestTenders, type FeedCall } from './_fixtures/pos-day';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const hd = (d: string) => humanDateOf(parseBusinessDate(d));
/** True when `text` names the date, ISO or "12 Jan" (not "2 Jan" inside "12 Jan"). */
const mentions = (text: string, iso: string): boolean =>
  text.includes(iso) || new RegExp(`(^|\\D)${hd(iso).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);

const sql = postgres(url, { max: 12 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
const sentence = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);

// ---- the clock -----------------------------------------------------------------------------------------------
/** 06:00 Manila on 2027-01-13: yesterday (the last closed day) is 2027-01-12, the 7-day window is 01-06 .. 01-12. */
const NOW = '2027-01-12T22:00:00.000Z';
const YESTERDAY = '2027-01-12';
const WINDOW_START = '2027-01-06';
const ago = (isoDate: string, n: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const range = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = ago(d, 1)) out.push(d);
  return out;
};
/** A link made on this Manila date, at noon (unambiguous in UTC too). */
const noonManila = (isoDate: string): string => `${isoDate}T04:00:00.000Z`;

// ---- the fixture -----------------------------------------------------------------------------------------------
interface StoreSpec {
  name: string;
  /** Manila date the link was made (default 2027-01-01, i.e. older than the whole window). */
  linkedOn?: string;
  /** false = never linked. */
  linked?: boolean;
  /** true = linked then unlinked (T-382). */
  unlinked?: boolean;
  /** Link's `updated_by` (the actor of record). Default null (= the creator). */
  updatedBy?: 'adminB';
  creator?: 'adminA' | 'adminB';
}

async function fixture(hint: string, specs: StoreSpec[] = [{ name: 'Alpha' }]) {
  const code = uid(`t396s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-02-01', '2027-02-28', 'open')`;

  const stores: { name: string; storeId: string; posStoreId: string; linkId: string | null }[] = [];
  for (const s of specs) {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${s.name}) returning id`;
    stores.push({ name: s.name, storeId: st!.id, posStoreId: '', linkId: null });
  }
  const storeIds = stores.map((s) => s.storeId);
  const mkPerson = async (name: string, role: string, scope: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const sid of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${sid})`;
    return p!.id;
  };
  const adminAId = await mkPerson('Admin A', 'admin', storeIds);
  const adminBId = await mkPerson('Admin B', 'admin', storeIds);
  const managerId = await mkPerson('Manager', 'manager', storeIds);

  for (const [i, s] of specs.entries()) {
    const st = stores[i]!;
    const [chan] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${st.storeId}, 'Walk-in', true, null) returning id`;
    const [gcash] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${st.storeId}, ${`GCash - ${s.name}`}, 'ewallet', '1140', 'cashier') returning id`;
    await seedTestTenders(sql, { orgId, storeId: st.storeId, walletAccountId: gcash!.id });
    if (s.linked === false) continue;
    const creator = s.creator === 'adminB' ? adminBId : adminAId;
    const { posStoreId, linkId } = await linkTestStore(sql, { orgId, storeId: st.storeId, channelId: chan!.id, createdBy: creator });
    st.posStoreId = posStoreId;
    st.linkId = linkId;
    await sql`update pos_v1_store_links set created_at = ${noonManila(s.linkedOn ?? '2027-01-01')}::timestamptz where id = ${linkId}`;
    if (s.updatedBy === 'adminB') {
      await sql`update pos_v1_store_links set updated_by = ${adminBId}, updated_at = ${noonManila(s.linkedOn ?? '2027-01-01')}::timestamptz where id = ${linkId}`;
    }
    if (s.unlinked) {
      await sql`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${adminAId}, unlink_reason = 'closed for good' where id = ${linkId}`;
    }
  }
  const byName = (n: string) => stores.find((s) => s.name === n)!;
  return {
    orgId, stores, byName, storeIds, adminAId, adminBId, managerId,
    adminA: actorOf(orgId, adminAId), adminB: actorOf(orgId, adminBId), manager: actorOf(orgId, managerId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

// ---- recording POS fetchers, routed by POS store id ---------------------------------------------------------------
interface Behaviour {
  figures?: (d: string) => PosV1SalesFigures;
  /** POS answers `found:false` for this date. */
  closed?: (d: string) => boolean;
  /** Every call throws this. */
  fail?: Error;
  /** Runs before the answer, with the 1-based count of this (kind, store, date); may throw or await. */
  onCall?: (kind: 'sales' | 'sold_items', date: string, n: number) => Promise<void> | void;
}
function router(map: Record<string, Behaviour> = {}) {
  const calls: FeedCall[] = [];
  const seen = new Map<string, number>();
  const make = (kind: 'sales' | 'sold_items') => async (input: { posStoreId: string; businessDate: string; kind?: string }) => {
    calls.push({ kind, posStoreId: input.posStoreId, businessDate: input.businessDate });
    const b = map[input.posStoreId] ?? {};
    const key = `${kind}|${input.posStoreId}|${input.businessDate}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (b.onCall) await b.onCall(kind, input.businessDate, n);
    if (b.fail) throw b.fail;
    const closed = b.closed?.(input.businessDate) === true;
    const obj =
      kind === 'sales'
        ? posV1SalesBody({ ...(b.figures?.(input.businessDate) ?? D1_FIGURES), ...(closed ? { found: false } : {}) })
        : posV1SoldItemsBody(closed ? [] : D1_SOLD_ITEMS, closed ? { found: false } : {});
    const body = JSON.stringify(obj, null, 2);
    return { body, payload: JSON.parse(body) as unknown };
  };
  const fetchers = { sales: make('sales'), soldItems: make('sold_items') };
  const salesDates = (posStoreId?: string) =>
    calls.filter((c) => c.kind === 'sales' && (!posStoreId || c.posStoreId === posStoreId)).map((c) => c.businessDate);
  const forStore = (posStoreId: string) => calls.filter((c) => c.posStoreId === posStoreId);
  return { fetchers, calls, salesDates, forStore };
}
type Routed = ReturnType<typeof router>;

// ---- the job, loaded dynamically ----------------------------------------------------------------------------------
interface SweepResult {
  outcomes: unknown[];
  hadFailures: boolean;
}
async function sweep(
  f: F,
  o: { now?: string; trigger?: 'cron' | 'manual'; dryRun?: boolean; fetchers: Routed['fetchers'] },
): Promise<SweepResult> {
  const mod = (await import('../../src/pos/day-import-job')) as unknown as {
    posDayImportSweep: (opts: {
      orgId?: string;
      now: Date;
      trigger?: 'cron' | 'manual';
      dryRun?: boolean;
      fetchers?: unknown;
    }) => Promise<SweepResult>;
  };
  return mod.posDayImportSweep({
    orgId: f.orgId,
    now: new Date(o.now ?? NOW),
    trigger: o.trigger ?? 'cron',
    dryRun: o.dryRun ?? false,
    fetchers: o.fetchers,
  });
}

/** `importSalesDay` with the T-396 options. The ONLY place their shape lives. */
async function callImport(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; businessDate: string; ifAbsent?: boolean; source?: 'cron' | 'manual' },
  fetchers: Routed['fetchers'],
): Promise<{ id?: string; skipped?: true; notFound?: true }> {
  const { importSalesDay } = (await import('../../src/sales-days/import')) as unknown as {
    importSalesDay: (tx: Tx | null, actor: Actor, input: unknown, fetchers?: unknown) => Promise<{ id?: string; skipped?: true; notFound?: true }>;
  };
  return importSalesDay(tx, actor, input, fetchers);
}

// ---- reading what happened ----------------------------------------------------------------------------------------
type Line = { subjectId: string; subjectName: string; reason: string; kind?: 'notice' };
type RunRow = {
  id: string; job: string; period: string; posted_count: number; skipped_count: number; failed_count: number;
  outcome: string; error: string | null; trigger: string; failures: Line[] | null; started_at: Date;
};
const runs = (orgId: string) => sql<RunRow[]>`
  select id, job, period, posted_count, skipped_count, failed_count, outcome, error, trigger, failures, started_at
    from scheduler_runs where org_id = ${orgId} and job = 'pos_day_import' order by started_at, id`;
async function lastRun(orgId: string): Promise<RunRow> {
  const all = await runs(orgId);
  expect(all.length, 'the job writes exactly one scheduler_runs row per run').toBeGreaterThan(0);
  return all[all.length - 1]!;
}
const failuresOf = (r: RunRow): Line[] => (r.failures ?? []).filter((l) => l.kind !== 'notice');
const noticesOf = (r: RunRow): Line[] => (r.failures ?? []).filter((l) => l.kind === 'notice');
const text = (l: Line): string => `${l.subjectName} ${l.reason}`;
/** Stamp the latest run as having started at `iso` - the run's clock is the DB's, the tests' clock is injected. */
const stampLastRun = (orgId: string, iso: string) =>
  sql`update scheduler_runs set started_at = ${iso}::timestamptz, finished_at = ${iso}::timestamptz
       where id = (select id from scheduler_runs where org_id = ${orgId} and job = 'pos_day_import' order by started_at desc, id desc limit 1)`;

type DayRow = { id: string; business_date: string; status: string; source: string; created_by: string; submitted_by: string | null; verified_by: string | null; total_sales: string; created_at: Date };
const days = (storeId: string) => sql<DayRow[]>`
  select id, business_date::text as business_date, status, source, created_by, submitted_by, verified_by, total_sales, created_at
    from sales_days where store_id = ${storeId} order by business_date`;
const dayDates = async (storeId: string) => (await days(storeId)).map((d) => d.business_date);
type FeedRow = { id: string; business_date: string; kind: string; batch_id: string; fetched_by: string };
const feeds = (storeId: string) => sql<FeedRow[]>`
  select id, business_date::text as business_date, kind, batch_id, fetched_by from pos_v1_day_feeds where store_id = ${storeId} order by business_date, kind`;
const autoImportRows = (orgId: string) => sql<{ entity_id: string; source: string; store_id: string | null; actor_person_id: string | null; category: string; sensitivity: string }[]>`
  select entity_id::text as entity_id, source, store_id::text as store_id, actor_person_id::text as actor_person_id, category, sensitivity
    from audit_log where org_id = ${orgId} and action = 'sales_day.auto_imported' order by recorded_at`;
const journalCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId}`)[0]!.n;

/** A human (manager) imports `date` through the ordinary path - the control group for "a person got there first". */
const humanImport = (f: F, storeId: string, date: string, figures: PosV1SalesFigures = D1_FIGURES) =>
  asOrg(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId, businessDate: date, figures }));

// ================================================================================================================
describe('R0 - the harness really enforces the principal (so a job without withOrgPrincipal cannot go green here)', () => {
  it('DATABASE_URL is the restricted role, and a principal-less transaction() sees none of an org\'s links while withOrgPrincipal sees them', async () => {
    expect(process.env.DATABASE_URL ?? '', 'run with the restricted role armed (INTEGRATION_RESTRICTED_ROLE must not be 0)').toContain('shareat_test_runner');
    const f = await fixture('r0');
    const bare = await transaction(async (tx) => {
      try {
        const rows = (await tx.execute(dsql`select id from pos_v1_store_links where org_id = ${f.orgId}`)) as unknown as unknown[];
        return rows.length;
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    });
    expect(bare === 0 || String(bare).startsWith('refused'), `a bare transaction must see nothing (got ${String(bare)})`).toBe(true);
    const withPrincipal = await asOrg(f.orgId, async (tx) => ((await tx.execute(dsql`select id from pos_v1_store_links where org_id = ${f.orgId}`)) as unknown as unknown[]).length);
    expect(withPrincipal, 'the non-zero control: the principal sees the link').toBe(1);
  });
});

describe('F - fixture sanity against code that exists (green on HEAD; a red job leg below is the job\'s)', () => {
  it('F1: a plain importSalesDay on a fixture store imports an open feed day; F2: a demoted linker is refused', async () => {
    const f = await fixture('f1');
    const a = f.byName('Alpha');
    const r = await humanImport(f, a.storeId, YESTERDAY);
    expect((await days(a.storeId)).map((d) => [d.id, d.status, d.source])).toEqual([[r.id, 'open', 'pos_v1_day_feed']]);

    const g = await fixture('f2');
    await sql`update person_roles set role = 'staff' where person_id = ${g.adminAId}`;
    const err = await asOrg(g.orgId, (tx) => importTestDay(tx, g.adminA, { storeId: g.byName('Alpha').storeId, businessDate: YESTERDAY })).then(() => null, (e) => e);
    expect(err, 'a demoted actor must be refused').toBeInstanceOf(AuthorizationError);
  });
});

describe('1 - every linked store gets yesterday as an open draft, and nothing else happens', () => {
  it('two stores, now = 06:00 Manila: yesterday only, source pos_v1_day_feed, status open, no journal entry, no submitted_by; stores visited in name order', async () => {
    // Created Bravo first: only an ordering by store NAME puts Alpha's fetches first.
    const f = await fixture('t1', [{ name: 'Bravo', linkedOn: YESTERDAY }, { name: 'Alpha', linkedOn: YESTERDAY }]);
    const pos = router();
    const result = await sweep(f, { fetchers: pos.fetchers });

    for (const name of ['Alpha', 'Bravo']) {
      const rows = await days(f.byName(name).storeId);
      expect(rows.map((d) => d.business_date), `${name}: yesterday and only yesterday`).toEqual([YESTERDAY]);
      expect(rows[0]!.status, 'a draft: open').toBe('open');
      expect(rows[0]!.source).toBe('pos_v1_day_feed');
      expect(rows[0]!.submitted_by, 'the timer never submits').toBeNull();
      expect(rows[0]!.verified_by, 'the timer never verifies').toBeNull();
    }
    expect(await journalCount(f.orgId), 'nothing is posted to the ledger').toBe(0);
    expect(pos.salesDates().slice(0, 2), 'Alpha is visited before Bravo').toEqual([YESTERDAY, YESTERDAY]);
    expect(pos.calls.find((c) => c.kind === 'sales')!.posStoreId).toBe(f.byName('Alpha').posStoreId);
    const run = await lastRun(f.orgId);
    expect([run.posted_count, run.failed_count, run.outcome]).toEqual([2, 0, 'ok']);
    expect(result.hadFailures).toBe(false);
  });
});

describe('2 - idempotent: a second run imports nothing and touches nothing', () => {
  it('second run: 0 imported, 2 skipped, no POS call, the same day ids and feed rows', async () => {
    const f = await fixture('t2', [{ name: 'Alpha', linkedOn: YESTERDAY }, { name: 'Bravo', linkedOn: YESTERDAY }]);
    const pos1 = router();
    await sweep(f, { fetchers: pos1.fetchers });
    const before = {
      a: (await days(f.byName('Alpha').storeId)).map((d) => d.id),
      b: (await days(f.byName('Bravo').storeId)).map((d) => d.id),
      feedsA: (await feeds(f.byName('Alpha').storeId)).map((x) => x.id),
      feedsB: (await feeds(f.byName('Bravo').storeId)).map((x) => x.id),
    };
    expect(before.feedsA.length + before.feedsB.length, 'first run stored one 2-row batch per store').toBe(4);
    await stampLastRun(f.orgId, NOW); // the run clock is the DB's; keep "the previous run" on the injected morning

    const pos2 = router();
    await sweep(f, { fetchers: pos2.fetchers });
    const run = await lastRun(f.orgId);
    expect([run.posted_count, run.skipped_count, run.failed_count]).toEqual([0, 2, 0]);
    expect(pos2.calls, 'a present day is skipped before POS is asked').toHaveLength(0);
    expect((await days(f.byName('Alpha').storeId)).map((d) => d.id)).toEqual(before.a);
    expect((await days(f.byName('Bravo').storeId)).map((d) => d.id)).toEqual(before.b);
    expect((await feeds(f.byName('Alpha').storeId)).map((x) => x.id), 'no new feed batch, no replaced feed').toEqual(before.feedsA);
    expect((await feeds(f.byName('Bravo').storeId)).map((x) => x.id)).toEqual(before.feedsB);
  });
});

describe('3 / 3b / 3c - a person who got there first is never overwritten', () => {
  it('3: a human import COMMITS on its own connection while the timer is mid-fetch: ifAbsent skips, no new feed batch, the human\'s figures and created_by stay', async () => {
    const f = await fixture('t3', [{ name: 'Alpha', linkedOn: YESTERDAY }]);
    const a = f.byName('Alpha');
    let humanId = '';
    const pos = router({
      [a.posStoreId]: {
        figures: () => D1_FIGURES,
        onCall: async (kind, date, n) => {
          if (kind === 'sales' && n === 1) humanId = (await humanImport(f, a.storeId, date, D2B_FIGURES)).id;
        },
      },
    });
    const result = await sweep(f, { fetchers: pos.fetchers });

    const rows = await days(a.storeId);
    expect(rows, 'still exactly one day').toHaveLength(1);
    expect(rows[0]!.id).toBe(humanId);
    expect(rows[0]!.created_by, 'created_by is the human\'s, not the timer\'s').toBe(f.managerId);
    const fe = await feeds(a.storeId);
    expect(new Set(fe.map((x) => x.batch_id)).size, 'only the human\'s feed batch exists').toBe(1);
    expect(fe.every((x) => x.fetched_by === f.managerId)).toBe(true);
    const run = await lastRun(f.orgId);
    expect([run.posted_count, run.skipped_count, run.failed_count, run.outcome]).toEqual([0, 1, 0, 'ok']);
    expect(result.hadFailures).toBe(false);
    expect(await autoImportRows(f.orgId), 'the timer made nothing, so it audits nothing').toHaveLength(0);
  });

  it('3b: a human\'s UNCOMMITTED insert holds the date; the timer\'s insert blocks, then (23505) records skipped - never a failure, never an aborted run', async () => {
    const f = await fixture('t3b', [{ name: 'Alpha', linkedOn: YESTERDAY }]);
    const a = f.byName('Alpha');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let markInserted!: () => void;
    const inserted = new Promise<void>((r) => { markInserted = r; });
    let humanDone: Promise<unknown> = Promise.resolve();
    const pos = router({
      [a.posStoreId]: {
        onCall: async (kind, date, n) => {
          if (kind !== 'sales' || n !== 1) return;
          humanDone = asOrg(f.orgId, async (tx) => {
            await importTestDay(tx, f.manager, { storeId: a.storeId, businessDate: date });
            markInserted();
            await gate; // keep the transaction open: the day exists, uncommitted
          });
          await inserted;
        },
      },
    });
    const swept = sweep(f, { fetchers: pos.fetchers });
    // Fail fast (instead of hanging) when the job is missing or ends before it ever fetched.
    await Promise.race([inserted, swept.then(() => { throw new Error('the job finished without fetching the date'); })]);
    const state = await Promise.race([swept.then(() => 'finished'), sleep(1500).then(() => 'blocked')]);
    expect(state, 'the timer\'s insert waits behind the human\'s uncommitted day (the unique index), it does not race past it').toBe('blocked');
    release();
    await humanDone;
    const result = await swept;

    const rows = await days(a.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_by, 'the human\'s day stands').toBe(f.managerId);
    const run = await lastRun(f.orgId);
    expect(failuresOf(run), 'the lost race is not a failure line').toEqual([]);
    expect([run.posted_count, run.skipped_count, run.failed_count, run.outcome, run.error]).toEqual([0, 1, 0, 'ok', null]);
    expect(result.hadFailures).toBe(false);
    expect(new Set((await feeds(a.storeId)).map((x) => x.batch_id)).size, 'the timer\'s rolled-back batch left nothing').toBe(1);
  });

  it('3c: ifAbsent on a VERIFIED day is a skip - POS never called, no refusal; without it the same call refuses (the control)', async () => {
    const f = await fixture('t3c', [{ name: 'Alpha' }]);
    const a = f.byName('Alpha');
    const { id } = await humanImport(f, a.storeId, '2027-01-10');
    const submitter = await mkSubmitter(sql, f.orgId, [a.storeId], 'Submitter');
    await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, id, submitter));
    const pos = router();

    const skipped = await asOrg(f.orgId, (tx) => callImport(tx, f.adminA, { storeId: a.storeId, businessDate: '2027-01-10', ifAbsent: true, source: 'cron' }, pos.fetchers));
    expect(skipped).toMatchObject({ id, skipped: true });
    expect(pos.calls, 'POS is not called for a present day').toHaveLength(0);
    expect((await days(a.storeId))[0]!.status).toBe('verified');

    const refused = await asOrg(f.orgId, (tx) => callImport(tx, f.adminA, { storeId: a.storeId, businessDate: '2027-01-10' }, pos.fetchers)).then(() => null, (e) => e);
    expect(refused, 'control: without ifAbsent a verified day refuses').toBeTruthy();
    expect(sentence(refused)).toMatch(/already verified/i);
  });
});

describe('4 - the window: link date floor, 7-day cap, holes filled, oldest first', () => {
  it('4a: link made on 10 Jan -> exactly 10, 11, 12 Jan, oldest first (not "only yesterday")', async () => {
    const f = await fixture('t4a', [{ name: 'Alpha', linkedOn: '2027-01-10' }]);
    const pos = router();
    await sweep(f, { fetchers: pos.fetchers });
    expect(pos.salesDates(), 'fetched oldest first').toEqual(['2027-01-10', '2027-01-11', '2027-01-12']);
    expect(await dayDates(f.byName('Alpha').storeId)).toEqual(['2027-01-10', '2027-01-11', '2027-01-12']);
  });
  it('4b-floor: link made on 11 Jan (2 days ago) -> only 11 and 12 Jan', async () => {
    const f = await fixture('t4floor', [{ name: 'Alpha', linkedOn: '2027-01-11' }]);
    const pos = router();
    await sweep(f, { fetchers: pos.fetchers });
    expect(await dayDates(f.byName('Alpha').storeId), 'nothing before the link date').toEqual(['2027-01-11', '2027-01-12']);
  });
  it('4c: a store with nothing imported for 10 days -> the 7 most recent days only (06-12 Jan), capped', async () => {
    const f = await fixture('t4cap', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    const pos = router();
    await sweep(f, { fetchers: pos.fetchers });
    expect(await dayDates(f.byName('Alpha').storeId)).toEqual(range(WINDOW_START, YESTERDAY));
  });
  it('4d: holes are filled and existing days left alone (days exist on 9 and 12 Jan -> imports 6, 7, 8, 10, 11)', async () => {
    const f = await fixture('t4hole', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    const a = f.byName('Alpha');
    await humanImport(f, a.storeId, '2027-01-09');
    await humanImport(f, a.storeId, '2027-01-12');
    const pos = router();
    await sweep(f, { fetchers: pos.fetchers });
    expect(pos.salesDates()).toEqual(['2027-01-06', '2027-01-07', '2027-01-08', '2027-01-10', '2027-01-11']);
    const run = await lastRun(f.orgId);
    expect([run.posted_count, run.skipped_count]).toEqual([5, 2]);
  });
});

describe('4b - a gap beyond the window is said, never silent', () => {
  it('previous run 10 days ago -> a FAILURE line per linked store naming the 3 dates the timer will never reach (3, 4, 5 Jan)', async () => {
    const f = await fixture('t4b', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    await sql`insert into scheduler_runs (org_id, job, period, started_at, finished_at, posted_count, skipped_count, failed_count, outcome, trigger)
              values (${f.orgId}, 'pos_day_import', '2027-01', '2027-01-03T04:00:00Z', '2027-01-03T04:01:00Z', 1, 0, 0, 'ok', 'cron')`;
    const pos = router();
    await sweep(f, { fetchers: pos.fetchers });
    const run = await lastRun(f.orgId);
    const gap = failuresOf(run).filter((l) => l.subjectId === f.byName('Alpha').storeId);
    expect(gap, 'one failure line for the store').toHaveLength(1);
    for (const d of ['2027-01-03', '2027-01-04', '2027-01-05']) expect(mentions(text(gap[0]!), d), `names ${d}: ${text(gap[0]!)}`).toBe(true);
    expect(mentions(text(gap[0]!), '2027-01-06'), 'does not name a date the window reaches').toBe(false);
    expect(run.outcome, 'posted > 0 and a failure line: partial').toBe('partial');
  });
  it('first-ever run -> the same dates as a NOTICE, not a failure', async () => {
    const f = await fixture('t4bfirst', [{ name: 'Alpha', linkedOn: '2027-01-03' }]);
    const pos = router();
    const result = await sweep(f, { fetchers: pos.fetchers });
    const run = await lastRun(f.orgId);
    const gap = noticesOf(run).filter((l) => l.subjectId === f.byName('Alpha').storeId && mentions(text(l), '2027-01-03'));
    expect(gap, 'a notice naming the unreachable dates').toHaveLength(1);
    for (const d of ['2027-01-04', '2027-01-05']) expect(mentions(text(gap[0]!), d)).toBe(true);
    expect(failuresOf(run)).toEqual([]);
    expect(result.hadFailures).toBe(false);
  });
  it('control: previous run yesterday -> no gap line at all', async () => {
    const f = await fixture('t4bnone', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    await sql`insert into scheduler_runs (org_id, job, period, started_at, finished_at, posted_count, skipped_count, failed_count, outcome, trigger)
              values (${f.orgId}, 'pos_day_import', '2027-01', '2027-01-11T22:00:00Z', '2027-01-11T22:01:00Z', 1, 0, 0, 'ok', 'cron')`;
    await sweep(f, { fetchers: router().fetchers });
    const run = await lastRun(f.orgId);
    expect(failuresOf(run)).toEqual([]);
    expect(noticesOf(run).filter((l) => /3 Jan|2027-01-03|Jan 3/.test(text(l)))).toEqual([]);
  });
});

describe('5 - "yesterday" is the MANILA calendar day', () => {
  it('23:59 Manila (15:59Z) on 12 Jan: today (12 Jan) is never imported; the last day is 11 Jan', async () => {
    const f = await fixture('t5a', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    const pos = router();
    await sweep(f, { now: '2027-01-12T15:59:00.000Z', fetchers: pos.fetchers });
    const fetched = pos.salesDates();
    expect(fetched).not.toContain('2027-01-12');
    expect(fetched[fetched.length - 1]).toBe('2027-01-11');
  });
  it('00:30 Manila on 13 Jan (= 16:30Z on 12 Jan): yesterday is 12 Jan, not 11 (a UTC clock would say 11)', async () => {
    const f = await fixture('t5b', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    const pos = router();
    await sweep(f, { now: '2027-01-12T16:30:00.000Z', fetchers: pos.fetchers });
    const fetched = pos.salesDates();
    expect(fetched[fetched.length - 1]).toBe('2027-01-12');
    expect(fetched).not.toContain('2027-01-13');
  });
});

describe('6 - a voided date is a manager\'s decision, not the timer\'s', () => {
  it('a voided day in the window is skipped: no refusal, no new day, POS not asked for it', async () => {
    const f = await fixture('t6', [{ name: 'Alpha', linkedOn: YESTERDAY }]);
    const a = f.byName('Alpha');
    const { id } = await humanImport(f, a.storeId, YESTERDAY);
    await asOrg(f.orgId, (tx) => voidSalesDay(tx, f.manager, id, 'imported by mistake'));
    const pos = router();
    const result = await sweep(f, { fetchers: pos.fetchers });
    const rows = await days(a.storeId);
    expect(rows.map((d) => [d.id, d.status])).toEqual([[id, 'voided']]);
    expect(pos.calls).toHaveLength(0);
    const run = await lastRun(f.orgId);
    expect([run.posted_count, run.skipped_count, run.failed_count]).toEqual([0, 1, 0]);
    expect(result.hadFailures).toBe(false);
  });
});

describe('7 - only LIVE links are visited', () => {
  it('an unlinked store (T-382) and a never-linked store are untouched', async () => {
    const f = await fixture('t7', [
      { name: 'Alpha', linkedOn: YESTERDAY },
      { name: 'Bravo', linkedOn: YESTERDAY, unlinked: true },
      { name: 'Charlie', linked: false },
    ]);
    const pos = router();
    await sweep(f, { fetchers: pos.fetchers });
    expect(await dayDates(f.byName('Alpha').storeId)).toEqual([YESTERDAY]);
    expect(await dayDates(f.byName('Bravo').storeId), 'unlinked store').toEqual([]);
    expect(await dayDates(f.byName('Charlie').storeId), 'never-linked store').toEqual([]);
    expect(pos.forStore(f.byName('Bravo').posStoreId), 'POS never asked about the unlinked store').toHaveLength(0);
    expect(new Set(pos.calls.map((c) => c.posStoreId))).toEqual(new Set([f.byName('Alpha').posStoreId]));
  });
});

describe('8 - one store\'s refusal never stops the next', () => {
  it('Alpha has an unmapped POS method: a failure line (store, date, the import\'s own sentence); Bravo still imports; outcome partial; the run reports failures', async () => {
    const f = await fixture('t8', [{ name: 'Alpha', linkedOn: YESTERDAY }, { name: 'Bravo', linkedOn: YESTERDAY }]);
    const a = f.byName('Alpha');
    const b = f.byName('Bravo');
    const pos = router({ [a.posStoreId]: { figures: () => ({ ...D1_FIGURES, paidTotal: 1150, methods: { Cash: 700, GCash: 350, Maya: 100 } }) } });
    const result = await sweep(f, { fetchers: pos.fetchers });

    expect(await dayDates(b.storeId), 'Bravo (after the failing store) still imports').toEqual([YESTERDAY]);
    expect(await dayDates(a.storeId), 'Alpha wrote nothing').toEqual([]);
    expect(await feeds(a.storeId), 'a refused derivation stores no feed').toHaveLength(0);
    const run = await lastRun(f.orgId);
    expect([run.posted_count, run.failed_count, run.outcome]).toEqual([1, 1, 'partial']);
    const fail = failuresOf(run);
    expect(fail).toHaveLength(1);
    expect(fail[0]!.subjectId, 'subjectId is the v2 store id').toBe(a.storeId);
    expect(text(fail[0]!)).toContain('Alpha');
    expect(mentions(text(fail[0]!), YESTERDAY), text(fail[0]!)).toBe(true);
    expect(text(fail[0]!), 'the import\'s own sentence, not a reworded one').toMatch(/POS took .*"Maya"/);
    expect(result.hadFailures, 'the script exits 1 on this').toBe(true);
  });
});

describe('9 - a day POS has no sales for is a notice, not an alarm', () => {
  it('found:false -> a notice naming the store and date ("will be asked again tomorrow"), outcome ok, nothing written, hadFailures false', async () => {
    const f = await fixture('t9', [{ name: 'Alpha', linkedOn: YESTERDAY }]);
    const a = f.byName('Alpha');
    const pos = router({ [a.posStoreId]: { closed: () => true } });
    const result = await sweep(f, { fetchers: pos.fetchers });
    const run = await lastRun(f.orgId);
    expect(failuresOf(run)).toEqual([]);
    expect([run.outcome, run.failed_count, run.posted_count]).toEqual(['ok', 0, 0]);
    const n = noticesOf(run).find((l) => l.subjectId === a.storeId && mentions(text(l), YESTERDAY));
    expect(n, `a notice for ${YESTERDAY}`).toBeTruthy();
    expect(text(n!)).toContain('Alpha');
    expect(text(n!)).toMatch(/no sales yet/i);
    expect(text(n!)).toMatch(/asked again tomorrow/i);
    expect(await dayDates(a.storeId)).toEqual([]);
    expect(await feeds(a.storeId), 'found:false writes no feed batch').toHaveLength(0);
    expect(result.hadFailures).toBe(false);
  });
  it('...and it is retried the next morning: POS has synced by then, so the day imports', async () => {
    const f = await fixture('t9retry', [{ name: 'Alpha', linkedOn: YESTERDAY }]);
    const a = f.byName('Alpha');
    await sweep(f, { fetchers: router({ [a.posStoreId]: { closed: () => true } }).fetchers });
    await stampLastRun(f.orgId, NOW);
    const pos = router();
    await sweep(f, { now: '2027-01-13T22:00:00.000Z', fetchers: pos.fetchers });
    expect(await dayDates(a.storeId), 'the 12th (retried) and the 13th').toEqual(['2027-01-12', '2027-01-13']);
  });
  it('9b: importSalesDay with ifAbsent returns { notFound: true } on found:false and writes nothing; without ifAbsent it throws (typed outcome, no sentence matching)', async () => {
    const f = await fixture('t9b', [{ name: 'Alpha' }]);
    const a = f.byName('Alpha');
    const pos = router({ [a.posStoreId]: { closed: () => true } });
    const r = await asOrg(f.orgId, (tx) => callImport(tx, f.adminA, { storeId: a.storeId, businessDate: YESTERDAY, ifAbsent: true, source: 'cron' }, pos.fetchers));
    expect(r).toMatchObject({ notFound: true });
    expect(await days(a.storeId)).toHaveLength(0);
    expect(await feeds(a.storeId)).toHaveLength(0);
    const thrown = await asOrg(f.orgId, (tx) => callImport(tx, f.adminA, { storeId: a.storeId, businessDate: YESTERDAY }, pos.fetchers)).then(() => null, (e) => e);
    expect(thrown, 'control: the web path still refuses a no-data day').toBeTruthy();
  });
});

describe('10 - unreachable stops that STORE, not the others; not configured stops the org', () => {
  it('Alpha answers 403: ONE failure line for Alpha naming 403 (never the body), no further fetches for Alpha, Bravo still imports all 7 days', async () => {
    const f = await fixture('t10', [{ name: 'Alpha' }, { name: 'Bravo' }]);
    const a = f.byName('Alpha');
    const b = f.byName('Bravo');
    const pos = router({
      [a.posStoreId]: { fail: new PosUnreachableError('POS /api/external/sales returned 403: SECRETBODY-store-not-in-key-map') },
    });
    const result = await sweep(f, { fetchers: pos.fetchers });

    expect(pos.forStore(a.posStoreId), 'no retry per date: one call, then Alpha is abandoned for this run').toHaveLength(1);
    expect(await dayDates(b.storeId), 'one store\'s 403 must not halt the others').toEqual(range(WINDOW_START, YESTERDAY));
    const run = await lastRun(f.orgId);
    const fail = failuresOf(run);
    expect(fail, 'one line, not seven').toHaveLength(1);
    expect(fail[0]!.subjectId).toBe(a.storeId);
    expect(text(fail[0]!)).toContain('Alpha');
    expect(text(fail[0]!), 'the HTTP status, so a 403 reads as the key-map problem it is').toContain('403');
    expect(text(fail[0]!), 'status only: never a response body').not.toContain('SECRETBODY');
    expect(JSON.stringify(run.failures), 'and never the key').not.toMatch(/x-api-key|POS_API_KEY/i);
    expect(run.outcome).toBe('partial');
    expect(result.hadFailures).toBe(true);
  });
  it('POS not configured: one line for the org, and POS is not asked again', async () => {
    const f = await fixture('t10nc', [{ name: 'Alpha' }, { name: 'Bravo' }]);
    const pos = router({
      [f.byName('Alpha').posStoreId]: { fail: new PosNotConfiguredError() },
      [f.byName('Bravo').posStoreId]: { fail: new PosNotConfiguredError() },
    });
    const result = await sweep(f, { fetchers: pos.fetchers });
    expect(pos.calls, 'the first call proves the server has no POS settings; nothing else is tried').toHaveLength(1);
    const run = await lastRun(f.orgId);
    expect(failuresOf(run), 'one line for the org').toHaveLength(1);
    expect(run.outcome).toBe('failed');
    expect(result.hadFailures).toBe(true);
    for (const s of f.stores) expect(await dayDates(s.storeId)).toEqual([]);
  });
});

describe('10b - the recheck\'s result is used, and never run in a dry run', () => {
  async function withVerifiedEarlierDay() {
    const f = await fixture('t10b', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    const a = f.byName('Alpha');
    const { id } = await humanImport(f, a.storeId, '2027-01-08');
    const submitter = await mkSubmitter(sql, f.orgId, [a.storeId], 'Submitter');
    await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, id, submitter));
    return { f, a };
  }
  it('a day the recheck cannot refresh (verified 8 Jan, before the newest import) -> a notice naming the store and date; the run is still ok', async () => {
    const { f, a } = await withVerifiedEarlierDay();
    const pos = router({ [a.posStoreId]: { onCall: (kind, date) => { if (date === '2027-01-08') throw new PosUnreachableError('POS /sales returned 500'); } } });
    const result = await sweep(f, { fetchers: pos.fetchers });
    expect(pos.salesDates(), 'the recheck asked POS about the verified 8 Jan (imports skip it)').toContain('2027-01-08');
    const run = await lastRun(f.orgId);
    const n = noticesOf(run).find((l) => l.subjectId === a.storeId && mentions(text(l), '2027-01-08'));
    expect(n, `a notice for 8 Jan; lines: ${JSON.stringify(run.failures)}`).toBeTruthy();
    expect(text(n!)).toContain('Alpha');
    expect(failuresOf(run), 'a recheck problem is a notice, not a failure').toEqual([]);
    expect(run.outcome).toBe('ok');
    expect(result.hadFailures).toBe(false);
  });
  it('dry run: the recheck is not called (POS is never asked about the verified 8 Jan)', async () => {
    const { f, a } = await withVerifiedEarlierDay();
    const pos = router();
    await sweep(f, { dryRun: true, fetchers: pos.fetchers });
    expect(pos.forStore(a.posStoreId).length, 'a dry run still tries the would-import dates').toBeGreaterThan(0);
    expect(pos.salesDates(a.posStoreId), 'but never the recheck of 8 Jan').not.toContain('2027-01-08');
  });
});

describe('11 - the timer acts as the person who vouched for the link, through their real permission', () => {
  it('actor = the link\'s updated_by (Admin B), not its creator (Admin A): created_by and the feed\'s fetched_by', async () => {
    const f = await fixture('t11a', [{ name: 'Alpha', linkedOn: YESTERDAY, updatedBy: 'adminB' }]);
    await sweep(f, { fetchers: router().fetchers });
    const [d] = await days(f.byName('Alpha').storeId);
    expect(d!.created_by).toBe(f.adminBId);
    expect((await feeds(f.byName('Alpha').storeId)).every((x) => x.fetched_by === f.adminBId)).toBe(true);
  });
  it('with no updated_by the creator acts (Admin A)', async () => {
    const f = await fixture('t11a2', [{ name: 'Alpha', linkedOn: YESTERDAY }]);
    await sweep(f, { fetchers: router().fetchers });
    expect((await days(f.byName('Alpha').storeId))[0]!.created_by).toBe(f.adminAId);
  });
  it('that person loses admin: a failure line naming the store, nothing written for it; the other store (other linker) still imports', async () => {
    const f = await fixture('t11b', [
      { name: 'Alpha', linkedOn: YESTERDAY, creator: 'adminA' },
      { name: 'Bravo', linkedOn: YESTERDAY, creator: 'adminB' },
    ]);
    await sql`update person_roles set role = 'staff' where person_id = ${f.adminAId}`;
    const pos = router();
    const result = await sweep(f, { fetchers: pos.fetchers });
    const run = await lastRun(f.orgId);
    const fail = failuresOf(run);
    expect(fail).toHaveLength(1);
    expect(fail[0]!.subjectId).toBe(f.byName('Alpha').storeId);
    expect(text(fail[0]!)).toContain('Alpha');
    expect(await days(f.byName('Alpha').storeId), 'nothing written for the demoted actor\'s store').toHaveLength(0);
    expect(await feeds(f.byName('Alpha').storeId)).toHaveLength(0);
    expect(await dayDates(f.byName('Bravo').storeId), 'a failure never stops the next store').toEqual([YESTERDAY]);
    expect(result.hadFailures).toBe(true);
  });
});

describe('12 - the activity log says the timer did it', () => {
  it('one sales_day.auto_imported row per import: source cron, the store, the day, the actor of record; a web import writes none', async () => {
    const f = await fixture('t12', [{ name: 'Alpha', linkedOn: '2027-01-11' }, { name: 'Bravo', linkedOn: '2027-01-12' }]);
    await sweep(f, { fetchers: router().fetchers });
    const rows = await autoImportRows(f.orgId);
    expect(rows, '2 + 1 imports, one row each').toHaveLength(3);
    const allDays = [...(await days(f.byName('Alpha').storeId)), ...(await days(f.byName('Bravo').storeId))];
    expect(new Set(rows.map((r) => r.entity_id))).toEqual(new Set(allDays.map((d) => d.id)));
    for (const r of rows) {
      expect(r.source).toBe('cron');
      expect(r.actor_person_id).toBe(f.adminAId);
      expect([r.category, r.sensitivity]).toEqual(['money', 'normal']);
      expect(f.storeIds).toContain(r.store_id);
    }
    // A web import (no options) writes no such row.
    const g = await fixture('t12web', [{ name: 'Alpha' }]);
    await humanImport(g, g.byName('Alpha').storeId, YESTERDAY);
    expect(await autoImportRows(g.orgId), 'the web import is audited as the web, not as the timer').toHaveLength(0);
  });
  it('--manual runs audit as source manual', async () => {
    const f = await fixture('t12m', [{ name: 'Alpha', linkedOn: YESTERDAY }]);
    await sweep(f, { trigger: 'manual', fetchers: router().fetchers });
    expect((await autoImportRows(f.orgId)).map((r) => r.source)).toEqual(['manual']);
    expect((await lastRun(f.orgId)).trigger).toBe('manual');
  });
});

describe('13 - dry run commits nothing', () => {
  it('sales_days, feeds, audit rows and scheduler_runs are untouched; the would-import dates are listed', async () => {
    const f = await fixture('t13', [{ name: 'Alpha', linkedOn: '2027-01-10' }]);
    const a = f.byName('Alpha');
    const pos = router();
    const result = await sweep(f, { dryRun: true, fetchers: pos.fetchers });
    expect(pos.calls.length, 'a dry run really fetches (it has to, to know what would refuse)').toBeGreaterThan(0);
    expect(await days(a.storeId)).toHaveLength(0);
    expect(await feeds(a.storeId)).toHaveLength(0);
    expect(await autoImportRows(f.orgId)).toHaveLength(0);
    expect(await runs(f.orgId), 'no scheduler_runs row for a dry run').toHaveLength(0);
    const out = JSON.stringify(result);
    for (const d of ['2027-01-10', '2027-01-11', '2027-01-12']) expect(mentions(out, d), `the output lists ${d}: ${out}`).toBe(true);
  });
});

describe('14 - the run record', () => {
  it('job pos_day_import, period = the MANILA month of the run (YYYY-MM): 01:30 Manila on 1 Feb is 2027-02 though UTC says January', async () => {
    const f = await fixture('t14', [{ name: 'Alpha', linkedOn: '2027-01-30' }]);
    await sweep(f, { now: '2027-01-31T17:30:00.000Z', fetchers: router().fetchers });
    const run = await lastRun(f.orgId);
    expect([run.job, run.period]).toEqual(['pos_day_import', '2027-02']);
    expect(run.period).toMatch(/^\d{4}-\d{2}$/);
  });
  it('migration 0209 widens the CHECK to the new name and still rejects a made-up one', async () => {
    const f = await fixture('t14chk', [{ name: 'Alpha' }]);
    await sql`insert into scheduler_runs (org_id, job, period) values (${f.orgId}, 'pos_day_import', '2027-01')`; // accepted
    await expect(sql`insert into scheduler_runs (org_id, job, period) values (${f.orgId}, 'bogus', '2027-01')`).rejects.toThrow(/scheduler_runs_job_check/);
  });
});

describe('15 - a pile of unverified drafts is said', () => {
  it('4 imported days still open -> a notice naming the store (the timer bypasses the create-block, so the backlog must be spoken)', async () => {
    const f = await fixture('t15', [{ name: 'Davao', linkedOn: '2027-01-09' }]);
    await sweep(f, { fetchers: router().fetchers });
    const run = await lastRun(f.orgId);
    const n = noticesOf(run).find((l) => l.subjectId === f.byName('Davao').storeId && /waiting/i.test(text(l)));
    expect(n, `a backlog notice; lines: ${JSON.stringify(run.failures)}`).toBeTruthy();
    expect(text(n!)).toContain('Davao');
    expect(text(n!)).toMatch(/\b4\b/);
    expect(failuresOf(run)).toEqual([]);
  });
  it('control: 3 imported days -> no backlog notice (the threshold is "more than 3")', async () => {
    const f = await fixture('t15c', [{ name: 'Davao', linkedOn: '2027-01-10' }]);
    await sweep(f, { fetchers: router().fetchers });
    const run = await lastRun(f.orgId);
    expect(noticesOf(run).filter((l) => /waiting/i.test(text(l)))).toEqual([]);
  });
});

// ---- Audit 2026-10-17 findings on day-import-job.ts (pinned RED until the builder fixes them) ---------------------
/** 06:00 Manila on `isoDate`, as the injected clock. */
const morning = (isoDate: string): string => `${ago(isoDate, -1)}T22:00:00.000Z`;

describe('A1 - a long POS outage never lets the oldest missing date slide out of the window unsaid', () => {
  it('POS fails 9 mornings running (each run recorded), works on the 10th: EVERY date with no sales day that is older than the window is named in a gap line (kills: gap computed from the last run date)', async () => {
    const f = await fixture('a1', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    const a = f.byName('Alpha');
    for (let d = 5; d <= 13; d += 1) {
      const day = `2027-01-${String(d).padStart(2, '0')}`;
      const down = router({ [a.posStoreId]: { fail: new PosUnreachableError('POS /api/external/sales returned 503: down') } });
      await sweep(f, { now: morning(day), fetchers: down.fetchers });
      await stampLastRun(f.orgId, morning(day));
    }
    expect(await dayDates(a.storeId), 'precondition: nothing was imported during the outage').toEqual([]);

    // 10th morning (14 Jan): POS is back. Window = 7..13 Jan, so 1..6 Jan can never be reached by the timer.
    await sweep(f, { now: morning('2027-01-14'), fetchers: router().fetchers });
    const run = await lastRun(f.orgId);
    expect(await dayDates(a.storeId), 'the window itself was imported').toEqual(range('2027-01-07', '2027-01-13'));
    const said = (run.failures ?? []).filter((l) => l.subjectId === a.storeId).map(text).join(' | ');
    for (const d of range('2027-01-01', '2027-01-06')) {
      expect(mentions(said, d), `${d} has no sales day and is outside the window, so it must be named. Lines: ${said}`).toBe(true);
    }
  });
});

describe('A2 - a non-admin whose older unverified day blocks the create: ONE stopped line for the store, not one per date', () => {
  it('link vouched for by a store-scoped manager (cannot bypass the create-block); an older open day blocks every window date -> exactly one failure line for that store naming the blocker; the other store still imports (kills: SalesDayBlockedError not stopping the store)', async () => {
    const f = await fixture('a2', [{ name: 'Alpha', linkedOn: '2027-01-01' }, { name: 'Bravo', linkedOn: '2027-01-01' }]);
    const a = f.byName('Alpha');
    const b = f.byName('Bravo');
    // The blocker: an older day that stays open (imported by the org-wide fixture manager).
    await humanImport(f, a.storeId, '2027-01-05');
    // A manager scoped to Alpha only: not org-wide, so `close_period` (the bypass) is refused for them.
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Scoped Manager') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${a.storeId})`;
    await sql`update pos_v1_store_links set updated_by = ${p!.id}, updated_at = ${noonManila('2027-01-01')}::timestamptz where id = ${a.linkId}`;

    const pos = router();
    await sweep(f, { fetchers: pos.fetchers });
    const run = await lastRun(f.orgId);
    const fail = failuresOf(run).filter((l) => l.subjectId === a.storeId);
    expect(fail, `one line for the store, not one per date. Lines: ${JSON.stringify(failuresOf(run).map(text))}`).toHaveLength(1);
    expect(mentions(text(fail[0]!), '2027-01-05'), `the one line names the blocking day: ${text(fail[0]!)}`).toBe(true);
    expect(await dayDates(a.storeId), 'only the blocker exists for Alpha').toEqual(['2027-01-05']);
    expect(await dayDates(b.storeId), 'the other store is untouched by it').toEqual(range(WINDOW_START, YESTERDAY));
  });
});

describe('A3 - the run detail tells "already there before the run" apart from "a person beat the timer mid-run"', () => {
  // CONTRACT (chosen): `skipped_count` stays the total of both (tests 2, 4d, 6 pin it). The `detail` text must NOT call a
  // race skip "already there": it says "already there N" for days present when the run began, and names the
  // race count separately (wording free, but it must contain "race", "first", "beaten" or "person").
  it('5 days already present, one more committed by a person mid-fetch: skipped_count 6 total, detail says "already there 5" and names the race separately', async () => {
    const f = await fixture('a3', [{ name: 'Alpha', linkedOn: '2027-01-01' }]);
    const a = f.byName('Alpha');
    for (const d of range('2027-01-06', '2027-01-10')) await humanImport(f, a.storeId, d);
    const pos = router({
      [a.posStoreId]: {
        onCall: async (kind, date, n) => {
          if (kind === 'sales' && date === '2027-01-11' && n === 1) await humanImport(f, a.storeId, date, D2B_FIGURES);
        },
      },
    });
    const result = await sweep(f, { fetchers: pos.fetchers });
    const run = await lastRun(f.orgId);
    expect([run.posted_count, run.skipped_count, run.failed_count], 'one imported (12 Jan), six skipped in all').toEqual([1, 6, 0]);
    const detail = String((result.outcomes[0] as { detail?: string }).detail ?? '');
    expect(detail, `"already there" counts only the 5 present at the start. detail: ${detail}`).toMatch(/already there 5\b/);
    expect(detail, `the one race loss is named separately. detail: ${detail}`).toMatch(/\b(race|first|beaten|person)\b/i);
  });
});
