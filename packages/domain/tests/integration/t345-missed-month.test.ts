import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-345 — a missed month's depreciation/amortisation booked once in an open month counts as
 * that month's. `docs/tasks/345-missed-month-depreciation-adjustment.md` §4 File 1, D1.
 *
 * ⛔ RED until the builder lands `bookMissedMonth`/`missedMonths` (`packages/domain/src/missed-months/index.ts`,
 * §3.2) and migration 0161 (`missed_month_adjustments`, §3.1) and the §3.3 filter in `findings/index.ts`.
 *
 * Two different kinds of case live here, and they are deliberately built differently:
 *   - Cases about `bookMissedMonth` ITSELF (A1, A2, A6-A20) call the real function through `book()`
 *     below. Today that throws `TypeError: bookMissedMonth is not a function` — every domain export
 *     this file imports that does not exist yet resolves to `undefined` at the module boundary
 *     rather than a compile error, same posture as `t344-create-missing-period.test.ts`.
 *   - Cases about the §3.3 FINDINGS FILTER (A3, A4, A5, A17's positive half) never call
 *     `bookMissedMonth` at all — the filter's own contract (§3.3) is "every active subject that owes
 *     P has an EFFECTIVE ENTRY keyed for P. That entry may be P's own run posting or an adjustment
 *     naming P" — so a raw-SQL-posted journal entry with the right idempotency key is sufficient to
 *     simulate "already caught up" without needing the migration or the domain function to exist.
 *     Today's `periodicPostingsMissed` (repo/findings.ts) only asks `scheduler_runs` whether the RUN
 *     happened for period P, never whether any entry exists, so these fail with the finding still
 *     present regardless of the raw entry — `expected [...] to be empty`.
 *
 * A2b is a GUARD, not a feature test: it pins §1.3's PRE-EXISTING behaviour (one asset's failure in
 * a closed month rolls back every later month in the same run) and is expected GREEN today.
 *
 * Every decision goes through the real `authorize()`. Fixture shape follows
 * `t344-create-missing-period.test.ts`'s own conventions (`asOrg`, `uid`, per-test orgs, no global
 * truncate — this DB is a dedicated lane, `shareat_test_t345_tester`).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, fixedAssetsRepo, prepaidRepo, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { assignRole, elevateManager, type Actor } from '@shareat/auth';
import {
  buildSchedule,
  closeReadiness,
  createAsset,
  createPrepaidItem,
  disposeAsset,
  prepaidSchedule,
  reverseAmortisation,
  reverseEntry,
  runAmortisationAsSystem,
  runDepreciationAsSystem,
  bookMissedMonth,
  missedMonths,
} from '@shareat/domain';
import { money, type Money } from '@shareat/core/money';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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

/** Manila "today" and "the real current month + 1" (T-345 §4's own fixture instruction), read
 *  from Postgres so this file never goes stale — never `Date.now()` (DEF-283). */
async function manilaTodayRaw(): Promise<string> {
  const [row] = await sql<{ today: string }[]>`select (now() at time zone 'Asia/Manila')::date::text as today`;
  return row!.today;
}
function addMonths(yyyyMm: string, n: number): { year: number; month: number } {
  const [y, m] = yyyyMm.split('-').map(Number) as [number, number];
  const total = (y * 12 + (m - 1)) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}
function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
}

