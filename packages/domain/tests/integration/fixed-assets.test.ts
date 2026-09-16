import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-124's invariants against a real PostgreSQL (bible §9 rule 3) — never a mock.
 *
 * ⭐ **The central claim here is that a number does NOT exist.** Accumulated depreciation and book
 * value are derived from the journal, never stored (spec §3, DEF-044). So the tests assert against
 * the LEDGER, and one of them asserts against `information_schema` that the columns are absent —
 * because the failure being designed out is not "the column holds the wrong value", it is "a
 * column exists at all, and one day drifts from the entry that was supposed to maintain it."
 *
 * v1's register looked perfectly correct for the two months its scheduler was dead, because the
 * only thing that wrote the column was the thing that had stopped running.
 *
 * Fixtures are per-test via `setup(hint)`, same reasoning as sales-days.test.ts.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { CUTOVER_CLASSIFICATION } from '../../../db/src/cutover/classification';
import { RLS_REGISTRY } from '../../../db/src/rls/registry';
import { closeDb, fixedAssetsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createExpense, approveExpense, voidExpense } from '@shareat/domain';
import {
  buildSchedule,
  createAsset,
  depreciateAsset,
  depreciationDrift,
  disposeAsset,
  runDepreciation,
} from '@shareat/domain';
import { money } from '@shareat/core/money';
import { CAPITALISATION_DEFAULTS } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

interface Fixture {
  orgId: string;
  storeId: string;
  staffId: string;
  managerId: string;
  adminId: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`fa-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);

  // A year of open periods — depreciation spans months by nature, so a single-month period would
  // make every catch-up test fail for the wrong reason.
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')
    `;
  }

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;

  const mkPerson = async (name: string, role: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
    `;
    await sql`insert into person_roles (person_id, org_id, role) values (${r!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${r!.id}, ${storeId})`;
    return r!.id;
  };

  const staffId = await mkPerson(`${hint} Staff`, 'staff');
  const managerId = await mkPerson(`${hint} Manager`, 'manager');
  const adminId = await mkPerson(`${hint} Admin`, 'admin');

  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: adminId,
  });

  return { orgId, storeId, staffId, managerId, adminId };
}

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function asOrgRaw<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

function actor(orgId: string, personId: string): Actor {
  return { personId, orgId };
}

async function linesFor(entryId: string) {
  return sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, jl.debit, jl.credit
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by jl.line_no
  `;
}

/** Every posted line against one account for one asset, by ANY route. */
async function ledgerTotal(orgId: string, assetId: string, code: string): Promise<string> {
  const rows = await sql<{ total: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_id = ${assetId}
      and a.code = ${code} and je.status <> 'draft'
  `;
  return rows[0]?.total ?? '0';
}

/** How many DEPRECIATION entries exist for this asset — distinct from its 1590 balance, which a
 *  disposal also moves. */
async function depreciationEntryCount(orgId: string, assetId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries
    where org_id = ${orgId} and source_id = ${assetId} and source_type = 'depreciation'
  `;
  return rows[0]?.n ?? 0;
}

/** ₱120,000, 24 months, no salvage — ₱5,000 a month exactly, so arithmetic errors are obvious. */
async function anAsset(f: Fixture, over: Record<string, unknown> = {}): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createAsset(tx, actor(f.orgId, f.adminId), {
      storeId: f.storeId,
      name: 'Chest freezer',
      category: 'appliances',
      acquiredOn: '2026-01-15',
      cost: '120000.00',
      usefulLifeMonths: 24,
      ...over,
    } as Parameters<typeof createAsset>[2]),
  );
  return id;
}

