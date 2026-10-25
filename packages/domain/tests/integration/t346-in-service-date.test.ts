import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-346 S2 — an asset depreciates from the day it is IN SERVICE, not from acquisition, when its
 * store has not opened yet (DEF-427). `docs/tasks/346-store-opening-and-in-service-date.md` §4
 * (cases I), §3.3 (migration `0163`, CIP-as-a-state), §3.4 (`setAssetInService`), Amendment R4
 * (the S2 fold — R1.1, R1.2, R1.4, R1.5, R1.8 folded in below; R4.2 for I9's UPDATE cases).
 *
 * ⛔ RED until the builder lands migration `0163` (`fixed_assets.in_service_on` / `in_service_source`,
 * the `_a_fill` / `_b_guard` triggers, `stores_opening_date_propagate`), `setAssetInService`
 * (`packages/domain/src/fixed-assets/in-service.ts`, new file) and `scheduleInputFor`'s switch from
 * `acquired_on` to `in_service_on` (`fixed-assets/depreciate.ts`). `setAssetInService` is imported
 * from `@shareat/domain` even though it does not exist yet — same posture as T-345's own
 * `bookMissedMonth` and T-346 S1's own `setStoreOpeningDate`: TS2305 at typecheck, `undefined` at
 * runtime (esbuild strips types), so calling it throws `TypeError: ... is not a function`.
 *
 * `createAsset` is called with extra `inServiceSource`/`inServiceOn` properties the CURRENT
 * `CreateAssetInput` does not declare (cast via `as Parameters<typeof createAsset>[2]`, the same
 * "call the future shape" convention T-346 S1 used for `openingDate`). Today those properties are
 * silently ignored — `insertAsset`'s SQL builder reads only its own declared columns — so the
 * asset is created successfully with a schedule that ignores them entirely, and the very next line
 * that reads `in_service_on`/`in_service_source` back off `fixed_assets` fails with "column
 * ... does not exist" (`I1`'s own red). Where a case needs a CHECK-constraint refusal specifically
 * (I5's "before acquired"), today's silent-ignore means the call actually RESOLVES where the
 * finished system will reject it — the assertion that turns red is "the promise rejects", not a
 * raw Postgres error, and is called out at each such case.
 *
 * Fixture (spec §4): cost 24,000, 24 months, monthly, salvage 0 (₱1,000.00/month), acquired
 * 2026-03-15, unless a case states otherwise. Periods are inserted per case, open 2026-01 onward.
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
  bookMissedMonth,
  missedMonths,
} from '@shareat/domain';
import { sql as dsql } from 'drizzle-orm';

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
// I1 — an asset at a store with NO opening date is HELD
// =================================================================================================

describe('I1 — an asset at a store with no opening date: store_opening source, NULL in-service, posts nothing', () => {
  it('in_service_source = store_opening, in_service_on NULL; the run through 2026-09 posts nothing; no 6700 line', async () => {
    const f = await rolesFixture('i1');
    await insertMonths(f.orgId, 2026, 1, 2026, 9);
    const assetId = await makeAsset(f);

    const inService = await inServiceOf(assetId);
    expect(inService.source).toBe('store_opening');
    expect(inService.on).toBeNull();

    const result = await runThrough(f.orgId, '2026-09');
    expect(result.posted.filter((p) => p.assetId === assetId)).toEqual([]);
    expect(await accountLineCount(f.orgId, assetId, '6700')).toBe(0);
  });
});

// =================================================================================================
// I2 — setStoreOpeningDate propagates to a HELD follower (§3.2 step 3 / §3.3 step 6)
// =================================================================================================

describe('I2 — setStoreOpeningDate propagates to a HELD follower asset', () => {
  it('follower in_service_on becomes 2026-10-01; the run through 10 posts only October = 1,000; nothing 03..09', async () => {
    const f = await rolesFixture('i2');
    await insertMonths(f.orgId, 2026, 1, 2026, 10);
    const assetId = await makeAsset(f); // held — store has no opening date yet

    await setStoreOpening(f.admin, f.storeId, { openingDate: '2026-10-01' });

    const inService = await inServiceOf(assetId);
    expect(inService.source).toBe('store_opening');
    expect(inService.on).toBe('2026-10-01');

    const result = await runThrough(f.orgId, '2026-10');
    const posted = result.posted.filter((p) => p.assetId === assetId && p.created);
    expect(posted.map((p) => p.period)).toEqual(['2026-10']);
    expect(posted[0]!.amount).toBe('1000.00');
    for (const m of ['03', '04', '05', '06', '07', '08', '09']) {
      expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-${m}`)).toBe(0);
    }
  });
});

// =================================================================================================
// I3 — GUARD (like T-345's A2b): an already-long-open store's asset never becomes HELD. This
// asserts posting behaviour only, which is unchanged from today's code — GREEN now, GREEN after S2.
// =================================================================================================

describe('I3 — GUARD: a store already open long before acquisition never holds its asset', () => {
  it('depreciation posts from 2026-03 normally, exactly as it does today with no store-opening concept at all', async () => {
    const f = await rolesFixture('i3', '2025-01-01');
    await insertMonths(f.orgId, 2026, 1, 2026, 4);
    const assetId = await makeAsset(f); // acquired 2026-03-15
    const result = await runThrough(f.orgId, '2026-04');
    const posted = result.posted.filter((p) => p.assetId === assetId && p.created);
    expect(posted.map((p) => p.period)).toEqual(['2026-03', '2026-04']);
  });
});

// =================================================================================================
// I4 — acquired AFTER a store that has already opened: 'acquired' wins over 'store_opening'
// =================================================================================================

describe('I4 — acquired after the store\'s own opening date: source is acquired, not store_opening', () => {
  it('store opens 2026-10-01, asset acquired 2026-11-02: source acquired, in_service_on = 2026-11-02', async () => {
    const f = await rolesFixture('i4', '2026-10-01');
    const assetId = await makeAsset(f, { acquiredOn: '2026-11-02' } as Record<string, unknown>);
    const inService = await inServiceOf(assetId);
    expect(inService.source).toBe('acquired');
    expect(inService.on).toBe('2026-11-02');
  });
});

// =================================================================================================
// I5 — a 'set' in-service date supplied at creation (R1.8's fill rule: source NULL + a value ⇒ 'set')
// =================================================================================================

describe('I5 — an explicit in-service date at creation ("set")', () => {
  it('set 2026-12-01: the column round-trips; the schedule\'s first period is 2026-12', async () => {
    const f = await rolesFixture('i5');
    const assetId = await makeAsset(f, {
      inServiceSource: 'set',
      inServiceOn: '2026-12-01',
    } as Record<string, unknown>);
    const inService = await inServiceOf(assetId);
    expect(inService.source).toBe('set');
    expect(inService.on).toBe('2026-12-01');

    await insertMonths(f.orgId, 2026, 1, 2026, 12);
    const result = await runThrough(f.orgId, '2026-12');
    const posted = result.posted.filter((p) => p.assetId === assetId && p.created);
    expect(posted.map((p) => p.period)).toEqual(['2026-12']);
  });

  it('⛔ set 2026-03-01, before the 2026-03-15 acquisition date, must be refused (23514)', async () => {
    // ⛔ RED TODAY FOR A DIFFERENT REASON than the column: `createAsset` ignores the extra
    // properties entirely, so this call actually RESOLVES right now — it is the `.rejects`
    // assertion itself that fails, not a raw Postgres error. Once the builder routes these
    // through to the INSERT, `fixed_assets_in_service_shape_check` (§3.3 step 3, "in_service_on
    // IS NULL OR in_service_on >= acquired_on") rejects it with SQLSTATE 23514.
    const f = await rolesFixture('i5-early');
    await expect(
      makeAsset(f, { inServiceSource: 'set', inServiceOn: '2026-03-01' } as Record<string, unknown>),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// =================================================================================================
// I6 — setAssetInService: without confirmReversal, refuse and list; with confirmReversal, reverse
// each owed-no-more month with R1.4's own dating rule (open period -> own date; closed -> today with
// [prior period], added by reverseEntry itself)
// =================================================================================================

describe('I6 — setAssetInService moves an asset later: without confirm it lists, with confirm it reverses correctly', () => {
  async function postedThroughOctober(hint: string) {
    const f = await rolesFixture(hint, '2026-01-01'); // opens well before acquisition — not held
    await insertMonths(f.orgId, 2026, 3, 2026, 10);
    const assetId = await makeAsset(f); // acquired 2026-03-15
    await runThrough(f.orgId, '2026-10'); // 03..10 post, 1,000.00 each
    // Close 03-05 together (order-guard: no open period may precede a closing one); 06+ stay open.
    await sql`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${f.adminId}
      where org_id = ${f.orgId} and starts_on in ('2026-03-01', '2026-04-01', '2026-05-01')`;
    return { f, assetId };
  }

  it('without confirmReversal: refused, naming the 7 months owed and their total', async () => {
    const { f, assetId } = await postedThroughOctober('i6-noconfirm');
    // Amendment R4.3 — the exact thrown-message template, confirmed by the builder:
    // "{asset} — moving the in-service date reverses {n} depreciation entries ({first}–{last}), ₱{total}; confirm to proceed"
    await expect(
      setInService(f.admin, assetId, { mode: 'set', inServiceOn: '2026-10-01', reason: 'correction' }),
    ).rejects.toThrow(/Chiller — moving the in-service date reverses 7 depreciation entries \(2026-03–2026-09\), ₱7,000\.00; confirm to proceed/);
    // Nothing was reversed.
    for (const m of ['03', '04', '05', '06', '07', '08', '09']) {
      expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-${m}`))?.status).toBe('posted');
    }
  });

  it('with confirmReversal: 03-05 reversed today with [prior period]; 06-09 reversed on their own dates, no prefix; October kept; accumulated 1,000; drift empty', async () => {
    const { f, assetId } = await postedThroughOctober('i6-confirm');
    await setInService(f.admin, assetId, {
      mode: 'set',
      inServiceOn: '2026-10-01',
      reason: 'correction',
      confirm: true,
    });

    const today = await manilaTodayRaw();
    for (const m of ['03', '04', '05']) {
      const entry = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-${m}`);
      expect(entry?.status).toBe('reversed');
      const reversal = await reversalOf(f.orgId, entry!.id);
      expect(reversal?.entry_date).toBe(today);
      expect(reversal?.memo).toMatch(/^\[prior period\]/);
    }
    for (const m of ['06', '07', '08', '09']) {
      const entry = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-${m}`);
      expect(entry?.status).toBe('reversed');
      const reversal = await reversalOf(f.orgId, entry!.id);
      // Its own period is open: reverseEntry defaults reversalDate to the original's own date.
      expect(reversal?.entry_date).toBe(entry!.entry_date);
      expect(reversal?.memo).not.toMatch(/^\[prior period\]/);
    }

    const oct = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-10`);
    expect(oct?.status).toBe('posted');

    const accumulated = await withOrgPrincipal(f.orgId, (tx) =>
      fixedAssetsRepo.accumulatedFromLedger(tx, f.orgId, assetId),
    );
    expect(String(accumulated)).toBe('1000.00');

    const drift = await withOrgPrincipal(f.orgId, (tx) => depreciationDrift(tx, f.admin, { through: '2026-10' }));
    expect(drift.filter((d) => d.assetId === assetId)).toEqual([]);
  });
});

// =================================================================================================
// I7 — R1.5: moving the STORE's opening date EARLIER re-opens newly-owed months for a follower
// =================================================================================================

describe('I7 — moving the store\'s opening date earlier re-opens the newly-owed months', () => {
  it('October already posted; opening moves to 2026-08-01: the next run posts 08 and 09; no second October', async () => {
    const f = await rolesFixture('i7', '2026-10-01');
    await insertMonths(f.orgId, 2026, 1, 2026, 10);
    const assetId = await makeAsset(f); // acquired 2026-03-15, held until the store opens 10-01
    await runThrough(f.orgId, '2026-10');
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-10`)).toBe(1);

    await setStoreOpening(f.admin, f.storeId, { openingDate: '2026-08-01' });
    expect((await inServiceOf(assetId)).on).toBe('2026-08-01');

    await runThrough(f.orgId, '2026-10');
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-08`)).toBe(1);
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-09`)).toBe(1);
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-10`)).toBe(1);
  });
});

// =================================================================================================
// I8 — DEF-435: a KEPT month whose amount disagrees under the new schedule is refused, nothing
// reversed
// =================================================================================================

describe('I8 — DEF-435 lifted: moving in-service earlier makes a still-owed month\'s amount disagree — it is reversed and re-booked', () => {
  it('cost 1,000/3mo, set Feb, Feb-Apr posted (333.33/333.33/333.34); moving to Jan makes March owe 333.34 but it posted 333.33 — March and April reversed, March re-books as #2 at 333.34', async () => {
    const f = await rolesFixture('i8');
    await insertMonths(f.orgId, 2026, 1, 2026, 4);
    const assetId = await makeAsset(f, {
      cost: '1000.00',
      usefulLifeMonths: 3,
      acquiredOn: '2026-01-01',
      inServiceSource: 'set',
      inServiceOn: '2026-02-01',
    } as Record<string, unknown>);
    await runThrough(f.orgId, '2026-04');

    // T-368 S2 (DEF-435 lifted): was I8, a refusal. Moving to Jan makes March owe 333.34 (posted 333.33) and April owe nothing, so
    // BOTH are simply reversed - through a real plan token - and the next run re-books what is owed in an open month.
    const moved = await setInService(f.admin, assetId, { mode: 'set', inServiceOn: '2026-01-01', reason: 'earlier', confirm: true });
    expect(moved.reversed, 'the disagreeing and the no-longer-owed months are reversed').toEqual(['2026-03', '2026-04']);
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-02`))?.status).toBe('posted');
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-03`))?.status).toBe('reversed');
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-04`))?.status).toBe('reversed');
    const rerun = await runThrough(f.orgId, '2026-04');
    const march = rerun.posted.find((x) => x.assetId === assetId && x.period === '2026-03');
    expect(march?.created, 'March re-books after its reversal (DEF-435)').toBe(true);
    const rebooked = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-03#2`);
    expect(rebooked?.status).toBe('posted');
    expect((await linesFor(rebooked!.id)).find((l) => l.code === '6700')?.debit).toBe('333.34');

  });
});