// legacy state built under replica role, as the cutover ETL would (0174's gap guard is origin-mode)
async function closeAsLegacy(orgId: string, adminId: string, starts: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = 'replica'`;
    await tx`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${adminId}
      where org_id = ${orgId} and starts_on = any(${starts}::date[])`;
  });
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
    values (${orgId}, ${startsOn}, ${endsOn}, ${opts.status ?? 'open'}, ${opts.closedAt ?? null}, ${opts.closedBy ?? null})`;
}
async function insertMonths(
  orgId: string,
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    await insertPeriod(orgId, `${y}-${String(m).padStart(2, '0')}-01`, monthEnd(y, m), opts);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

interface OrgFixture {
  orgId: string;
  storeId: string;
  adminId: string;
  admin: Actor;
  superAdmin: Actor;
  manager: Actor;
  staff: Actor;
}

/** One org, a store, chart of accounts, and four people — `t344`'s own `rolesFixture` shape. */
async function rolesFixture(hint: string): Promise<OrgFixture> {
  const code = uid(`t345-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  // T-346 S2 (R4.1): opening_date well before every asset/item date this file ever uses (A22's
  // 2025-06-01 is the earliest), so the exported `scheduleInputFor` `bookMissedMonth`/`missedMonths`
  // switch to (replacing the private `assetScheduleInput`) derives 'store_opening' in-service dates
  // equal to acquired_on, never HELD — this whole file depends on assets depreciating normally.
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Store', '2020-01-01') returning id`;
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return p!.id;
  };
  const adminId = await person('Admin', 'admin');
  const superAdminId = await person('Super Admin', 'super_admin');
  const managerId = await person('Manager', 'manager');
  const staffId = await person('Staff', 'staff');
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${store!.id})`;
  return {
    orgId,
    storeId: store!.id,
    adminId,
    admin: actor(orgId, adminId),
    superAdmin: actor(orgId, superAdminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}

/**
 * H3-like shape (T-344's own fixture): Jan-Mar closed, 04 MISSING, 05 closed, 06..(now+1) open.
 *
 * ⚠️ **Order matters, and it is the fixture's own words** ("Jan-Mar and May are posted, THEN
 * 2026-01..03 and 05 are closed"). Migration 0003's period-open trigger fires at POSTING time
 * (the UPDATE to `status='posted'`), not at INSERT — it is enforced identically whether the
 * caller went through `postEntry` or wrote the row directly, per bible §15.11 rule 3 ("the
 * database enforces the rules, not the service layer"). So every `poster` below must run while
 * Jan/Feb/Mar/May are still OPEN; only once every subject in the org has posted its history do
 * these months get closed and April's row removed entirely (a class-C hole, never present).
 */
async function buildHoleMonths(f: OrgFixture, posters: ((period: string) => Promise<void>)[]): Promise<void> {
  await insertMonths(f.orgId, 2026, 1, 2026, 5); // open — history posts into these below
  for (const period of ['2026-01', '2026-02', '2026-03', '2026-05']) {
    for (const post of posters) await post(period);
  }
  // April's row is removed BEFORE Jan-Mar/May close — the order-guard trigger (R1.2, migration
  // 0160) refuses an OPEN period starting before a period that is about to become closed, and
  // April (still open at this point) sits chronologically before May.
  await sql`delete from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-04-01'`;
  await closeAsLegacy(f.orgId, f.adminId, ['2026-01-01', '2026-02-01', '2026-03-01', '2026-05-01']);
  const today = await manilaTodayRaw();
  const end = addMonths(today.slice(0, 7), 1);
  await insertMonths(f.orgId, 2026, 6, end.year, end.month);
}
function depreciationPoster(f: OrgFixture, assetId: string): (period: string) => Promise<void> {
  return async (period) => {
    const sp = periodOf(DEPR_SCHEDULE, period);
    await postRawEntry({
      orgId: f.orgId,
      entryDate: sp.entryDate,
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:${period}`,
      debitCode: '6700',
      creditCode: '1590',
      amount: String(sp.amount),
      postedBy: f.adminId,
    });
  };
}
function amortisationPoster(f: OrgFixture, itemId: string): (period: string) => Promise<void> {
  return async (period) => {
    const sp = periodOf(AMORT_SCHEDULE, period);
    await postRawEntry({
      orgId: f.orgId,
      entryDate: sp.entryDate,
      sourceType: 'amortisation',
      sourceId: itemId,
      storeId: f.storeId,
      idempotencyKey: `prepaid:${itemId}:amortisation:${period}`,
      debitCode: '6750',
      creditCode: '1400',
      amount: String(sp.amount),
      postedBy: f.adminId,
    });
  };
}

/** ₱24,000, 24 months, no salvage, acquired 2026-01-15 — 1,000.00/month exactly, spec §4. */
const DEPR_SCHEDULE = buildSchedule({
  startsOn: '2026-01-15',
  cost: money('24000.00'),
  salvageValue: money('0'),
  usefulLifeMonths: 24,
  interval: 'monthly',
});
const AMORT_SCHEDULE = prepaidSchedule({
  coverageStartDate: '2026-01-15',
  coverageMonths: 24,
  totalCost: '24000.00',
});
const periodOf = <T extends { period: string }>(schedule: T[], p: string): T => schedule.find((x) => x.period === p)!;

async function accountId(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
  return row!.id;
}

/** Posts one entry directly (bypassing `postEntry`), mirroring `depreciate.ts`'s own two-line
 *  shape — used to build "already posted" months a domain call cannot construct out of order
 *  (§1.3: one failing period rolls back every later one in the same asset's transaction). */
async function postRawEntry(input: {
  orgId: string;
  entryDate: string;
  sourceType: 'depreciation' | 'amortisation';
  sourceId: string;
  storeId: string;
  idempotencyKey: string;
  debitCode: string;
  creditCode: string;
  amount: string;
  postedBy: string;
  /** Overrides the default two-line DR/CR shape entirely, still balanced by the caller. */
  lines?: { code: string; debit: string; credit: string }[];
}): Promise<string> {
  const lineSpecs = input.lines ?? [
    { code: input.debitCode, debit: input.amount, credit: '0' },
    { code: input.creditCode, debit: '0', credit: input.amount },
  ];
  const accountIds = await Promise.all(lineSpecs.map((l) => accountId(input.orgId, l.code)));
  return sql.begin(async (tx) => {
    const [period] = await tx<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${input.orgId}
        and starts_on <= ${input.entryDate} and ends_on >= ${input.entryDate}`;
    if (!period) throw new Error(`postRawEntry: no fiscal period covers ${input.entryDate}`);
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${input.orgId}, ${input.entryDate}, ${period.id}, ${input.sourceType}, ${input.sourceId}, ${input.idempotencyKey}, 'fixture', ${input.postedBy}, 'draft')
      returning id`;
    for (let i = 0; i < lineSpecs.length; i++) {
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id)
        values (${entry!.id}, ${i + 1}, ${accountIds[i]!}, ${lineSpecs[i]!.debit}, ${lineSpecs[i]!.credit}, ${input.storeId})`;
    }
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
    return entry!.id;
  });
}

async function depreciableAsset(f: OrgFixture, over: Record<string, unknown> = {}): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createAsset(tx, f.admin, {
      storeId: f.storeId,
      name: 'Chiller',
      category: 'equipment',
      acquiredOn: '2026-01-15',
      cost: '24000.00',
      salvageValue: '0',
      usefulLifeMonths: 24,
      interval: 'monthly',
      ...over,
    } as Parameters<typeof createAsset>[2]),
  );
  return id;
}
async function prepaidItem(f: OrgFixture, over: Record<string, unknown> = {}): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createPrepaidItem(tx, f.admin, {
      storeId: f.storeId,
      name: 'Fire insurance 2026',
      category: 'insurance',
      coverageStartDate: '2026-01-15',
      coverageMonths: 24,
      totalCost: '24000.00',
      ...over,
    } as Parameters<typeof createPrepaidItem>[2]),
  );
  return id;
}

/** A hole-shaped org with an asset owing April, Jan/Feb/Mar/May already posted. */
async function assetHoleFixture(hint: string): Promise<{ f: OrgFixture; assetId: string }> {
  const f = await rolesFixture(hint);
  const assetId = await depreciableAsset(f);
  await buildHoleMonths(f, [depreciationPoster(f, assetId)]);
  return { f, assetId };
}
/** Same shape, its own org (R1.9 — the DB trigger checks the line accounts, so amortisation and
 *  depreciation fixtures never share an org). */
