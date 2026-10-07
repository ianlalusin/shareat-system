import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-381 / DEF-606 — the missed-month booking race answers in words. `docs/tasks/381-missed-month-race-sentence.md`
 * Ruling R1: `bookMissedMonth` takes a per-SUBJECT row lock (FOR UPDATE on the fixed_assets / prepaid_items row)
 * right after loading the subject, so a second booker WAITS, re-reads, and throws "... is already booked for P"
 * instead of tripping the 0174 trigger's raw message.
 *
 * Fixtures are copied from t345-missed-month.test.ts (test files cannot import each other without re-registering
 * their suites). Connection 1 books and holds its transaction OPEN (uncommitted) behind a gate; connection 2 is a
 * second, independent withOrgPrincipal transaction.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { buildSchedule, createAsset, createPrepaidItem, prepaidSchedule, bookMissedMonth } from '@shareat/domain';
import { money } from '@shareat/core/money';

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


async function linkCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from missed_month_adjustments where org_id = ${orgId}`;
  return row!.n;
}
async function entryCountForKey(orgId: string, idempotencyKey: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`;
  return row!.n;
}

// =================================================================================================
// The two-connection harness
// =================================================================================================

type BookInput = Parameters<typeof book>[1];
const BLOCK_MS = 500;
const WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Rejects (instead of hanging) if `p` does not settle within `ms`. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`TIMEOUT after ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * Connection 1: books and then HOLDS its transaction open (uncommitted) until `release()`. `held` resolves once the
 * booking has run inside the still-open transaction; `done` settles when that transaction commits (or rolls back).
 */
function holdBooking(actorArg: Actor, input: BookInput) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let markHeld!: () => void;
  const held = new Promise<void>((r) => (markHeld = r));
  const done = withOrgPrincipal(actorArg.orgId, async (tx) => {
    const res = await bookMissedMonth(tx, actorArg, input);
    markHeld();
    await gate;
    return res;
  });
  // If connection 1 itself fails, surface that instead of waiting on `held` forever.
  const heldOrFail = Promise.race([held, done.then(() => undefined)]);
  return { release, held: heldOrFail, done };
}

/** Connection 2 starts now; `state()` says whether it has settled yet. */
function startBooking(actorArg: Actor, input: BookInput) {
  let settled: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  const p = book(actorArg, input).then(
    (v) => {
      settled = 'fulfilled';
      return v;
    },
    (e) => {
      settled = 'rejected';
      throw e;
    },
  );
  p.catch(() => undefined); // never an unhandled rejection; the test awaits `p` itself
  return { p, state: () => settled };
}


/**
 * The statements currently WAITING on a lock in this database. On HEAD, connection 2 does block — but late, on the
 * journal idempotency-key unique insert (step 7), after reading "nothing booked yet" at step 5; that is the window the
 * DEF-606 race lives in. R1 moves the wait to the subject row, BEFORE step 5, so the waiting statement must be the
 * subject's `FOR UPDATE`.
 */
async function lockWaiters(): Promise<string[]> {
  const rows = await sql<{ query: string }[]>`
    select query from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
  return rows.map((r) => r.query.replace(/\s+/g, ' '));
}

async function raceBetweenTwo(f: OrgFixture, input: BookInput, label: string) {
  const c1 = holdBooking(f.admin, input);
  try {
    await within(c1.held, WAIT_MS, `${label}: connection 1 never reached its held-open booking`);
    const c2 = startBooking(f.admin, input);
    await sleep(BLOCK_MS);
    const stateAfterBlockWindow = c2.state();
    const waiters = await lockWaiters();
    const textWhileHeld = stateAfterBlockWindow === 'rejected' ? await c2.p.catch((e) => String(e)) : undefined;
    return { c1, c2, stateAfterBlockWindow, textWhileHeld, waiters };
  } catch (e) {
    c1.release();
    await c1.done.catch(() => undefined);
    throw e;
  }
}

// =================================================================================================
// R1-a, R1-b — the SAME subject and month: the second booker WAITS, then answers in words
// =================================================================================================

