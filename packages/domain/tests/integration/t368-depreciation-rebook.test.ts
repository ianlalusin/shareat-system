import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-368 S2 (DEF-435 re-book after reversal; DEF-441 pin the confirmed plan) — `docs/tasks/368-periods-depreciation.md` §S2, legs R1, R2, R6, R7, R8.
 * R3/R4 live in `t345-missed-month.test.ts` (A16 rewritten to "re-book succeeds"; the "already booked" refusal is its existing leg),
 * R5 is `t346-in-service-date.test.ts` I8/I13b rewritten. Every `confirmReversal: true` in the t346 files is now a two-step `confirm`
 * that takes `planToken` off the first refusal and resubmits it as `confirmedPlan`.
 *
 * ⛔ TESTER. Red until the builder lands: `depreciationRevisionKey`/`depreciationEntriesForPeriod`, the run's skip-then-revise,
 * `planToken` on the refusal (first 16 hex of sha-256 over the sorted entry ids, comma-joined), `confirmedPlan` on
 * `SetAssetInServiceInput` and `setStoreOpeningDate`'s input, and the lifted DEF-435 conflict.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, fixedAssetsRepo, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import {
  createAsset,
  disposeAsset,
  depreciationDrift,
  runDepreciationAsSystem,
  setStoreOpeningDate,
  // ⛔ Not yet exported by `@shareat/domain` — see header.
  setAssetInService,
  reverseEntry,
  bookMissedMonth,
  missedMonths,
} from '@shareat/domain';
import { sql as dsql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

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

/** Manila "today", read from Postgres so this file never goes stale (DEF-283). */
async function manilaTodayRaw(): Promise<string> {
  const [row] = await sql<{ today: string }[]>`select (now() at time zone 'Asia/Manila')::date::text as today`;
  return row!.today;
}
function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
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

/** One org, one store (opening_date as given — NULL by default, so a fresh asset there is HELD),
 *  chart of accounts, and four people. */
async function rolesFixture(hint: string, openingDate: string | null = null): Promise<OrgFixture> {
  const code = uid(`t346is-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Store', ${openingDate}) returning id`;
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

/** Spec §4's own base terms: cost 24,000, 24 months, monthly, salvage 0, acquired 2026-03-15. */
async function makeAsset(f: OrgFixture, over: Record<string, unknown> = {}): Promise<string> {
  const { id } = await withOrgPrincipal(f.orgId, (tx) =>
    createAsset(tx, f.admin, {
      storeId: f.storeId,
      name: 'Chiller',
      category: 'equipment',
      acquiredOn: '2026-03-15',
      cost: '24000.00',
      salvageValue: '0',
      usefulLifeMonths: 24,
      interval: 'monthly',
      ...over,
    } as Parameters<typeof createAsset>[2]),
  );
  return id;
}

async function inServiceOf(assetId: string): Promise<{ source: string | null; on: string | null }> {
  const [row] = await sql<{ in_service_source: string | null; in_service_on: string | null }[]>`
    select in_service_source, in_service_on::text as in_service_on from fixed_assets where id = ${assetId}`;
  return { source: row?.in_service_source ?? null, on: row?.in_service_on ?? null };
}

const setStoreOpening = (
  actorArg: Actor,
  storeId: string,
  input: { openingDate: string | null; confirm?: boolean },
) =>
  withPlan(input.confirm, (confirmedPlan) =>
    withOrgPrincipal(actorArg.orgId, (tx) =>
      setStoreOpeningDate(tx, actorArg, storeId, { openingDate: input.openingDate, ...(confirmedPlan ? { confirmedPlan } : {}) } as never),
    ),
  );

const setInService = (
  actorArg: Actor,
  assetId: string,
  input: { mode: 'acquired' | 'store_opening' | 'set'; inServiceOn?: string; reason: string; confirm?: boolean },
) => {
  const { confirm, ...rest } = input;
  return withPlan(confirm, (confirmedPlan) =>
    withOrgPrincipal(actorArg.orgId, (tx) => setAssetInService(tx, actorArg, assetId, { ...rest, ...(confirmedPlan ? { confirmedPlan } : {}) } as never)),
  );
};

/**
 * T-368 S2 (DEF-441): a reversal confirm is pinned to the exact entry set it showed. `confirm: true` here means the REAL
 * two-step a person does: call without a token, take `planToken` off the refusal, call again with it as `confirmedPlan`.
 * If the first call does not refuse with a token (nothing to reverse) its result is returned as is. Red until S2 lands:
 * today the first call refuses with no `planToken` and the helper rethrows it.
 */
async function withPlan<T>(confirm: boolean | undefined, run: (confirmedPlan?: string) => Promise<T>): Promise<T> {
  if (!confirm) return run();
  try {
    return await run();
  } catch (err) {
    const token = (err as { planToken?: string }).planToken;
    if (!token) throw err;
    return run(token);
  }
}

async function runThrough(orgId: string, through: string) {
  return runDepreciationAsSystem(orgId, { through });
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
async function reversalOf(orgId: string, originalEntryId: string) {
  const [row] = await sql<{ entry_date: string; memo: string }[]>`
    select entry_date::text as entry_date, memo from journal_entries
    where org_id = ${orgId} and reversal_of_entry_id = ${originalEntryId}`;
  return row;
}
async function linesFor(entryId: string) {
  return sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, jl.debit, jl.credit from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by jl.line_no`;
}
async function accountLineCount(orgId: string, assetId: string, code: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_id = ${assetId} and a.code = ${code}`;
  return row!.n;
}


// =================================================================================================
// Fixtures for R1/R2/R6/R7/R8. Store opens 2026-01-01 so an asset is never HELD; periods are open 2026-03..2026-12 unless a
// case says otherwise. Cost 24,000 / 24 months / monthly / salvage 0 = 1,000.00 a month, acquired 2026-03-15 (first month 2026-03).
// =================================================================================================

const keyOf = (assetId: string, period: string, rev?: number) => `asset:${assetId}:depreciation:${period}${rev ? `#${rev}` : ''}`;
const revert = (f: OrgFixture, entryId: string) =>
  withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId, reason: 'test reversal', reversedBy: f.adminId }));
const planTokenOf = (ids: string[]) => createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 16);