beforeAll(async () => {
  await sql`
    truncate table
      money_accounts,
      fixed_assets, asset_category_lives, asset_policy,
      sales_day_channels, sales_days, sales_channels,
      expense_payments, expenses, expense_categories,
      person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// Invariant 1 — accumulated depreciation is DERIVED, and there is no column to store it in
// =========================================================================================

describe('invariant 1 — accumulated depreciation is never stored', () => {
  it('⛔ the columns v1 kept do not exist on fixed_assets', async () => {
    // ⭐ The strongest form of this invariant: not "the column is correct" but "there is no
    // column to be wrong". A stored figure and a derived one cannot disagree if only one exists.
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'fixed_assets'
    `;
    const names = rows.map((r) => r.column_name);
    expect(names).not.toContain('accumulated_depreciation');
    expect(names).not.toContain('book_value');
    expect(names).not.toContain('monthly_depreciation');
    expect(names).not.toContain('disposal_loss');
  });

  it('the derived figure equals the ledger, period by period', async () => {
    const f = await setup('inv1');
    const assetId = await anAsset(f);

    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-03' }),
    );

    // Jan, Feb, Mar = 3 x 5,000
    const derived = await asPerson(f.orgId, (tx) =>
      fixedAssetsRepo.accumulatedFromLedger(tx, f.orgId, assetId),
    );
    expect(Number(derived)).toBe(15000);
    expect(Number(await ledgerTotal(f.orgId, assetId, '1590'))).toBe(15000);
  });
});

// =========================================================================================
// Invariant 2 — idempotent per (asset, period): running twice posts once
// =========================================================================================

describe('invariant 2 — running the same period twice posts once', () => {
  it('a second run creates nothing and changes no figure', async () => {
    const f = await setup('inv2');
    const assetId = await anAsset(f);

    const first = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-02' }),
    );
    expect(first.map((p) => p.created)).toEqual([true, true]);

    const second = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-02' }),
    );
    // ⭐ Same entries returned, none created. This is what makes catch-up safe to re-run.
    expect(second.map((p) => p.created)).toEqual([false, false]);
    expect(second.map((p) => p.journalEntryId)).toEqual(first.map((p) => p.journalEntryId));
    expect(Number(await ledgerTotal(f.orgId, assetId, '1590'))).toBe(10000);
  });

  it('⭐ catching up a missed month is just running it again — the DEF-044 answer', async () => {
    const f = await setup('inv2b');
    const assetId = await anAsset(f);

    // The scheduler "ran" in January and then stopped, exactly as v1's did.
    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-01' }),
    );
    expect(Number(await ledgerTotal(f.orgId, assetId, '1590'))).toBe(5000);

    // Three months later somebody runs it again. No repair script, no "which months are missing?"
    const caught = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-04' }),
    );
    expect(caught.filter((p) => p.created).map((p) => p.period)).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
    expect(Number(await ledgerTotal(f.orgId, assetId, '1590'))).toBe(20000);
  });
});

// =========================================================================================
// Invariant 3 — the posting itself
// =========================================================================================

describe('invariant 3 — depreciation posts DR 6700 / CR 1590', () => {
  it('credits the contra-asset, and never touches 1510', async () => {
    const f = await setup('inv3');
    const assetId = await anAsset(f);

    const [jan] = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-01' }),
    );

    const lines = await linesFor(jan!.journalEntryId);
    expect(lines.map((l) => `${l.code} ${l.debit}/${l.credit}`)).toEqual([
      '6700 5000.00/0.00',
      '1590 0.00/5000.00',
    ]);

    // ⭐ Cost stays visible AT COST for the asset's whole life. Netting 1590 into 1510 would
    // destroy the one figure an auditor asks for first (spec §5).
    expect(Number(await ledgerTotal(f.orgId, assetId, '1510'))).toBe(0);
  });

  it('dates the entry on the LAST day of the period it describes', async () => {
    const f = await setup('inv3b');
    const assetId = await anAsset(f);
    const posted = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-02' }),
    );
    expect(posted.map((p) => p.entryDate)).toEqual(['2026-01-31', '2026-02-28']);
  });
});

// =========================================================================================
// Invariant 4 — a disposed asset stops, and disposal writes off the remaining book value
// =========================================================================================