// =================================================================================================
// I9 — DB, APP role, raw SQL: the migration's own fill/guard triggers and CHECK. Appended to
// packages/db/tests/integration/t346-migrations.test.ts (R1.9), not here — kept with M1's own
// scratch-DB proof technique.
// =================================================================================================

// =================================================================================================
// I10 — T-345: a HELD asset owes nothing to the catch-up; a correction reverses a prior catch-up
// =================================================================================================

describe('I10 — a HELD asset and T-345\'s catch-up', () => {
  it('bookMissedMonth(2026-04) refuses /owes nothing for 2026-04/; missedMonths omits it', async () => {
    const f = await rolesFixture('i10'); // held — no opening date
    await insertMonths(f.orgId, 2026, 1, 2026, 3, { status: 'closed', closedAt: '2026-04-01T00:00:00Z', closedBy: f.adminId });
    // Through REAL today, open — so this reds on the "owes nothing" refusal itself (S2's own
    // mechanism, once bookMissedMonth honours in_service_on via R4.1's scheduleInputFor carve-out),
    // never on an incidental "no fiscal period covers bookOn" from an under-provisioned fixture —
    // bookOn defaults to Manila today, and postEntry needs an open period to cover it.
    const today = await manilaTodayRaw();
    const [todayY, todayM] = today.split('-').map(Number) as [number, number];
    await insertMonths(f.orgId, 2026, 5, todayY, todayM);
    const assetId = await makeAsset(f);

    await expect(
      withOrgPrincipal(f.orgId, (tx) =>
        bookMissedMonth(tx, f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'x' }),
      ),
    ).rejects.toThrow(/owes nothing for 2026-04/);

    const rows = await withOrgPrincipal(f.orgId, (tx) => missedMonths(tx, f.orgId, '2026-04'));
    expect(rows.filter((r) => r.subjectId === assetId)).toEqual([]);
  });

  it('a T-345 catch-up booked for 04, then a correction to 10-01: the catch-up entry is reversed; the link count stays 1', async () => {
    const f = await rolesFixture('i10-correction', '2026-01-01'); // not held
    await insertMonths(f.orgId, 2026, 1, 2026, 3, { status: 'closed', closedAt: '2026-04-01T00:00:00Z', closedBy: f.adminId });
    await insertMonths(f.orgId, 2026, 5, 2026, 10);
    const assetId = await makeAsset(f);

    await withOrgPrincipal(f.orgId, (tx) =>
      bookMissedMonth(tx, f.admin, { schedule: 'depreciation', subjectId: assetId, belongsToPeriod: '2026-04', reason: 'catch up' }),
    );
    expect(await entryCountForKey(f.orgId, `asset:${assetId}:depreciation:2026-04`)).toBe(1);

    await setInService(f.admin, assetId, {
      mode: 'set',
      inServiceOn: '2026-10-01',
      reason: 'correction',
      confirm: true,
    });

    const entry = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-04`);
    expect(entry?.status).toBe('reversed');
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from missed_month_adjustments
      where org_id = ${f.orgId} and fixed_asset_id = ${assetId} and belongs_to_period = '2026-04'`;
    expect(row!.n).toBe(1);
  });
});