async function postedFixture(hint: string, through: string) {
  const f = await rolesFixture(hint, '2026-01-01');
  await insertMonths(f.orgId, 2026, 3, 2026, 12);
  const assetId = await makeAsset(f);
  await runThrough(f.orgId, through);
  return { f, assetId };
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ message: string; userMessage?: string; planToken?: string }> {
  try {
    await run();
  } catch (err) {
    const e = err as { message?: string; userMessage?: string; planToken?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, planToken: e.planToken };
  }
  throw new Error('NOT REFUSED — the call succeeded instead of asking for confirmation');
}
const text = (r: { message: string; userMessage?: string }) => r.userMessage ?? r.message;

describe('R1 — run P, reverse it, run P again: the month is re-booked (DEF-435)', () => {
  it('one posted entry for P under key ...:P#2, created:true; the original stays reversed — red today: created:false, P unbooked', async () => {
    const { f, assetId } = await postedFixture('r1', '2026-03');
    const first = await entryRow(f.orgId, keyOf(assetId, '2026-03'));
    expect(first?.status, 'fixture: March posted').toBe('posted');
    await revert(f, first!.id);

    const again = await runThrough(f.orgId, '2026-03');
    const march = again.posted.find((p) => p.assetId === assetId && p.period === '2026-03');
    expect(march?.created, 'the run found the key taken and silently skipped the month').toBe(true);
    const second = await entryRow(f.orgId, keyOf(assetId, '2026-03', 2));
    expect(second?.status).toBe('posted');
    expect((await entryRow(f.orgId, keyOf(assetId, '2026-03')))?.status).toBe('reversed');
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from journal_entries
      where org_id = ${f.orgId} and idempotency_key like ${`asset:${assetId}:depreciation:2026-03%`} and status = 'posted'`;
    expect(n!.n, 'exactly one effective entry for the period').toBe(1);
  });

  it('a second reversal re-books again as #3 (the revision count follows the entries, not a flag)', async () => {
    const { f, assetId } = await postedFixture('r1b', '2026-03');
    await revert(f, (await entryRow(f.orgId, keyOf(assetId, '2026-03')))!.id);
    await runThrough(f.orgId, '2026-03');
    await revert(f, (await entryRow(f.orgId, keyOf(assetId, '2026-03', 2)))!.id);
    await runThrough(f.orgId, '2026-03');
    expect((await entryRow(f.orgId, keyOf(assetId, '2026-03', 3)))?.status).toBe('posted');
  });
});

describe('R2 (control) — run P twice with no reversal: still exactly one entry, no #2', () => {
  it('the "already effective" skip is load-bearing: a second run posts nothing new and mints no revision', async () => {
    const { f, assetId } = await postedFixture('r2', '2026-05');
    const before = await entryRow(f.orgId, keyOf(assetId, '2026-04'));
    const again = await runThrough(f.orgId, '2026-05');
    expect(again.posted.filter((p) => p.assetId === assetId && p.created), 'a re-run created entries').toEqual([]);
    for (const m of ['03', '04', '05']) {
      expect(await entryCountForKey(f.orgId, keyOf(assetId, `2026-${m}`, 2)), `a #2 was minted for ${m}`).toBe(0);
      expect(await entryCountForKey(f.orgId, keyOf(assetId, `2026-${m}`))).toBe(1);
    }
    expect((await entryRow(f.orgId, keyOf(assetId, '2026-04')))?.id).toBe(before!.id);
  });
});