async function prepaidHoleFixture(hint: string): Promise<{ f: OrgFixture; itemId: string }> {
  const f = await rolesFixture(hint);
  const itemId = await prepaidItem(f);
  await buildHoleMonths(f, [amortisationPoster(f, itemId)]);
  return { f, itemId };
}

/**
 * D1's own fixture — the same period SHAPE as `assetHoleFixture` (Jan-Mar closed, 04 missing, 05
 * closed, 06..(now+1) open) but with NO pre-posted history. D1 constructs every entry it probes
 * itself, and reusing `assetHoleFixture`'s own Jan/Feb/Mar/May postings would collide on their
 * idempotency keys with entries D1 posts under the same asset for the same periods.
 */
async function d1Fixture(hint: string): Promise<{ f: OrgFixture; assetId: string }> {
  const f = await rolesFixture(hint);
  const assetId = await depreciableAsset(f);
  await buildHoleMonths(f, []);
  return { f, assetId };
}

const book = (
  actorArg: Actor,
  input: {
    schedule: 'depreciation' | 'amortisation';
    subjectId: string;
    belongsToPeriod: string;
    reason: string;
    bookOn?: string;
  },
) => withOrgPrincipal(actorArg.orgId, (tx) => bookMissedMonth(tx, actorArg, input));

async function linkRow(orgId: string, journalEntryId?: string) {
  if (journalEntryId) {
    const [row] = await sql<{ id: string; belongs_to_period: string; journal_entry_id: string }[]>`
      select id, belongs_to_period, journal_entry_id from missed_month_adjustments
      where org_id = ${orgId} and journal_entry_id = ${journalEntryId}`;
    return row;
  }
  return undefined;
}
/** Posted entries whose idempotency key matches the LIKE pattern (a period and all its #n revisions). */
async function effectivePosted(orgId: string, keyLike: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId} and idempotency_key like ${keyLike} and status = 'posted'`;
  return row!.n;
}
async function linkCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from missed_month_adjustments where org_id = ${orgId}`;
  return row!.n;
}
async function entryCountForKey(orgId: string, idempotencyKey: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`;
  return row!.n;
}
async function entryRow(orgId: string, idempotencyKey: string) {
  const [row] = await sql<{ id: string; entry_date: string; memo: string; status: string }[]>`
    select id, entry_date::text as entry_date, memo, status from journal_entries
    where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`;
  return row;
}
/**
 * The migration's own guard-trigger refusal shape — SQLSTATE `P0001` (a plain `RAISE EXCEPTION`,
 * §3.1 checks 1-6), message prefixed `missed_month_adjustments: `. Tighter than a bare
 * `.rejects.toThrow()`, which passes VACUOUSLY today on 42P01 ("relation ... does not exist")
 * regardless of which check a case actually means to probe — orchestrator CHANGES, 2026-09-26.
 *
 * ⭐ `detail` pins the SPECIFIC check's own wording (0161's own RAISE EXCEPTION text) — without it
 * a fixture that accidentally trips a DIFFERENT check (e.g. "wrong source_id" secretly failing
 * check 4 instead of check 1) would still pass, proving nothing about the case it claims to test.
 */
async function expectGuardRefusal(promise: Promise<unknown>, detail: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: 'P0001',
    message: expect.stringMatching(detail),
  });
}

async function linesFor(entryId: string) {
  return sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, jl.debit, jl.credit from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by jl.line_no`;
}

// =================================================================================================
// A1, A2, A2b — the happy path, and the guard behaviour it relies on
// =================================================================================================

describe('A1 — admin books the asset for 2026-04', () => {
  it('one entry DR 6700 / CR 1590 = 1,000.00, key asset:{id}:depreciation:2026-04, memo [prior period]; link row', async () => {
    const { f, assetId } = await assetHoleFixture('a1');
    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'catch up' });

    const key = `asset:${assetId}:depreciation:2026-04`;
    expect(await entryCountForKey(f.orgId, key)).toBe(1);
    const entry = await entryRow(f.orgId, key);
    expect(entry?.status).toBe('posted');
    expect(entry?.memo).toMatch(/^\[prior period\]/);
    const lines = await linesFor(entry!.id);
    expect(lines.map((l) => `${l.code} ${l.debit}/${l.credit}`)).toEqual(['6700 1000.00/0.00', '1590 0.00/1000.00']);

    const row = await linkRow(f.orgId, entry!.id);
    expect(row?.belongs_to_period).toBe('2026-04');

    // NEGATIVE — no row landed in any closed period (Jan-Mar, May).
    const others = await sql<{ n: number }[]>`
      select count(*)::int as n from journal_entries where org_id = ${f.orgId} and source_id = ${assetId}
        and entry_date::text >= '2026-01-01' and entry_date::text <= '2026-05-31' and idempotency_key = ${key}`;
    expect(others[0]!.n).toBe(0);
  });
});