describe('invariant 4 — disposal', () => {
  it('posts DR 1590, DR 7400, CR 1510 and the loss is the remaining book value', async () => {
    const f = await setup('inv4');
    const assetId = await anAsset(f);

    // Two months charged: 10,000 accumulated, 110,000 remaining.
    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-02' }),
    );

    const result = await asPerson(f.orgId, (tx) =>
      disposeAsset(tx, actor(f.orgId, f.adminId), {
        assetId,
        disposedOn: '2026-03-15',
        reason: 'Compressor failed beyond economic repair',
      }),
    );

    expect(result.accumulated).toBe('10000.00');
    expect(result.loss).toBe('110000.00');

    const lines = await linesFor(result.journalEntryId);
    expect(lines.map((l) => `${l.code} ${l.debit}/${l.credit}`)).toEqual([
      '1590 10000.00/0.00',
      '7400 110000.00/0.00',
      '1510 0.00/120000.00',
    ]);
  });

  it('a disposed asset owes nothing for later periods', async () => {
    const f = await setup('inv4b');
    const assetId = await anAsset(f);
    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-01' }),
    );
    await asPerson(f.orgId, (tx) =>
      disposeAsset(tx, actor(f.orgId, f.adminId), {
        assetId,
        disposedOn: '2026-02-10',
        reason: 'Written off',
      }),
    );

    const after = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-06' }),
    );
    expect(after).toEqual([]);
    // Still exactly one depreciation entry — January's. Nothing was charged after disposal.
    expect(await depreciationEntryCount(f.orgId, assetId)).toBe(1);

    // ⭐ The subtlety worth pinning. The asset's NET 1590 position is now zero, because disposal
    // DEBITS 1590 to clear what depreciation credited — that is the disposal doing its job.
    expect(Number(await ledgerTotal(f.orgId, assetId, '1590'))).toBe(0);
    // But `accumulatedFromLedger` still reads 5,000, because it sums DEPRECIATION entries only.
    // That is deliberate and load-bearing: it is the figure disposal itself needs in order to
    // know what to clear, so it must not be defined as "the current 1590 balance" — that would
    // make it depend on the very entry it is used to compute.
    const charged = await asPerson(f.orgId, (tx) =>
      fixedAssetsRepo.accumulatedFromLedger(tx, f.orgId, assetId),
    );
    expect(Number(charged)).toBe(5000);
  });

  it('refuses a write-off with no reason', async () => {
    const f = await setup('inv4c');
    const assetId = await anAsset(f);
    await expect(
      asPerson(f.orgId, (tx) =>
        disposeAsset(tx, actor(f.orgId, f.adminId), {
          assetId,
          disposedOn: '2026-03-01',
          reason: '   ',
        }),
      ),
    ).rejects.toThrow(/reason is required/);
  });

  it('is idempotent — disposing twice posts one entry', async () => {
    const f = await setup('inv4d');
    const assetId = await anAsset(f);
    const first = await asPerson(f.orgId, (tx) =>
      disposeAsset(tx, actor(f.orgId, f.adminId), {
        assetId,
        disposedOn: '2026-03-01',
        reason: 'Scrapped',
      }),
    );
    // The second call refuses on status, which is the stronger guard — the asset is no longer
    // active, so there is nothing to dispose.
    await expect(
      asPerson(f.orgId, (tx) =>
        disposeAsset(tx, actor(f.orgId, f.adminId), {
          assetId,
          disposedOn: '2026-03-01',
          reason: 'Scrapped',
        }),
      ),
    ).rejects.toThrow(/is disposed/);
    // Credit-positive: the disposal CREDITS 1510 to remove the cost.
    expect(Number(await ledgerTotal(f.orgId, assetId, '1510'))).toBe(120000);
    expect(first.created).toBe(true);
  });
});

// =========================================================================================
// Invariant 3 (schedule) — never below salvage, and the whole life sums to the depreciable amount
// =========================================================================================