describe('R6/R7 — the confirm is pinned to the exact entries it showed (DEF-441)', () => {
  /** In service moved to October: every posted March–August entry is owed no more, so all six are the plan. */
  const move = (f: OrgFixture, assetId: string, confirmedPlan?: string) =>
    withOrgPrincipal(f.orgId, (tx) =>
      setAssetInService(tx, f.admin, assetId, { mode: 'set', inServiceOn: '2026-10-01', reason: 'correction', ...(confirmedPlan ? { confirmedPlan } : {}) } as never),
    );
  const idsOf = async (f: OrgFixture, assetId: string) =>
    Promise.all(['03', '04', '05', '06', '07', '08'].map(async (m) => (await entryRow(f.orgId, keyOf(assetId, `2026-${m}`)))!.id));

  it('R6: no token -> refusal with planToken T1 (16 hex, = sha-256 of the sorted entry ids), message still ends "confirm to proceed"; a month is then re-booked; resubmitting T1 is refused as changed, with a NEW token, and reverses nothing', async () => {
    const { f, assetId } = await postedFixture('r6', '2026-08');
    const ids = await idsOf(f, assetId);

    const first = await refusalOf(() => move(f, assetId));
    expect(first.planToken, 'the refusal carries no planToken').toMatch(/^[0-9a-f]{16}$/);
    expect(first.planToken).toBe(planTokenOf(ids));
    expect(text(first)).toMatch(/confirm to proceed$/);

    // A month in the MIDDLE of the range is reversed and re-booked: same count, same first and last period, different entry id.
    await revert(f, ids[3]!);
    await runThrough(f.orgId, '2026-08');
    expect((await entryRow(f.orgId, keyOf(assetId, '2026-06', 2)))?.status, 'fixture: June re-booked as #2').toBe('posted');

    const stale = await refusalOf(() => move(f, assetId, first.planToken));
    expect(text(stale), 'a stale token was accepted or answered with something else').toMatch(/^What this would reverse has changed since you confirmed\./);
    expect(stale.planToken, 'the refusal names the NEW token').toMatch(/^[0-9a-f]{16}$/);
    expect(stale.planToken).not.toBe(first.planToken);
    for (const m of ['03', '04', '05', '07', '08']) expect((await entryRow(f.orgId, keyOf(assetId, `2026-${m}`)))?.status, `2026-${m}`).toBe('posted');
    expect((await entryRow(f.orgId, keyOf(assetId, '2026-06', 2)))?.status).toBe('posted');
    expect((await inServiceOf(assetId)).on, 'a refused confirm moved the date').not.toBe('2026-10-01');
  });

  it('R7 (control): resubmitting with the CURRENT token reverses exactly the planned entry ids and moves the date', async () => {
    const { f, assetId } = await postedFixture('r7', '2026-08');
    const ids = await idsOf(f, assetId);
    const refused = await refusalOf(() => move(f, assetId));
    const result = (await move(f, assetId, refused.planToken)) as { reversed: string[] };
    expect(result.reversed).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    const rows = await sql<{ id: string; status: string }[]>`select id, status from journal_entries where id = any(${ids}::uuid[])`;
    expect(rows.map((r) => r.status)).toEqual(Array(6).fill('reversed'));
    expect((await inServiceOf(assetId)).on).toBe('2026-10-01');
  });

  it('a token minted for ANOTHER asset is not accepted for this one', async () => {
    const a = await postedFixture('r7-other-a', '2026-08');
    const b = await postedFixture('r7-other-b', '2026-08');
    const tokenA = (await refusalOf(() => move(a.f, a.assetId))).planToken;
    const wrong = await refusalOf(() => move(b.f, b.assetId, tokenA));
    expect(text(wrong)).toMatch(/^What this would reverse has changed since you confirmed\./);
    expect((await entryRow(b.f.orgId, keyOf(b.assetId, '2026-03')))?.status).toBe('posted');
  });
});