describe('A2 — runDepreciationAsSystem catches up after the adjustment; April no-ops', () => {
  it('June..last month post; the asset is not in failed; April is not re-posted', async () => {
    const { f, assetId } = await assetHoleFixture('a2');
    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'catch up' });

    const today = await manilaTodayRaw();
    const lastMonth = addMonths(today.slice(0, 7), -1);
    const through = `${lastMonth.year}-${String(lastMonth.month).padStart(2, '0')}`;
    const result = await runDepreciationAsSystem(f.orgId, { through });

    expect(result.failed.find((x) => x.assetId === assetId)).toBeUndefined();
    // NEGATIVE — still exactly one 2026-04 entry.
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-04`)).toBe(1);

    const accumulated = await asOrg(f.orgId, (tx) => fixedAssetsRepo.accumulatedFromLedger(tx, f.orgId, assetId));
    const expected = periodOf(DEPR_SCHEDULE, through).accumulatedAfter;
    expect(String(accumulated)).toBe(String(expected));
  });
});

describe('A2b — GUARD: before A1, the asset fails on 2026-04 and posts no later month', () => {
  it('§1.3 pre-existing behaviour: one closed-period failure rolls back the whole per-asset run', async () => {
    const { f, assetId } = await assetHoleFixture('a2b');
    const result = await runDepreciationAsSystem(f.orgId, { through: '2026-06' });
    expect(result.failed.map((x) => x.assetId)).toContain(assetId);
    // NEGATIVE — June (owed, open) did NOT post because April (owed, missing period) failed first
    // inside the same per-asset transaction.
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-06`)).toBe(0);
  });
});

// =================================================================================================
// A3-A5 — closeReadiness is a filter over one feed (§3.3). No call to bookMissedMonth: an
// "effective entry keyed for P" is exactly what a raw-SQL-posted entry already is.
// =================================================================================================

function depBlocking(blocking: { key: string }[], period: string) {
  return blocking.filter((b) => b.key === `depreciationNotBooked:${period}`);
}

describe('A3 — closeReadiness(2026-04) after an effective entry exists for it', () => {
  it('before: the finding is present. after: it is dropped', async () => {
    const { f, assetId } = await assetHoleFixture('a3');
    const before = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, '2026-04'));
    expect(depBlocking(before.blocking, '2026-04').length).toBe(1);

    const sp = periodOf(DEPR_SCHEDULE, '2026-04');
    await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: String(sp.amount),
      postedBy: f.adminId,
    });

    const after = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, '2026-04'));
    expect(depBlocking(after.blocking, '2026-04')).toEqual([]);
  });
});

describe('A4 — two assets owe April, only one is caught up: the finding stays', () => {
  it('a second asset with no entry for 2026-04 keeps the finding present', async () => {
    const f = await rolesFixture('a4');
    const assetId = await depreciableAsset(f);
    const secondId = await depreciableAsset(f, { name: 'Second freezer' });
    await buildHoleMonths(f, [depreciationPoster(f, assetId), depreciationPoster(f, secondId)]);

    const sp = periodOf(DEPR_SCHEDULE, '2026-04');
    await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: String(sp.amount),
      postedBy: f.adminId,
    });

    const after = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, '2026-04'));
    expect(depBlocking(after.blocking, '2026-04').length).toBe(1);
  });
});

describe('A5 — no active asset owes 2026-04 (acquired 2026-07): the finding is dropped', () => {
  it('an asset with nothing owed for April never blocks April', async () => {
    const f = await rolesFixture('a5');
    await buildHoleMonths(f, []);
    await depreciableAsset(f, { acquiredOn: '2026-07-01' });

    const after = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, '2026-04'));
    expect(depBlocking(after.blocking, '2026-04')).toEqual([]);
  });
});

// =================================================================================================
// A6 — prepaid, its own org (R1.9)
// =================================================================================================

describe('A6 — admin books the prepaid item for 2026-04', () => {
  it('DR 6750 / CR 1400 = the schedule\'s April slice; postedPeriods contains 2026-04; the run then no-ops', async () => {
    const { f, itemId } = await prepaidHoleFixture('a6');
    await book(f.admin, { schedule: 'amortisation', subjectId: itemId, belongsToPeriod: '2026-04', reason: 'catch up' });

    const key = `prepaid:${itemId}:amortisation:2026-04`;
    expect(await entryCountForKey(f.orgId, key)).toBe(1);
    const entry = await entryRow(f.orgId, key);
    const lines = await linesFor(entry!.id);
    expect(lines.map((l) => `${l.code} ${l.debit}/${l.credit}`)).toEqual(['6750 1000.00/0.00', '1400 0.00/1000.00']);

    const posted = await asOrg(f.orgId, (tx) => prepaidRepo.postedPeriods(tx, f.orgId, itemId));
    expect(posted.has('2026-04')).toBe(true);

    const today = await manilaTodayRaw();
    const result = await runAmortisationAsSystem(f.orgId, addMonths(today.slice(0, 7), -1).year + '-' + String(addMonths(today.slice(0, 7), -1).month).padStart(2, '0'));
    expect(result.failed.find((x) => x.itemId === itemId)).toBeUndefined();
    // NEGATIVE — still exactly one 2026-04 entry.
    expect(await entryCountForKey(f.orgId, key)).toBe(1);
  });
});

// =================================================================================================
// A7-A11 — refusals
// =================================================================================================