describe('R1-a — depreciation: connection 2 blocks behind connection 1, then says "already booked"', () => {
  it('blocked while 1 is uncommitted; after commit 2 rejects /already booked for 2026-04/, not the trigger text; 1 entry, 1 link', async () => {
    // Killing mutant: remove the subject lock in bookMissedMonth -> 2 waits on the journal unique insert instead of the subject row (waiters assertion), and/or rejects with the raw `missed_month_adjustments: asset <uuid> already has a posted link` trigger text.
    const { f, assetId } = await assetHoleFixture('r1a');
    const input: BookInput = { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'race' };
    const { c1, c2, stateAfterBlockWindow, textWhileHeld, waiters } = await raceBetweenTwo(f, input, 'R1-a');
    try {
      expect(
        stateAfterBlockWindow,
        `connection 2 must BLOCK on the subject lock while connection 1 is uncommitted (settled as ${stateAfterBlockWindow}: ${textWhileHeld ?? ''})`,
      ).toBe('pending');
      expect(
        waiters.some((q) => /for update/i.test(q) && /fixed_assets/i.test(q)),
        `connection 2 must wait on the subject row lock (select ... from fixed_assets ... for update), not later; waiting statements: ${JSON.stringify(waiters.map((q) => q.slice(0, 120)))}`,
      ).toBe(true);
    } finally {
      c1.release();
    }
    await within(c1.done, WAIT_MS, 'R1-a: connection 1 commit');
    const err = await within(c2.p.then(() => 'RESOLVED', (e) => String(e)), WAIT_MS, 'R1-a: connection 2 after commit');
    expect(err).toMatch(/already booked for 2026-04/);
    expect(err).not.toMatch(/already has a posted link|missed_month_adjustments:|23505/);
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-04`)).toBe(1);
    expect(await linkCount(f.orgId)).toBe(1);
  }, 60_000);
});

describe('R1-b — prepaid: connection 2 blocks behind connection 1, then says "already booked"', () => {
  it('blocked while 1 is uncommitted; after commit 2 rejects /already booked for 2026-04/, not the trigger text; 1 entry, 1 link', async () => {
    // Killing mutant: lock only the asset path (prepaid path unlocked) -> 2 waits on the journal unique insert, not prepaid_items FOR UPDATE.
    const { f, itemId } = await prepaidHoleFixture('r1b');
    const input: BookInput = { schedule: 'amortisation', subjectId: itemId, belongsToPeriod: '2026-04', reason: 'race' };
    const { c1, c2, stateAfterBlockWindow, textWhileHeld, waiters } = await raceBetweenTwo(f, input, 'R1-b');
    try {
      expect(
        stateAfterBlockWindow,
        `connection 2 must BLOCK on the subject lock while connection 1 is uncommitted (settled as ${stateAfterBlockWindow}: ${textWhileHeld ?? ''})`,
      ).toBe('pending');
      expect(
        waiters.some((q) => /for update/i.test(q) && /prepaid_items/i.test(q)),
        `connection 2 must wait on the subject row lock (select ... from prepaid_items ... for update), not later; waiting statements: ${JSON.stringify(waiters.map((q) => q.slice(0, 120)))}`,
      ).toBe(true);
    } finally {
      c1.release();
    }
    await within(c1.done, WAIT_MS, 'R1-b: connection 1 commit');
    const err = await within(c2.p.then(() => 'RESOLVED', (e) => String(e)), WAIT_MS, 'R1-b: connection 2 after commit');
    expect(err).toMatch(/already booked for 2026-04/);
    expect(err).not.toMatch(/already has a posted link|missed_month_adjustments:|23505/);
    expect(await entryCountForKey(f.orgId, `prepaid:${itemId}:amortisation:2026-04`)).toBe(1);
    expect(await linkCount(f.orgId)).toBe(1);
  }, 60_000);
});

// =================================================================================================
// R1-c — the lock is per SUBJECT: a different asset is not blocked
// =================================================================================================

describe('R1-c — a DIFFERENT asset booked while the first is held is NOT blocked', () => {
  it('asset B books to completion while connection 1 still holds asset A uncommitted; both links land', async () => {
    // Killing mutant: lock a whole table or the org instead of the subject row -> B blocks and within() times out.
    const f = await rolesFixture('r1c');
    const assetA = await depreciableAsset(f, { name: 'Chiller A' });
    const assetB = await depreciableAsset(f, { name: 'Chiller B' });
    await buildHoleMonths(f, [depreciationPoster(f, assetA), depreciationPoster(f, assetB)]);
    const c1 = holdBooking(f.admin, { schedule: 'depreciation', subjectId: assetA, belongsToPeriod: '2026-04', reason: 'A' });
    try {
      await within(c1.held, WAIT_MS, 'R1-c: connection 1 never reached its held-open booking');
      const resB = await within(
        book(f.admin, { schedule: 'depreciation', subjectId: assetB, belongsToPeriod: '2026-04', reason: 'B' }),
        5_000,
        "R1-c: asset B was BLOCKED by asset A's uncommitted booking (the lock is wider than the subject)",
      );
      expect(resB.amount).toBeTruthy();
    } finally {
      c1.release();
    }
    await within(c1.done, WAIT_MS, 'R1-c: connection 1 commit');
    expect(await entryCountForKey(f.orgId, `asset:${assetA}:depreciation:2026-04`)).toBe(1);
    expect(await entryCountForKey(f.orgId, `asset:${assetB}:depreciation:2026-04`)).toBe(1);
    expect(await linkCount(f.orgId)).toBe(2);
  }, 60_000);
});