describe('R8 — the store-wide cascade pins its plan the same way', () => {
  it('setStoreOpeningDate across two follower assets: no token -> planToken T1; a follower changes (one month re-booked) -> T1 refused as changed with a new token, nothing reversed; the new token reverses all six', async () => {
    const f = await rolesFixture('r8', '2026-02-01');
    await insertMonths(f.orgId, 2026, 1, 2026, 12);
    const a1 = await makeAsset(f, { name: 'Chiller A', acquiredOn: '2026-01-01' } as Record<string, unknown>);
    const a2 = await makeAsset(f, { name: 'Chiller B', acquiredOn: '2026-01-01' } as Record<string, unknown>);
    expect(await inServiceOf(a1)).toEqual({ source: 'store_opening', on: '2026-02-01' });
    await runThrough(f.orgId, '2026-04'); // Feb, Mar, Apr for each = six entries

    const open = (confirmedPlan?: string) =>
      withOrgPrincipal(f.orgId, (tx) =>
        setStoreOpeningDate(tx, f.admin, f.storeId, { openingDate: '2026-07-01', ...(confirmedPlan ? { confirmedPlan } : {}) } as never),
      );
    const first = await refusalOf(() => open());
    expect(first.planToken, 'the store cascade refusal carries no planToken').toMatch(/^[0-9a-f]{16}$/);
    expect(text(first)).toMatch(/confirm to proceed$/);

    await revert(f, (await entryRow(f.orgId, keyOf(a2, '2026-03')))!.id);
    await runThrough(f.orgId, '2026-04');
    expect((await entryRow(f.orgId, keyOf(a2, '2026-03', 2)))?.status, 'fixture: B\'s March re-booked').toBe('posted');

    const stale = await refusalOf(() => open(first.planToken));
    expect(text(stale)).toMatch(/^What this would reverse has changed since you confirmed\./);
    expect(stale.planToken).not.toBe(first.planToken);
    expect((await inServiceOf(a1)).on, 'a refused confirm moved a follower').toBe('2026-02-01');
    for (const id of [a1, a2]) expect((await entryRow(f.orgId, keyOf(id, '2026-02')))?.status).toBe('posted');

    await open(stale.planToken);
    expect((await inServiceOf(a1)).on).toBe('2026-07-01');
    for (const m of ['02', '03', '04']) expect((await entryRow(f.orgId, keyOf(a1, `2026-${m}`)))?.status).toBe('reversed');
    expect((await entryRow(f.orgId, keyOf(a2, '2026-03', 2)))?.status).toBe('reversed');
  });
});

// =================================================================================================
// R9 — audit #1 (MED): a month the asset still owes is reversed, and its fiscal period is then CLOSED. Spec S2: it "re-posts on the next
// run if its period is open, or is listed by T-345 if its period is closed". The run must SKIP it, not record it as a failure — a failure
// rolls back that asset's whole run (April and later too). Shape: acquired 2026-03-15, 24 months, March+April posted, March reversed,
// periods up to March closed. (The t346 I8 in-service shape cannot isolate March: moving earlier also newly owes January, and closed
// periods are a contiguous prefix, so January closes with it and fails on its own.)
// =================================================================================================