// =================================================================================================
// I11 — only manage_fixed_assets (admin, super_admin) may setAssetInService
// =================================================================================================

describe('I11 — manage_fixed_assets gates setAssetInService', () => {
  it('a manager may not', async () => {
    const f = await rolesFixture('i11-manager');
    const assetId = await makeAsset(f);
    await expect(setInService(f.manager, assetId, { mode: 'acquired', reason: 'x' })).rejects.toThrow(
      /may not 'manage_fixed_assets'/,
    );
  });

  it('staff may not', async () => {
    const f = await rolesFixture('i11-staff');
    const assetId = await makeAsset(f);
    await expect(setInService(f.staff, assetId, { mode: 'acquired', reason: 'x' })).rejects.toThrow(
      /may not 'manage_fixed_assets'/,
    );
  });

  it('super_admin resolves', async () => {
    const f = await rolesFixture('i11-sa', '2026-01-01');
    const assetId = await makeAsset(f);
    await setInService(f.superAdmin, assetId, { mode: 'set', inServiceOn: '2026-05-01', reason: 'x' });
    expect((await inServiceOf(assetId)).on).toBe('2026-05-01');
  });
});

// =================================================================================================
// I12 — disposing a HELD asset writes off the full cost; no 1590 line (nothing was ever depreciated)
// =================================================================================================