describe('A7 — a second call for the same asset + month is refused', () => {
  it('/already booked for 2026-04/; still one entry, one link', async () => {
    const { f, assetId } = await assetHoleFixture('a7');
    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'first' });
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'second' }),
    ).rejects.toThrow(/already booked for 2026-04/);
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-04`)).toBe(1);
    expect(await linkCount(f.orgId)).toBe(1);
  });
});

describe('A8 — P is open (2026-06) is refused', () => {
  it('/2026-06 is open/', async () => {
    const { f, assetId } = await assetHoleFixture('a8');
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-06', reason: 'x' }),
    ).rejects.toThrow(/2026-06 is open/);
  });
});

describe('A9 — the subject owes nothing for the requested month', () => {
  it('/owes nothing for 2025-12/ — before acquisition', async () => {
    const f = await rolesFixture('a9');
    await insertMonths(f.orgId, 2025, 1, 2025, 12, { status: 'locked', closedAt: '2026-01-01T00:00:00Z', closedBy: f.adminId });
    await buildHoleMonths(f, []);
    const assetId = await depreciableAsset(f);
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2025-12', reason: 'x' }),
    ).rejects.toThrow(/owes nothing for 2025-12/);
  });
});

describe('A10 — a blank reason, and a disposed asset', () => {
  it('/reason is required/', async () => {
    const { f, assetId } = await assetHoleFixture('a10-reason');
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: '   ' }),
    ).rejects.toThrow(/reason is required/);
  });

  it('/is disposed/', async () => {
    const { f, assetId } = await assetHoleFixture('a10-disposed');
    await asOrg(f.orgId, (tx) =>
      disposeAsset(tx, f.admin, { assetId, disposedOn: '2026-06-01', reason: 'scrapped' }),
    );
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x' }),
    ).rejects.toThrow(/is disposed/);
  });
});

describe('A11 — bookOn inside closed 2026-05 is refused', () => {
  it('refused by the period trigger; no link row', async () => {
    const { f, assetId } = await assetHoleFixture('a11');
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x', bookOn: '2026-05-15' }),
    ).rejects.toThrow(/is closed/);
    expect(await linkCount(f.orgId)).toBe(0);
  });
});

// =================================================================================================
// A12 — T-344 end to end, its own org (R1.9)
// =================================================================================================

describe('A12 — after booking April, createMissingClosedPeriod for April succeeds', () => {
  it('the depreciation finding T-344 F13 left unasserted now clears', async () => {
    const { f, assetId } = await assetHoleFixture('a12');

    // Before: T-344's own F13 (blocked by the missed depreciation).
    const { createMissingClosedPeriod } = await import('@shareat/domain');
    await expect(
      withOrgPrincipal(f.orgId, (tx) =>
        createMissingClosedPeriod(tx, f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' }),
      ),
    ).rejects.toThrow(/depreciat/i);

    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'catch up' });

    const result = await withOrgPrincipal(f.orgId, (tx) =>
      createMissingClosedPeriod(tx, f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'fill' }),
    );
    expect(result.status).toBe('closed');
  });
});

// =================================================================================================
// A13-A15 — capability, and the adminless-manager fallback (R1.8)
// =================================================================================================

describe('A13-A14 — only admin and super_admin hold book_missed_month', () => {
  it('A13 — a manager with org-wide close_period may not', async () => {
    const { f, assetId } = await assetHoleFixture('a13');
    await expect(
      book(f.manager, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x' }),
    ).rejects.toThrow(/may not 'book_missed_month'/);
    expect(await linkCount(f.orgId)).toBe(0);
  });

  it('A13 — staff may not', async () => {
    const { f, assetId } = await assetHoleFixture('a13-staff');
    await expect(
      book(f.staff, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x' }),
    ).rejects.toThrow(/may not 'book_missed_month'/);
  });

  it('A14 — super_admin resolves', async () => {
    const { f, assetId } = await assetHoleFixture('a14');
    await book(f.superAdmin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x' });
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-04`)).toBe(1);
  });
});

describe('A15 — R1.8: an adminless-org manager is elevated; the same role in an org WITH an admin is not', () => {
  it('the elevated manager resolves', async () => {
    const f = await rolesFixture('a15-adminless');
    // The asset is created (as admin) and its history posted BEFORE the admin is revoked —
    // `createAsset` itself needs an active `manage_fixed_assets` holder, and the admin is the
    // only one at this point in the fixture.
    const assetId = await depreciableAsset(f);
    await buildHoleMonths(f, [depreciationPoster(f, assetId)]);

    // Revoke the fixture's own admin AND super_admin so the org holds neither — `hasActiveAdmin`
    // (access.ts:80, DEF-237) counts BOTH roles, so leaving the super_admin active would make this
    // org read as having an admin and the fallback below would never fire (orchestrator CHANGES,
    // 2026-09-26). `assignRole`'s own fallback (roles.ts:99-116) fires only AFTER the revoke,
    // checking "no active admin" at that instant.
    await sql`update person_roles set revoked_at = now()
      where org_id = ${f.orgId} and role in ('admin', 'super_admin') and revoked_at is null`;
    const [freshManager] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Elevated Manager') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${freshManager!.id}, ${f.storeId})`;
    await withOrgPrincipal(f.orgId, (tx) =>
      assignRole(tx, { personId: freshManager!.id, orgId: f.orgId, role: 'manager', grantedBy: null }),
    );

    await book(actor(f.orgId, freshManager!.id), {
      schedule: 'depreciation',
      subjectId: assetId,
      belongsToPeriod: '2026-04',
      reason: 'adminless catch-up',
    });
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-04`)).toBe(1);
  });

  it('the same role, org WITH an admin, is refused', async () => {
    const { f, assetId } = await assetHoleFixture('a15-with-admin');
    await expect(
      book(f.manager, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x' }),
    ).rejects.toThrow(/may not 'book_missed_month'/);
  });
});

// =================================================================================================
// A16 — T-368 S2 (DEF-435 lifted): a reversed adjustment CAN be booked again, as a revision (#2)
// =================================================================================================

describe('A16 — book, reverse, book again (T-368 S2: re-booking now succeeds)', () => {
  it('asset: the second booking succeeds under key ...:2026-04#2; two link rows, exactly one posted entry for the period', async () => {
    const { f, assetId } = await assetHoleFixture('a16-asset');
    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'first' });
    const entry = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-04`);
    await withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId: entry!.id, reason: 'correction', reversedBy: f.adminId }));

    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'retry' });
    const second = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-04#2`);
    expect(second?.status).toBe('posted');
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-04`))?.status).toBe('reversed');
    expect(await effectivePosted(f.orgId, `asset:${assetId}:depreciation:2026-04%`), 'exactly one effective (posted) entry for the period').toBe(1);
    expect(await linkCount(f.orgId)).toBe(2);
  });

  it('prepaid: the same — booked again as a revision, two links, one posted entry', async () => {
    const { f, itemId } = await prepaidHoleFixture('a16-prepaid');
    await book(f.admin, { schedule: 'amortisation', subjectId: itemId, belongsToPeriod: '2026-04', reason: 'first' });
    const entry = await entryRow(f.orgId, `prepaid:${itemId}:amortisation:2026-04`);
    await withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId: entry!.id, reason: 'correction', reversedBy: f.adminId }));

    await book(f.admin, { schedule: 'amortisation', subjectId: itemId, belongsToPeriod: '2026-04', reason: 'retry' });
    expect((await entryRow(f.orgId, `prepaid:${itemId}:amortisation:2026-04#2`))?.status, 'the retry is the #2 revision').toBe('posted');
    expect((await entryRow(f.orgId, `prepaid:${itemId}:amortisation:2026-04`))?.status).toBe('reversed');
    expect(await effectivePosted(f.orgId, `prepaid:${itemId}:amortisation:2026-04%`), 'exactly one effective (posted) entry for the period').toBe(1);
    expect(await linkCount(f.orgId)).toBe(2);
  });
});