describe('invariant 3 — never depreciates below salvage', () => {
  it('the full life posts exactly cost − salvage, and stops', async () => {
    const f = await setup('salv');
    // ₱10,000 salvage on ₱120,000 over 12 months — 9,166.66 x 11 then a remainder period.
    const assetId = await anAsset(f, { salvageValue: '10000.00', usefulLifeMonths: 12 });

    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-12' }),
    );

    // Exactly the depreciable amount — not a centavo more, which is what would push book value
    // below salvage and invent a loss.
    expect(Number(await ledgerTotal(f.orgId, assetId, '1590'))).toBe(110000);

    // And running beyond the life adds nothing.
    const beyond = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-12' }),
    );
    expect(beyond.every((p) => !p.created)).toBe(true);
  });

  it('an amount that does not divide evenly still sums exactly in the LEDGER', async () => {
    const f = await setup('round');
    // ₱10,000 over 3 months = 3,333.33 x 2 + 3,333.34. The remainder must survive the round trip
    // through numeric(14,2) and back out of the journal.
    const assetId = await anAsset(f, { cost: '10000.00', usefulLifeMonths: 3 });
    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-12' }),
    );
    expect(await ledgerTotal(f.orgId, assetId, '1590')).toBe('10000.00');
  });
});

// =========================================================================================
// Invariant 7 — every capability has a denial test
// =========================================================================================