describe('I12 — disposing a HELD asset', () => {
  it('loss equals the full cost; no accumulated-depreciation line', async () => {
    const f = await rolesFixture('i12'); // held — no opening date
    await insertMonths(f.orgId, 2026, 6, 2026, 6); // postEntry needs an open period covering disposedOn
    const assetId = await makeAsset(f);
    expect((await inServiceOf(assetId)).on).toBeNull();

    const result = await withOrgPrincipal(f.orgId, (tx) =>
      disposeAsset(tx, f.admin, { assetId, disposedOn: '2026-06-01', reason: 'scrapped' }),
    );
    expect(result.loss).toBe('24000.00');
    expect(result.accumulated).toBe('0.00');
    const lines = await linesFor(result.journalEntryId);
    expect(lines.find((l) => l.code === '1590')).toBeUndefined();
  });
});

// =================================================================================================
// I13 — R1.5: moving in-service EARLIER can reverse posted months past the new final period; the
// same DEF-435 guard applies to whatever is still kept
// =================================================================================================

describe('I13 — R1.5: moving in-service earlier shortens the schedule; DEF-435 still applies', () => {
  it('cost 3,000/3mo, set Feb, Feb-Apr posted (1,000 each); moving to Jan reverses only April; the next run posts January; Feb/Mar untouched', async () => {
    const f = await rolesFixture('i13-shorten');
    await insertMonths(f.orgId, 2026, 1, 2026, 4);
    const assetId = await makeAsset(f, {
      cost: '3000.00',
      usefulLifeMonths: 3,
      // Acquired BEFORE the January move below — `in_service_on >= acquired_on` is a DB CHECK
      // (fixed_assets_in_service_shape_check), so 2026-01-15 (the file's own default acquiredOn)
      // would make moving in-service to 2026-01-01 itself illegal, for a reason unrelated to R1.5.
      acquiredOn: '2025-12-15',
      inServiceSource: 'set',
      inServiceOn: '2026-02-01',
    } as Record<string, unknown>);
    await runThrough(f.orgId, '2026-04');

    await setInService(f.admin, assetId, {
      mode: 'set',
      inServiceOn: '2026-01-01',
      reason: 'earlier',
      confirm: true,
    });

    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-04`))?.status).toBe('reversed');
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-02`))?.status).toBe('posted');
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-03`))?.status).toBe('posted');

    const result = await runThrough(f.orgId, '2026-04');
    expect(result.posted.some((p) => p.assetId === assetId && p.period === '2026-01' && p.created)).toBe(true);
  });

  it('the same shape at cost 1,000 (March owes 333.34, posted 333.33): reversed and re-booked, no DEF-435', async () => {
    const f = await rolesFixture('i13-def435');
    await insertMonths(f.orgId, 2026, 1, 2026, 4);
    const assetId = await makeAsset(f, {
      cost: '1000.00',
      usefulLifeMonths: 3,
      // Same reason as the case above — acquired before the January move, so a stray CHECK
      // violation can never masquerade as this test's own DEF-435 refusal.
      acquiredOn: '2025-12-15',
      inServiceSource: 'set',
      inServiceOn: '2026-02-01',
    } as Record<string, unknown>);
    await runThrough(f.orgId, '2026-04');

    // T-368 S2 (DEF-435 lifted): was I13b, a refusal. Moving to Jan makes March owe 333.34 (posted 333.33) and April owe nothing, so
    // BOTH are simply reversed - through a real plan token - and the next run re-books what is owed in an open month.
    const moved = await setInService(f.admin, assetId, { mode: 'set', inServiceOn: '2026-01-01', reason: 'earlier', confirm: true });
    expect(moved.reversed, 'the disagreeing and the no-longer-owed months are reversed').toEqual(['2026-03', '2026-04']);
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-02`))?.status).toBe('posted');
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-03`))?.status).toBe('reversed');
    expect((await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-04`))?.status).toBe('reversed');
    const rerun = await runThrough(f.orgId, '2026-04');
    const march = rerun.posted.find((x) => x.assetId === assetId && x.period === '2026-03');
    expect(march?.created, 'March re-books after its reversal (DEF-435)').toBe(true);
    const rebooked = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-03#2`);
    expect(rebooked?.status).toBe('posted');
    expect((await linesFor(rebooked!.id)).find((l) => l.code === '6700')?.debit).toBe('333.34');
  });

  it('⛔ the raw UPDATE moving in_service_on past the new final period is refused by the DB guard directly', async () => {
    const f = await rolesFixture('i13-raw');
    await insertMonths(f.orgId, 2026, 1, 2026, 4);
    const assetId = await makeAsset(f, {
      cost: '3000.00',
      usefulLifeMonths: 3,
      // Same CHECK-ordering reason as the two cases above — acquired before the January move.
      acquiredOn: '2025-12-15',
      inServiceSource: 'set',
      inServiceOn: '2026-02-01',
    } as Record<string, unknown>);
    await runThrough(f.orgId, '2026-04'); // Apr posted; a 3-month life from Jan ends in March.
    await expect(
      sql`update fixed_assets set in_service_source = 'set', in_service_on = '2026-01-01' where id = ${assetId}`,
    ).rejects.toMatchObject({ code: 'P0001' });
  });
});