// =================================================================================================
// A17 — R1.4: only subjects active today are counted
// =================================================================================================

describe('A17 — a second asset that also missed April is disposed in June', () => {
  it('the finding for 2026-04 drops once the ACTIVE asset is booked; the disposed one refuses booking', async () => {
    const f = await rolesFixture('a17');
    const assetId = await depreciableAsset(f);
    const disposedId = await depreciableAsset(f, { name: 'Written-off unit' });
    await buildHoleMonths(f, [depreciationPoster(f, assetId), depreciationPoster(f, disposedId)]);
    await asOrg(f.orgId, (tx) =>
      disposeAsset(tx, f.admin, { assetId: disposedId, disposedOn: '2026-06-10', reason: 'scrapped' }),
    );

    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'catch up' });
    const after = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, '2026-04'));
    expect(depBlocking(after.blocking, '2026-04')).toEqual([]);

    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: disposedId, belongsToPeriod: '2026-04', reason: 'x' }),
    ).rejects.toThrow(/is disposed/);
  });
});

// =================================================================================================
// A18 — R1.5: P < bookOn <= today (Manila)
// =================================================================================================

describe('A18 — bookOn = tomorrow (Manila) is refused', () => {
  it('/must be after 2026-04 and not after today/; nothing written', async () => {
    const { f, assetId } = await assetHoleFixture('a18');
    const today = await manilaTodayRaw();
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
      select ${f.orgId}, date_trunc('month', ${tomorrow}::date)::date,
        (date_trunc('month', ${tomorrow}::date) + interval '1 month - 1 day')::date, 'open'
      where not exists (
        select 1 from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${tomorrow}::date and ends_on >= ${tomorrow}::date
      )`;
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x', bookOn: tomorrow }),
    ).rejects.toThrow(/must be after 2026-04 and not after today/);
    expect(await linkCount(f.orgId)).toBe(0);
  });
});

// =================================================================================================
// A19 — R1.6: two concurrent bookers
// =================================================================================================

describe('A19 — two connections book the same asset and month at once', () => {
  it('exactly one entry and one link; the loser gets "already booked", not a raw 23505', async () => {
    const { f, assetId } = await assetHoleFixture('a19');
    const input = { schedule: 'depreciation' as const, subjectId: assetId, belongsToPeriod: '2026-04', reason: 'race' };
    const results = await Promise.allSettled([book(f.admin, input), book(f.admin, input)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0]!.reason)).toMatch(/already booked for 2026-04/);
    expect(String(rejected[0]!.reason)).not.toMatch(/23505/);
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-04`)).toBe(1);
    expect(await linkCount(f.orgId)).toBe(1);
  });
});

// =================================================================================================
// A20 — R1.1: postedDepreciationPeriods reads the month from the KEY, not entry_date
// =================================================================================================

describe('A20 — the asset page\'s booked months after A1', () => {
  it('["2026-01".."2026-05"], no duplicate of the current month', async () => {
    const { f, assetId } = await assetHoleFixture('a20');
    await book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'catch up' });

    const posted = await asOrg(f.orgId, (tx) => fixedAssetsRepo.postedDepreciationPeriods(tx, f.orgId, assetId));
    expect([...posted].sort()).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
  });
});

// =================================================================================================
// A21 — step 9's checkFullyAmortised must be gated on the SCHEDULE'S OWN LAST PERIOD, never
// belongsToPeriod (orchestrator-added, 2026-09-26). A 24-month item, every month posted except
// month 3 (reversed), month 3 then closed. Catching month 3 back up should finish the item.
// =================================================================================================

describe('A21 — a reversed middle month, caught up last, still finishes the item', () => {
  it('24 months, only 3 reversed and closed; booking 3 back in marks the item fully_amortised', async () => {
    const f = await rolesFixture('a21');
    // The full 24-month span, ALL open — the real run needs every one of them open to post through.
    await insertMonths(f.orgId, 2026, 1, 2027, 12);
    const itemId = await prepaidItem(f, { coverageStartDate: '2026-01-15', coverageMonths: 24, totalCost: '24000.00' });

    // Post every one of the 24 months via the REAL scheduled run — not raw SQL — while everything
    // is still open.
    const runResult = await runAmortisationAsSystem(f.orgId, '2027-12');
    expect(runResult.failed.find((x) => x.itemId === itemId)).toBeUndefined();
    expect(await entryCountForKey(f.orgId, `prepaid:${itemId}:amortisation:2026-03`)).toBe(1);

    // Reverse month 3 while its period is still open (reverseAmortisation's own requirement).
    await withOrgPrincipal(f.orgId, (tx) =>
      reverseAmortisation(tx, f.admin, { prepaidItemId: itemId, period: '2026-03', reason: 'correction' }),
    );
    const posted = await asOrg(f.orgId, (tx) => prepaidRepo.postedPeriods(tx, f.orgId, itemId));
    expect(posted.has('2026-03')).toBe(false);
    expect(posted.size).toBe(23);
    // The reversal put the item back to `active` (it had gone `fully_amortised` when the run
    // above posted month 24) — asserted directly, since that flip is `reverseAmortisation`'s own
    // documented behaviour, not this task's.
    const [afterReversal] = await sql<{ status: string }[]>`select status from prepaid_items where id = ${itemId}`;
    expect(afterReversal?.status).toBe('active');

    // Close Jan-Mar together — the order-guard trigger (R1.2) refuses an open period starting
    // before one that is closing, and Jan/Feb are chronologically before March.
    await closeAsLegacy(f.orgId, f.adminId, ['2026-01-01', '2026-02-01', '2026-03-01']);

    await book(f.admin, { schedule: 'amortisation', subjectId: itemId, belongsToPeriod: '2026-03', reason: 'catch up the reversed month' });

    const [afterBooking] = await sql<{ status: string }[]>`select status from prepaid_items where id = ${itemId}`;
    expect(afterBooking?.status).toBe('fully_amortised');
  });
});