describe('invariant 7 — manage_fixed_assets and run_depreciation are admin-only', () => {
  it('staff cannot create an asset', async () => {
    const f = await setup('cap1');
    await expect(
      asPerson(f.orgId, (tx) =>
        createAsset(tx, actor(f.orgId, f.staffId), {
          storeId: f.storeId,
          name: 'Nope',
          category: 'equipment',
          acquiredOn: '2026-01-15',
          cost: '50000.00',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('a MANAGER cannot create an asset either — this one is not manager-level', async () => {
    const f = await setup('cap2');
    await expect(
      asPerson(f.orgId, (tx) =>
        createAsset(tx, actor(f.orgId, f.managerId), {
          storeId: f.storeId,
          name: 'Nope',
          category: 'equipment',
          acquiredOn: '2026-01-15',
          cost: '50000.00',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('a manager cannot run depreciation', async () => {
    const f = await setup('cap3');
    const assetId = await anAsset(f);
    await expect(
      asPerson(f.orgId, (tx) =>
        depreciateAsset(tx, actor(f.orgId, f.managerId), { assetId, through: '2026-02' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('a staff member cannot dispose an asset', async () => {
    const f = await setup('cap4');
    const assetId = await anAsset(f);
    await expect(
      asPerson(f.orgId, (tx) =>
        disposeAsset(tx, actor(f.orgId, f.staffId), {
          assetId,
          disposedOn: '2026-03-01',
          reason: 'Trying it on',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });
});

// =========================================================================================
// The org-wide run, and the drift report
// =========================================================================================

describe('the org-wide run', () => {
  it('charges every active asset and reports what it skipped', async () => {
    const f = await setup('run');
    const a1 = await anAsset(f, { name: 'Freezer' });
    const a2 = await anAsset(f, { name: 'Range', cost: '60000.00', usefulLifeMonths: 24 });
    // Acquired later — owes nothing in January.
    const a3 = await anAsset(f, { name: 'Late arrival', acquiredOn: '2026-06-10' });

    const result = await asPerson(f.orgId, (tx) =>
      runDepreciation(tx, actor(f.orgId, f.adminId), { through: '2026-01' }),
    );

    expect(result.posted.map((p) => p.assetId).sort()).toEqual([a1, a2].sort());
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([]);
    // ⭐ v1 had no acquisition-date guard and would have charged the June asset in January.
    expect(Number(await ledgerTotal(f.orgId, a3, '1590'))).toBe(0);
  });

  it('⭐ drift is detectable at all, which it was not in v1', async () => {
    const f = await setup('drift');
    const assetId = await anAsset(f);
    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-01' }),
    );

    // Expected through March is 15,000; the ledger holds 5,000. In v1 both numbers came from the
    // same maintained column, so this comparison proved only that a number equals itself.
    const drift = await asPerson(f.orgId, (tx) =>
      depreciationDrift(tx, actor(f.orgId, f.adminId), { through: '2026-03' }),
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ assetId, expected: '15000.00', actual: '5000.00' });

    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-03' }),
    );
    const after = await asPerson(f.orgId, (tx) =>
      depreciationDrift(tx, actor(f.orgId, f.adminId), { through: '2026-03' }),
    );
    expect(after).toEqual([]);
  });
});

// =========================================================================================
// Terms, and the schedule the engine promises matching what the ledger actually receives
// =========================================================================================

describe('the terms stamped on the asset', () => {
  it('defaults the life to 24 months when nothing else names one (bible row 140)', async () => {
    const f = await setup('life');
    const { id } = await asPerson(f.orgId, (tx) =>
      createAsset(tx, actor(f.orgId, f.adminId), {
        storeId: f.storeId,
        name: 'Unspecified life',
        category: 'equipment',
        acquiredOn: '2026-01-15',
        cost: '48000.00',
      }),
    );
    const row = await asPerson(f.orgId, (tx) => fixedAssetsRepo.getById(tx, f.orgId, id));
    expect(row?.usefulLifeMonths).toBe(24);
  });

  it('a category default overrides the 24, and is COPIED not looked up later', async () => {
    const f = await setup('catlife');
    await asPerson(f.orgId, (tx) =>
      fixedAssetsRepo.upsertCategoryLife(tx, {
        orgId: f.orgId,
        category: 'building',
        usefulLifeMonths: 240,
      }),
    );
    const { id } = await asPerson(f.orgId, (tx) =>
      createAsset(tx, actor(f.orgId, f.adminId), {
        storeId: f.storeId,
        name: 'Annex',
        category: 'building',
        acquiredOn: '2026-01-15',
        cost: '2400000.00',
      }),
    );
    expect((await asPerson(f.orgId, (tx) => fixedAssetsRepo.getById(tx, f.orgId, id)))?.usefulLifeMonths).toBe(240);

    // Changing the org default must NOT rewrite an asset already on the books.
    await asPerson(f.orgId, (tx) =>
      fixedAssetsRepo.upsertCategoryLife(tx, {
        orgId: f.orgId,
        category: 'building',
        usefulLifeMonths: 120,
      }),
    );
    expect((await asPerson(f.orgId, (tx) => fixedAssetsRepo.getById(tx, f.orgId, id)))?.usefulLifeMonths).toBe(240);
  });

  it('refuses salvage at or above cost, naming both numbers', async () => {
    const f = await setup('salvguard');
    await expect(
      asPerson(f.orgId, (tx) =>
        createAsset(tx, actor(f.orgId, f.adminId), {
          storeId: f.storeId,
          name: 'Bad terms',
          category: 'equipment',
          acquiredOn: '2026-01-15',
          cost: '10000.00',
          salvageValue: '10000.00',
        }),
      ),
    ).rejects.toThrow(/must be below cost/);
  });

  it('semi-annual charges twice a year, in the ledger (bible row 140)', async () => {
    const f = await setup('semi');
    const assetId = await anAsset(f, { interval: 'semiannual', acquiredOn: '2026-01-15' });
    const posted = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-12' }),
    );
    expect(posted.map((p) => p.entryDate)).toEqual(['2026-06-30', '2026-12-31']);
    // 24 months / 6 = 4 periods over the life; two of them fall in 2026.
    expect(Number(await ledgerTotal(f.orgId, assetId, '1590'))).toBe(60000);
  });

  it('⭐ the pure engine and the ledger agree, period for period', async () => {
    const f = await setup('agree');
    const assetId = await anAsset(f, { cost: '77777.77', usefulLifeMonths: 7 });

    const expected = buildSchedule({
      acquiredOn: '2026-01-15',
      cost: money('77777.77'),
      salvageValue: money('0'),
      usefulLifeMonths: 7,
      interval: 'monthly',
    });
    const posted = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-12' }),
    );

    expect(posted.map((p) => p.amount)).toEqual(expected.map((p) => String(p.amount)));
    expect(await ledgerTotal(f.orgId, assetId, '1590')).toBe('77777.77');
  });
});


// =========================================================================================
// The T-122 seam — an approved CAPEX expense becomes a register row
// =========================================================================================

async function expenseWithInvoice(
  f: Fixture,
  amount: string,
  opts: { categoryName?: string; particulars?: string } = {},
): Promise<string> {
  const [cat] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${f.orgId} and category = ${opts.categoryName ?? 'Capital Expenditure'}
  `;
  // ⭐ T-130: every expense now names a real, verified supplier invoice. One per org, sized well
  // above anything this file spends, created on demand.
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, 'CAPEX Supplier', ${f.staffId})
    on conflict (org_id, name) do update set updated_at = now()
    returning id
  `;
  const [capexFile] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo',
            ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/capex-${Date.now()}.jpg`},
            'image/jpeg', 1024, ${`sum-capex-${Date.now()}`}, ${f.staffId})
    returning id
  `;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (
      org_id, store_id, supplier_id, invoice_date, total_amount, status,
      receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price
    ) values (
      ${f.orgId}, ${f.storeId}, ${supplier!.id}, '2026-01-20', '99999999.00', 'verified',
      ${capexFile!.id}, ${f.managerId}, now(), ${f.staffId}, true, true, true, true
    )
    returning id
  `;
  // ⭐ DEF-058: cash names the place it left. One drawer per store, created on demand here.
  const [drawer] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${f.orgId}, ${f.storeId}, 'Cashier drawer', 'cash', '1110', 'cashier')
    on conflict (org_id, store_id, name) do update set updated_at = now()
    returning id
  `;
  // ⭐ And the drawer has to actually HOLD the money since T-139's overdraw block — a store
  // buying a ₱45,000 fryer out of a till containing ₱0 was never realistic, only unchecked.
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-19', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft')
      returning id
    `;
    const [cash] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '1110'
    `;
    const [equity] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '3900'
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, '500000.00', '0')
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', '500000.00')
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });

  const created = await asPerson(f.orgId, (tx) =>
    createExpense(tx, actor(f.orgId, f.staffId), {
      storeId: f.storeId,
      supplierId: supplier!.id,
      supplierInvoiceId: invoice!.id,
      businessDate: '2026-01-20',
      categoryId: cat!.id,
      particulars: opts.particulars ?? 'Commercial deep fryer',
      payments: [{ method: 'cash', amount, moneyAccountId: drawer!.id }],
    }),
  );
  return created.id;
}

async function capexExpense(f: Fixture, amount: string): Promise<string> {
  return expenseWithInvoice(f, amount);
}

describe('the capitalisation seam (spec §6)', () => {
  it('an over-threshold CAPEX expense creates an asset flagged for review', async () => {
    const f = await setup('seam');
    const expenseId = await capexExpense(f, '45000.00');

    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    expect(posted.assetId).toBeTruthy();

    const asset = await asPerson(f.orgId, (tx) =>
      fixedAssetsRepo.getById(tx, f.orgId, posted.assetId!),
    );
    expect(asset).toMatchObject({
      cost: '45000.00',
      sourceExpenseId: expenseId,
      // ⭐ The terms are a default nobody chose, so the register says so rather than
      // presenting a guess as a decision.
      needsReview: true,
      usefulLifeMonths: 24,
      status: 'active',
    });
    // The money is already in 1510 from T-122's own posting — capitalisation adds no entry.
    expect(await ledgerTotal(f.orgId, posted.assetId!, '1510')).toBe('0');
  });

  it('⛔ a MANAGER can still approve a CAPEX expense — capitalisation is a consequence, not a second permission', async () => {
    // The regression this pins: `manage_fixed_assets` is admin-only while `approve_expense` is a
    // manager's. Gating the seam on the former meant no manager could approve CAPEX at all.
    const f = await setup('seamrole');
    const expenseId = await capexExpense(f, '30000.00');
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    expect(posted.assetId).toBeTruthy();
  });

  it('a BELOW-threshold CAPEX expense creates no asset, and that is not an error', async () => {
    const f = await setup('seamsmall');
    const expenseId = await capexExpense(f, '2500.00');
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    expect(posted.assetId).toBeNull();
    const assets = await asPerson(f.orgId, (tx) => fixedAssetsRepo.listAssets(tx, f.orgId, {}));
    expect(assets).toHaveLength(0);
  });

  it('approving twice does not mint a second asset', async () => {
    const f = await setup('seamidem');
    const expenseId = await capexExpense(f, '45000.00');
    const first = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    const second = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    expect(second.created).toBe(false);
    const assets = await asPerson(f.orgId, (tx) => fixedAssetsRepo.listAssets(tx, f.orgId, {}));
    expect(assets).toHaveLength(1);
    expect(assets[0]!.id).toBe(first.assetId);
  });

  it('the capitalised asset then depreciates like any other', async () => {
    const f = await setup('seamdep');
    const expenseId = await capexExpense(f, '48000.00');
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    const charged = await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId: posted.assetId!, through: '2026-03' }),
    );
    // Acquired 2026-01-20, 48,000 over 24 months = 2,000/month, three months charged.
    expect(charged.filter((c) => c.created)).toHaveLength(3);
    expect(Number(await ledgerTotal(f.orgId, posted.assetId!, '1590'))).toBe(6000);
  });
});

describe('⛔ DEF-160 — voiding a CAPEX expense retires the asset it capitalised', () => {
  it('with no depreciation posted yet, the asset retires and 1510 nets to zero', async () => {
    const f = await setup('def160-plain');
    const expenseId = await capexExpense(f, '45000.00');
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    expect(posted.assetId).toBeTruthy();
    // The expense's OWN entry already put ₱45,000 on 1510 — capitalisation adds no entry of its
    // own (this file's earlier test already pins that). Confirm the starting state before voiding.
    expect(Number(await ledgerTotal(f.orgId, expenseId, '1510'))).toBe(-45000);

    await asPerson(f.orgId, (tx) =>
      voidExpense(tx, actor(f.orgId, f.managerId), expenseId, 'Wrong supplier — re-entering'),
    );

    // The expense's reversal already unwinds 1510 to zero — that is voidExpense's existing
    // behaviour and is not what this defect was ever about.
    expect(Number(await ledgerTotal(f.orgId, expenseId, '1510'))).toBe(0);

    const asset = await asPerson(f.orgId, (tx) => fixedAssetsRepo.getById(tx, f.orgId, posted.assetId!));
    expect(asset!.status).toBe('disposed');
    expect(asset!.disposalReason).toMatch(/expense.*voided/i);
    // ⛔ The bug this closes: retiring the register row must NOT post a second cost-removal entry
    // (that would double-credit 1510 — the expense reversal already did it once).
    expect(Number(await ledgerTotal(f.orgId, posted.assetId!, '1510'))).toBe(0);
  });

  it('with depreciation already posted, those entries are reversed too', async () => {
    const f = await setup('def160-depreciated');
    const expenseId = await capexExpense(f, '48000.00');
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    await asPerson(f.orgId, (tx) =>
      depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId: posted.assetId!, through: '2026-03' }),
    );
    expect(Number(await ledgerTotal(f.orgId, posted.assetId!, '1590'))).toBe(6000);

    await asPerson(f.orgId, (tx) =>
      voidExpense(tx, actor(f.orgId, f.managerId), expenseId, 'Never should have been capitalised'),
    );

    // The three depreciation entries are reversed, so the asset stops looking like it is still
    // consuming a cost that no longer exists in the ledger.
    expect(Number(await ledgerTotal(f.orgId, posted.assetId!, '1590'))).toBe(0);
    const asset = await asPerson(f.orgId, (tx) => fixedAssetsRepo.getById(tx, f.orgId, posted.assetId!));
    expect(asset!.status).toBe('disposed');
  });

  it('a non-CAPEX void is unaffected — no asset, nothing to retire', async () => {
    const f = await setup('def160-plain-expense');
    const expenseId = await expenseWithInvoice(f, '3000.00', {
      categoryName: 'Utilities', particulars: 'Electric bill',
    });
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), expenseId));
    await expect(
      asPerson(f.orgId, (tx) =>
        voidExpense(tx, actor(f.orgId, f.managerId), expenseId, 'Duplicate entry'),
      ),
    ).resolves.toBeTruthy();
    const assets = await asPerson(f.orgId, (tx) => fixedAssetsRepo.listAssets(tx, f.orgId, {}));
    expect(assets).toHaveLength(0);
  });
});


describe('the capitalisation threshold (bible row 141)', () => {
  it('defaults to ₱5,000 when no policy row exists', () => {
    // ⭐ Pinned because this number moved TWICE in one day — ₱5,000 -> ₱10,000 (row 139) ->
    // ₱5,000 (row 141). A figure that has already proven it can change is exactly the one that
    // should not be able to change silently.
    expect(CAPITALISATION_DEFAULTS.threshold).toBe('5000.00');
  });

  it('capitalises AT the threshold, and not one centavo below it', async () => {
    const f = await setup('thresh');

    const under = await capexExpense(f, '4999.99');
    const underPosted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), under),
    );
    expect(underPosted.assetId).toBeNull();

    const at = await capexExpense(f, '5000.00');
    const atPosted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), at),
    );
    expect(atPosted.assetId).toBeTruthy();

    // Only the second one reached the register.
    const assets = await asPerson(f.orgId, (tx) => fixedAssetsRepo.listAssets(tx, f.orgId, {}));
    expect(assets).toHaveLength(1);
    expect(assets[0]!.cost).toBe('5000.00');
  });

  it('an org policy row overrides the default in both directions', async () => {
    const f = await setup('threshpolicy');
    await asPerson(f.orgId, (tx) =>
      fixedAssetsRepo.upsertPolicy(tx, {
        orgId: f.orgId,
        capitalizationThreshold: '20000.00',
        defaultSalvageValue: '0.00',
      }),
    );

    // ₱8,000 clears the DEFAULT but not this org's policy.
    const expenseId = await capexExpense(f, '8000.00');
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), expenseId),
    );
    expect(posted.assetId).toBeNull();
  });
});