describe('R9 — the re-book of a reversed month whose fiscal period is CLOSED', () => {
  async function closedFixture(hint: string, closeMarch: boolean | 'locked') {
    const { f, assetId } = await postedFixture(hint, '2026-04');
    await revert(f, (await entryRow(f.orgId, keyOf(assetId, '2026-03')))!.id);
    // a second asset in the same org, owed April and May: one asset's failure must not stop the other
    const otherId = await makeAsset(f, { name: 'Other', cost: '1200.00', usefulLifeMonths: 12, acquiredOn: '2026-04-01', inServiceSource: 'set', inServiceOn: '2026-04-01' });
    if (closeMarch === true || closeMarch === 'locked') {
      await sql`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${f.adminId}
                where org_id = ${f.orgId} and starts_on <= '2026-03-01'`;
    }
    // a year with any open period cannot hold a locked one, so LOCKED means the whole of 2026 (every open month included)
    if (closeMarch === 'locked') await sql`update fiscal_periods set status = 'locked', closed_at = coalesce(closed_at, now()), closed_by = coalesce(closed_by, ${f.adminId}) where org_id = ${f.orgId}`;
    return { f, assetId, otherId };
  }

  it('March CLOSED: the run records NO failure, March is not re-booked, April-and-later post normally, and T-345 lists March', async () => {
    const { f, assetId, otherId } = await closedFixture('r9a', true);
    expect((await entryRow(f.orgId, keyOf(assetId, '2026-03')))?.status, 'fixture: March is reversed').toBe('reversed');
    const result = await runThrough(f.orgId, '2026-05');
    expect(result.failed, 'the closed month was recorded as a FAILURE of the run rather than skipped').toEqual([]);
    expect(await entryCountForKey(f.orgId, keyOf(assetId, '2026-03', 2)), 'a #2 was posted into a closed period').toBe(0);
    expect((await entryRow(f.orgId, keyOf(assetId, '2026-05')))?.status, 'May of the same asset did not post').toBe('posted');
    expect((await entryRow(f.orgId, keyOf(otherId, '2026-04')))?.status, 'April of the other asset did not post').toBe('posted');
    const rows = await asOrg(f.orgId, (tx) => missedMonths(tx, f.orgId, '2026-05'));
    expect(rows.find((r) => r.subjectId === assetId && r.belongsToPeriod === '2026-03'), 'March is not on the T-345 list').toBeDefined();
  });

  it('control: the same asset with March OPEN re-books March as #2 at 1,000.00', async () => {
    const { f, assetId } = await closedFixture('r9b', false);
    const result = await runThrough(f.orgId, '2026-05');
    expect(result.failed).toEqual([]);
    expect(result.posted.find((p) => p.assetId === assetId && p.period === '2026-03')?.created).toBe(true);
    const rebooked = await entryRow(f.orgId, keyOf(assetId, '2026-03', 2));
    expect(rebooked?.status).toBe('posted');
    expect((await linesFor(rebooked!.id)).find((l) => l.code === '6700')?.debit).toBe('1000.00');
  });

  it('March LOCKED (the whole of 2026 locked — a locked year holds no open month): the run skips it without a failure, posts nothing for it, and T-345 lists it', async () => {
    const { f, assetId } = await closedFixture('r9c', 'locked');
    const result = await runThrough(f.orgId, '2026-05');
    expect(result.failed, 'a locked month was recorded as a failure').toEqual([]);
    expect(await entryCountForKey(f.orgId, keyOf(assetId, '2026-03', 2))).toBe(0);
    const rows = await asOrg(f.orgId, (tx) => missedMonths(tx, f.orgId, '2026-05'));
    expect(rows.find((r) => r.subjectId === assetId && r.belongsToPeriod === '2026-03'), 'March is not on the T-345 list').toBeDefined();
  });

  it('March with NO fiscal-period row: the skip does not swallow the hole — the asset is still recorded under failed with the "no fiscal period covers" refusal', async () => {
    // March's period row cannot be deleted once an entry points at it, so the hole is built from the start: periods begin in April
    const f = await rolesFixture('r9d', '2026-01-01');
    await insertMonths(f.orgId, 2026, 4, 2026, 12);
    const assetId = await makeAsset(f);
    const result = await runThrough(f.orgId, '2026-05');
    const failure = result.failed.find((x) => x.assetId === assetId);
    expect(failure, 'a month with no fiscal period was silently skipped').toBeDefined();
    expect(failure!.error).toMatch(/no fiscal period covers/);
    expect(await entryCountForKey(f.orgId, keyOf(assetId, '2026-03', 2))).toBe(0);
  });

  it('skippedClosed: the run reports the owed months it skipped because their month is closed or locked — 1 for the closed March, 0 for the open control', async () => {
    const closed = await closedFixture('r9e', true);
    const withClosed = (await runThrough(closed.f.orgId, '2026-05')) as unknown as { skippedClosed?: number };
    expect(withClosed.skippedClosed, 'the result carries no skippedClosed: a skipped month is silent').toBe(1);
    const open = await closedFixture('r9f', false);
    const withOpen = (await runThrough(open.f.orgId, '2026-05')) as unknown as { skippedClosed?: number };
    expect(withOpen.skippedClosed, 'control: nothing was skipped as closed').toBe(0);
  });
});