// =================================================================================================
// A22 — R3.1: a month before the org's books began (its earliest fiscal_periods row) is neither
// listed nor bookable — it belongs in the opening balance, not a catch-up entry (double-counts
// 1590 otherwise). orchestrator-added, 2026-09-26.
// =================================================================================================

describe('A22 — a month before the org\'s earliest fiscal period', () => {
  it('missedMonths lists a genuine 2026 hole but excludes 2025-06..12; bookMissedMonth(2025-10) refuses; nothing written', async () => {
    const f = await rolesFixture('a22');
    // The org's earliest fiscal period is 2026-01 — nothing exists for 2025 at all. Jan-Apr
    // closed, nothing posted (genuine holes); May onward open.
    await insertMonths(f.orgId, 2026, 1, 2026, 4, { status: 'closed', closedAt: '2026-05-01T00:00:00Z', closedBy: f.adminId });
    const today = await manilaTodayRaw();
    const end = addMonths(today.slice(0, 7), 1);
    await insertMonths(f.orgId, 2026, 5, end.year, end.month);
    // Acquired 2025-06-01, so its schedule owes 2025-06..12 before the org's books even start, AND
    // 2026-01..04 after — genuinely closed, unposted holes.
    const assetId = await depreciableAsset(f, { acquiredOn: '2025-06-01' });

    const rows = await asOrg(f.orgId, (tx) => missedMonths(tx, f.orgId, '2026-04'));
    // Positive control — the listing mechanism itself works: a genuine 2026 hole IS listed. Without
    // this, an empty `pre2026` below could just as easily mean "missedMonths lists nothing at all".
    const in2026 = rows.filter((r) => r.subjectId === assetId && r.belongsToPeriod >= '2026-01');
    expect(in2026.length).toBeGreaterThan(0);
    expect(in2026.map((r) => r.belongsToPeriod)).toContain('2026-04');

    // Red today: coverage-hole detection never invents anything BEFORE the org's first period
    // (same rule T-344's F17 fixture leans on), so `monthOverlapsOpenPeriod` sees no open period
    // there either — today's `missedMonths` has nothing stopping it from listing 2025-06..12.
    const pre2026 = rows.filter((r) => r.subjectId === assetId && r.belongsToPeriod < '2026-01');
    expect(pre2026).toEqual([]);

    // Red today, the same way: nothing currently refuses P < the org's earliest period, so this
    // resolves and actually posts instead of rejecting.
    await expect(
      book(f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2025-10', reason: 'x' }),
    ).rejects.toThrow(/2025-10 is before the books began \(2026-01\)/);
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2025-10`)).toBe(0);
    expect(await linkCount(f.orgId)).toBe(0);
  });
});

// =================================================================================================
// D1 — DB, APP role, raw SQL: the migration's own guard trigger (§3.1)
// =================================================================================================

describe('D1 — missed_month_adjustments: shape, guard trigger, immutability', () => {
  it('a valid link row inserts', async () => {
    const { f, assetId } = await d1Fixture('d1-valid');
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expect(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, 'fixture', ${f.adminId})`,
    ).resolves.toBeDefined();
  });

  it('⛔ the key names 2026-03 but the row says 2026-04 — refused', async () => {
    const { f, assetId } = await d1Fixture('d1-key-mismatch');
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-03`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expectGuardRefusal(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, 'fixture', ${f.adminId})`,
      /^missed_month_adjustments: the entry's key does not name asset/,
    );
  });

  it('⛔ R1.3: an entry dated BEFORE P — posted 2026-03-31 while March was open, then March closed', async () => {
    const f = await rolesFixture('d1-before-p');
    const assetId = await depreciableAsset(f);
    await insertMonths(f.orgId, 2026, 1, 2026, 5); // all open
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-03-31',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    // NOW close Jan-Mar together (the order-guard trigger, R1.2, refuses an open period starting
    // before one that is closing — closing March alone while Jan/Feb stayed open would trip it).
    // The entry above posted into March while it was still open (raw SQL bypasses postEntry's own
    // period-open check, but not migration 0003's own posting-time trigger).
    await closeAsLegacy(f.orgId, f.adminId, ['2026-01-01', '2026-02-01', '2026-03-01']);
    await expectGuardRefusal(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, 'fixture', ${f.adminId})`,
      /^missed_month_adjustments: the entry is dated .* -- not after/,
    );
  });

  it('⛔ a third line, or DR 6700 / CR 1400 (check 5)', async () => {
    const { f, assetId } = await d1Fixture('d1-shape');
    // Three lines, still BALANCED (600 + 400 debit = 1000 credit) — the split alone must trip
    // check 5's "exactly two lines", not T-103's own balance trigger.
    const thirdLine = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
      lines: [
        { code: '6700', debit: '600.00', credit: '0' },
        { code: '6700', debit: '400.00', credit: '0' },
        { code: '1590', debit: '0', credit: '1000.00' },
      ],
    });
    await expectGuardRefusal(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${thirdLine}, 'fixture', ${f.adminId})`,
      /^missed_month_adjustments: the entry has \d+ line\(s\), expected exactly 2/,
    );

    const wrongAccounts = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-16',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04#2`,
      debitCode: '6700',
      creditCode: '1400',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expectGuardRefusal(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${wrongAccounts}, 'fixture', ${f.adminId})`,
      /^missed_month_adjustments: the entry's lines are not DR 6700 \/ CR 1590/,
    );
  });

  it('⛔ P overlaps an open period', async () => {
    // Its own fixture, deliberately WITHOUT `d1Fixture`'s closed months: April and May both
    // still open, chronologically consecutive, nothing closed anywhere — the order-guard trigger
    // (R1.2) only refuses an open period starting before a CLOSED one, so this shape (needed to
    // post an entry dated AFTER April while April itself stays open) never trips it.
    const f = await rolesFixture('d1-open-overlap');
    const assetId = await depreciableAsset(f);
    await insertMonths(f.orgId, 2026, 1, 2026, 5); // all open, including April itself
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-05-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expectGuardRefusal(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, 'fixture', ${f.adminId})`,
      /^missed_month_adjustments: 2026-04 is still open -- the monthly run books it in its own month/,
    );
  });

  it('⛔ wrong source_id', async () => {
    const { f, assetId } = await d1Fixture('d1-wrong-source');
    const otherId = await depreciableAsset(f, { name: 'Other asset' });
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: otherId,
      storeId: f.storeId,
      idempotencyKey: `asset:${otherId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expectGuardRefusal(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, 'fixture', ${f.adminId})`,
      /^missed_month_adjustments: journal entry .* is not a posted depreciation entry for this subject/,
    );
  });

  it('⛔ R3.1: a period before the org\'s earliest fiscal period (check 6) — refused', async () => {
    // `d1Fixture`'s earliest fiscal_periods row is 2026-01 (buildHoleMonths starts there); 2025-10
    // is a month with no period at all, before the org's books began.
    const { f, assetId } = await d1Fixture('d1-before-books-began');
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2025-10`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expectGuardRefusal(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2025-10', ${entryId}, 'fixture', ${f.adminId})`,
      /^missed_month_adjustments: 2025-10 is before the books began/,
    );
  });

  it('⛔ both subject columns set, or neither — 23514', async () => {
    const { f, assetId } = await d1Fixture('d1-subject-shape');
    const { itemId } = await prepaidHoleFixture('d1-subject-shape-p');
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expect(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, prepaid_item_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, ${itemId}, '2026-04', ${entryId}, 'fixture', ${f.adminId})`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`insert into missed_month_adjustments (org_id, schedule, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', '2026-04', ${entryId}, 'fixture', ${f.adminId})`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('⛔ duplicate (asset, P) — refused by check 7 while the first link entry is posted', async () => {
    const { f, assetId } = await d1Fixture('d1-duplicate');
    const first = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
      values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${first}, 'fixture', ${f.adminId})`;

    const second = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-16',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04#2`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expect(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${second}, 'fixture', ${f.adminId})`,
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringMatching(/already has a posted link for/) });
  });

  it('⛔ any UPDATE — "missed_month_adjustments: rows are immutable"', async () => {
    const { f, assetId } = await d1Fixture('d1-immutable-update');
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    const [row] = await sql<{ id: string }[]>`
      insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
      values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, 'fixture', ${f.adminId}) returning id`;
    await expect(
      sql`update missed_month_adjustments set reason = 'changed' where id = ${row!.id}`,
    ).rejects.toThrow(/missed_month_adjustments: rows are immutable/);
  });

  it('⛔ a direct DELETE — the same immutable error; a plain DELETE of the posted entry is refused too', async () => {
    // R1.7's original premise (a targeted DELETE of the journal entry cascades the link) was wrong
    // — `journal_entries_check_posted_immutable` (migration 0005:87-95) refuses a DELETE of any
    // `posted` row outright, unconditionally. The real removal path is the cutover PURGE
    // (`scripts/cutover-purge.ts:202-219`), which TRUNCATEs purge-class tables together — proving
    // that here is dropped (R3.6, orchestrator CHANGES 2026-09-26): TRUNCATE takes ACCESS
    // EXCLUSIVE on most of the schema and deadlocks concurrent files in the full suite; TRUNCATE
    // not firing row triggers is a Postgres property, and classification is pinned separately by
    // `cutover-classification.test.ts`.
    const { f, assetId } = await d1Fixture('d1-immutable-delete');
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    const [row] = await sql<{ id: string }[]>`
      insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
      values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, 'fixture', ${f.adminId}) returning id`;
    await expect(
      sql`delete from missed_month_adjustments where id = ${row!.id}`,
    ).rejects.toThrow(/missed_month_adjustments: rows are immutable/);
    // A plain DELETE of the posted entry itself is refused too — never reaches the link at all.
    await expect(sql`delete from journal_entries where id = ${entryId}`).rejects.toThrow(
      /posted journal entry .* cannot be deleted/,
    );
  });

  it('⛔ reason = "  " — 23514', async () => {
    const { f, assetId } = await d1Fixture('d1-blank-reason');
    const entryId = await postRawEntry({
      orgId: f.orgId,
      entryDate: '2026-06-15',
      sourceType: 'depreciation',
      sourceId: assetId,
      storeId: f.storeId,
      idempotencyKey: `asset:${assetId}:depreciation:2026-04`,
      debitCode: '6700',
      creditCode: '1590',
      amount: '1000.00',
      postedBy: f.adminId,
    });
    await expect(
      sql`insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
          values (${f.orgId}, 'depreciation', ${assetId}, '2026-04', ${entryId}, '  ', ${f.adminId})`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