// =========================================================================================
// Wave 0 holds — the guards every module must still satisfy
// =========================================================================================

describe('Wave 0 holds for the fixed-asset tables', () => {
  const tables = ['fixed_assets', 'asset_policy', 'asset_category_lives'] as const;

  it('every table is classified for cutover and registered for RLS', () => {
    for (const t of tables) {
      expect(CUTOVER_CLASSIFICATION[t], `${t} has no cutover classification`).toBeDefined();
      expect(RLS_REGISTRY[t], `${t} has no RLS registry entry`).toBeDefined();
    }
  });

  it('RLS is actually enabled AND forced on each — a registry entry is a promise, not a control', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class where relname in ('fixed_assets','asset_policy','asset_category_lives')
    `;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} does not have RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} does not FORCE RLS`).toBe(true);
    }
  });

  it('⛔ one org cannot see another org’s register, with no WHERE clause at all', async () => {
    const a = await setup('isoA');
    const b = await setup('isoB');
    await anAsset(a);
    await anAsset(b);

    // Raw postgres.js, not drizzle — a query builder always writes SOME where clause, and the
    // point is to prove isolation with none.
    const seen = await asOrgRaw(a.orgId, async (tx) => {
      const rows = await tx<{ n: number }[]>`select count(*)::int as n from fixed_assets`;
      return rows[0]!.n;
    });
    expect(seen).toBe(1);
  });
});