// =================================================================================================
// I14 — Amendment R4.4: propagating a store's opening date must SKIP a disposed follower entirely.
// A disposed asset's history is closed, off the active register, and not subject to further
// depreciation (dispose.ts's own header) — the propagation must never reverse its entries, move its
// in_service_on, or let its own posted history block the update with a guard error naming it. The
// still-active follower is handled exactly as the other I-cases already specify.
//
// ⭐ This one test pins BOTH the cascade's status filter AND its propagation filter at once, and
// deliberately so: a fix that only excludes disposed assets from the cascade, but ALSO stops
// propagating to genuinely active followers (over-filtered), would pass "the disposed one is
// untouched" while failing "the active one reverses normally" — and a fix that filters nothing at
// all fails the opposite half. Each half-fix fails this test from the opposite direction; only the
// correct filter (active in, disposed out) passes both assertions together.
// =================================================================================================

describe('I14 — a disposed follower is untouched by opening-date propagation (R4.4)', () => {
  it('disposing one of two store_opening followers, then moving the opening date later: the disposed one keeps its history and its in_service_on; no guard error; the active one reverses normally', async () => {
    // Store opens AFTER acquisition — the fill rule's "store_opening if opening_date IS NULL OR >
    // acquired_on" only resolves store_opening on that branch (same lesson as I13/R4.2/R1.1 above).
    const f = await rolesFixture('i14', '2026-02-01');
    await insertMonths(f.orgId, 2026, 1, 2026, 7);
    const activeId = await makeAsset(f, { name: 'Active Chiller', acquiredOn: '2026-01-01' } as Record<string, unknown>);
    const disposedId = await makeAsset(f, { name: 'Disposed Chiller', acquiredOn: '2026-01-01' } as Record<string, unknown>);
    expect(await inServiceOf(activeId)).toEqual({ source: 'store_opening', on: '2026-02-01' });
    expect(await inServiceOf(disposedId)).toEqual({ source: 'store_opening', on: '2026-02-01' });

    await runThrough(f.orgId, '2026-04'); // both post Feb, Mar, Apr

    await withOrgPrincipal(f.orgId, (tx) =>
      disposeAsset(tx, f.admin, { assetId: disposedId, disposedOn: '2026-05-01', reason: 'scrapped' }),
    );
    const disposedInServiceBefore = await inServiceOf(disposedId);

    await setStoreOpening(f.admin, f.storeId, { openingDate: '2026-07-01', confirm: true });

    // The disposed asset: completely untouched — no reversal, no in-service move, no guard error
    // blocking the whole call.
    expect(await inServiceOf(disposedId)).toEqual(disposedInServiceBefore);
    for (const m of ['02', '03', '04']) {
      expect((await entryRow(f.orgId, `asset:${disposedId}:depreciation:2026-${m}`))?.status).toBe('posted');
    }

    // The active asset: moved to 2026-07-01 and its now-unowed early months reversed, exactly as
    // I2/I6/I7's own mechanics already specify.
    expect((await inServiceOf(activeId)).on).toBe('2026-07-01');
    for (const m of ['02', '03', '04']) {
      expect((await entryRow(f.orgId, `asset:${activeId}:depreciation:2026-${m}`))?.status).toBe('reversed');
    }
  });
});

// =================================================================================================
// I15 — Amendment R4.5: a positive control. `createAsset` with NO in-service choice at all, at a
// store with no opening date, already holds correctly at the DOMAIN level (I1 proves the same
// shape more fully, with a real run posting nothing). R4.6's real defect lives in the
// `/fixed-assets/new` FORM's own default, not here — the S2 screen test covers that. This case
// exists so a screen-level failure can never be mistaken for a domain-level one: if this is green
// and the screen still shows the wrong default, the bug is in the form, not the schedule.
// =================================================================================================

describe('I15 — createAsset with no in-service choice at a not-yet-open store (positive control)', () => {
  it('in_service_source store_opening, in_service_on NULL — held from creation alone', async () => {
    const f = await rolesFixture('i15'); // no opening date
    const assetId = await makeAsset(f);
    expect(await inServiceOf(assetId)).toEqual({ source: 'store_opening', on: null });
  });
});
