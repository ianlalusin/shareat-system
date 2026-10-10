import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-123's invariants against a real PostgreSQL (bible §9 rule 3) — never a mock.
 *
 * ⭐ **The central claim this file exists to prove is a NEGATIVE**: an unverified sales day
 * contributes no revenue anywhere. It is asserted **against the ledger**, not against a reader —
 * because v1's bug was precisely that three separate readers each had to remember the rule, with a
 * code note saying *"keep them in sync if you add a 4th."* Asserting through a reader would
 * reproduce that mistake in the test suite.
 *
 * Fixtures are per-test via `setup(hint)`, same reasoning as expenses.test.ts: this file mutates
 * status heavily and a fresh org is cheaper to reason about than tracking what a prior test left
 * behind (bible §3.4 row 94).
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
import { CUTOVER_CLASSIFICATION } from '../../../db/src/cutover/classification';
import { RLS_REGISTRY } from '../../../db/src/rls/registry';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { submitThenVerify } from './_fixtures/sales-day-flow';
import {
  createSalesDay,
  TransitShortfallBlockedError,
  submitSalesDay,
  verifySalesDay,
  voidSalesDay,
  SalesDayBlockedError,
  InternalFaultError,
} from '@shareat/domain';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

interface Fixture {
  orgId: string;
  storeId: string;
  storeId2: string;
  staffId: string;
  managerId: string;
  adminId: string;
  walkInChannelId: string;
  foodpandaChannelId: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`sd-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')
  `;

  const mkStore = async (h: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id
    `;
    return r!.id;
  };
  const storeId = await mkStore(`${hint}-s1`);
  const storeId2 = await mkStore(`${hint}-s2`);

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
  // The admin's bypass is store-scope-driven (close_period needs org-wide scope, bible row 123),
  // so the admin is scoped to BOTH stores. Manager and staff stay on storeId only.
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId2})`;

  const mkChannel = async (name: string, remitted: boolean, receivable: string | null) => {
    const [r] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${storeId}, ${name}, ${remitted}, ${receivable})
      returning id
    `;
    return r!.id;
  };
  const walkInChannelId = await mkChannel('Walk-in', true, null);
  const foodpandaChannelId = await mkChannel('Foodpanda', false, '1220');

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: staffEmployment!.id, personId: staffId, setBy: managerId,
  });

  return { orgId, storeId, storeId2, staffId, managerId, adminId, walkInChannelId, foodpandaChannelId };
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

async function dayRow(id: string) {
  const [row] = await sql<
    { status: string; journal_entry_id: string | null; business_date: string; verified_by: string | null }[]
  >`select status, journal_entry_id, business_date, verified_by from sales_days where id = ${id}`;
  return row;
}

async function linesFor(entryId: string) {
  return sql<{ code: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]>`
    select a.code, jl.debit, jl.credit, jl.party_type, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by jl.line_no
  `;
}

/** How many journal lines exist for this sales day, by ANY route. The negative assertion —
 *  returns the number, not a row, so a caller cannot silently destructure `undefined`. */
async function ledgerLineCount(orgId: string, sourceId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where je.org_id = ${orgId} and je.source_id = ${sourceId}
  `;
  return rows[0]?.n ?? 0;
}

const D1 = '2026-01-10';
const D2 = '2026-01-11';
const D3 = '2026-01-12';

/** A day that balances on both identities: ₱1,000 unli, all cash. */
function simpleDay(storeId: string, businessDate: string) {
  return {
    storeId,
    businessDate,
    totalSales: '1000.00',
    unliSales: '1000.00',
    alaCarteSales: '0.00',
    cashCollected: '1000.00',
  };
}

beforeAll(async () => {
  await sql`
    truncate table
      trade_discrepancies, trade_order_lines, trade_orders, customers, items,
      money_accounts,
      sales_day_tenders, sales_day_channels, sales_days, sales_channels,
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
// Invariant 1 — an unverified day has NO journal entry
// =========================================================================================

describe('invariant 1 — an unverified sales day recognises NO revenue', () => {
  it('a created day writes NOTHING to the ledger', async () => {
    const f = await setup('inv1a');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );

    // ⭐ Asserted against journal_lines directly. v1's equivalent rule lived in three readers;
    // checking a reader here would prove only that ONE of them remembered.
    expect(await ledgerLineCount(f.orgId, id)).toBe(0);
    expect((await dayRow(id))!.journal_entry_id).toBeNull();
  });

  it('a SUBMITTED day still writes nothing — submitting is not recognising', async () => {
    const f = await setup('inv1b');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await asPerson(f.orgId, (tx) => submitSalesDay(tx, actor(f.orgId, f.staffId), id));

    expect((await dayRow(id))!.status).toBe('submitted');
    expect(await ledgerLineCount(f.orgId, id)).toBe(0);
  });
});

// =========================================================================================
// Invariant 2 — verifying posts, dated on the BUSINESS DATE
// =========================================================================================

describe('invariant 2 — verifying posts, and the entry dates on the business date', () => {
  it('posts DR 1110 / CR 4100 and dates on the business date, not today', async () => {
    const f = await setup('inv2');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    const res = await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));

    expect(res.created).toBe(true);
    const lines = await linesFor(res.journalEntryId);
    expect(lines.map((l) => `${l.code} ${l.debit}/${l.credit}`)).toEqual([
      '1110 1000.00/0.00',
      '4100 0.00/1000.00',
    ]);

    // ⭐ The whole point of bible row 126's third rule: a day verified later still lands in the
    // month it happened. Without this the create-block would just relocate the error.
    const [entry] = await sql<{ entry_date: string }[]>`
      select entry_date::text from journal_entries where id = ${res.journalEntryId}
    `;
    expect(entry!.entry_date).toBe(D1);

    const row = await dayRow(id);
    expect(row!.status).toBe('verified');
    expect(row!.verified_by).toBe(f.managerId);
  });

  it('re-verifying is idempotent — one entry, created:false the second time', async () => {
    const f = await setup('inv2b');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    const first = await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));
    const second = await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));

    expect(second.created).toBe(false);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    const entries = await sql<{ n: number }[]>`
      select count(*)::int as n from journal_entries where source_id = ${id}
    `;
    expect(entries[0]!.n).toBe(1);
  });
});

// =========================================================================================
// Invariant 3 — the create-block, and its three carve-outs
// =========================================================================================

describe('invariant 3 — the create-block holds, and its carve-outs stop it deadlocking', () => {
  it('BLOCKS a newer day while an older one is unverified', async () => {
    const f = await setup('inv3a');
    await asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)));

    await expect(
      asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D2))),
    ).rejects.toThrow(SalesDayBlockedError);
  });

  it('the block LIFTS once the older day is verified', async () => {
    const f = await setup('inv3b');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));

    const next = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D2)),
    );
    expect(next.id).toBeTruthy();
  });

  it('⭐ CARVE-OUT: backfilling an OLDER date is never blocked', async () => {
    // The gap that caused the block must always be fillable, or the rule deadlocks.
    const f = await setup('inv3c');
    await asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D2)));

    const older = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    expect(older.id).toBeTruthy();
  });

  it('⭐ CARVE-OUT: another STORE is unaffected — the block is per store', async () => {
    const f = await setup('inv3d');
    await asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)));

    // storeId2 has its own unverified history (none), so its day is free. Uses the admin, who
    // is the persona scoped to both stores.
    const other = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.adminId), simpleDay(f.storeId2, D2)),
    );
    expect(other.id).toBeTruthy();
  });

  it('⭐ an ADMIN bypasses the block', async () => {
    // v1 flipped to this deliberately in June 2026 at Ian's request. Do not "restore" the
    // stricter original on the strength of reading the first commit.
    const f = await setup('inv3e');
    await asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)));

    const byAdmin = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.adminId), simpleDay(f.storeId, D2)),
    );
    expect(byAdmin.id).toBeTruthy();
  });

  it('a VOIDED older day does not block — it is a decision, not an omission', async () => {
    const f = await setup('inv3f');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));
    await asPerson(f.orgId, (tx) => voidSalesDay(tx, actor(f.orgId, f.managerId), id, 'duplicate'));

    const next = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D2)),
    );
    expect(next.id).toBeTruthy();
  });
});

// =========================================================================================
// Invariant 4 — void REVERSES; both entries stand
// =========================================================================================

describe('invariant 4 — voiding reverses, and the original stands', () => {
  it('writes a mirrored reversal and leaves the original entry in place', async () => {
    const f = await setup('inv4');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    const posted = await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));
    const res = await asPerson(f.orgId, (tx) =>
      voidSalesDay(tx, actor(f.orgId, f.managerId), id, 'counted twice'),
    );

    const original = await linesFor(posted.journalEntryId);
    expect(res.reversalEntryId, 'a VERIFIED day void writes a reversal').not.toBeNull();
    const reversal = await linesFor(res.reversalEntryId!);
    expect(original.length).toBe(2);
    expect(reversal.length).toBe(2);

    // Every account nets to zero across the two entries.
    const net = new Map<string, number>();
    for (const l of [...original, ...reversal]) {
      net.set(l.code, (net.get(l.code) ?? 0) + Number(l.debit) - Number(l.credit));
    }
    for (const [code, v] of net) expect(`${code}=${v}`).toBe(`${code}=0`);

    expect((await dayRow(id))!.status).toBe('voided');
  });

  // T-369 S3 R3 (DEF-479) — this test used to pin "an UNVERIFIED day cannot be voided". That rule is
  // reversed on purpose: an unverified day is WITHDRAWN (nothing was posted, so nothing is reversed),
  // and a voided day cannot be voided again.
  it('an UNVERIFIED day is WITHDRAWN: status voided, reason stored, no reversal (reversalEntryId null), no journal entry — and a second void is refused', async () => {
    const f = await setup('inv4b');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    const res = await asPerson(f.orgId, (tx) => voidSalesDay(tx, actor(f.orgId, f.managerId), id, 'oops'));
    expect(res.reversalEntryId, 'nothing was posted, so nothing is reversed').toBeNull();
    expect((await dayRow(id))!.status).toBe('voided');
    expect(await ledgerLineCount(f.orgId, id), 'a withdrawn day has no ledger lines').toBe(0);

    await expect(
      asPerson(f.orgId, (tx) => voidSalesDay(tx, actor(f.orgId, f.managerId), id, 'again')),
    ).rejects.toThrow(/already voided/);
  });

  it('a void requires a reason', async () => {
    const f = await setup('inv4c');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));
    await expect(
      asPerson(f.orgId, (tx) => voidSalesDay(tx, actor(f.orgId, f.managerId), id, '   ')),
    ).rejects.toThrow(/reason is required/);
  });
});

// =========================================================================================
// Invariant 5 — non-remitted channels post a receivable; an unwired one BLOCKS
// =========================================================================================

describe('invariant 5 — non-remitted channels, and DEF-059 refused', () => {
  it('a Foodpanda channel posts DR 1220 with the channel as party', async () => {
    const f = await setup('inv5a');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        businessDate: D1,
        totalSales: '1500.00',
        unliSales: '0.00',
        alaCarteSales: '1500.00',
        cashCollected: '900.00',
        channels: [
          { channelId: f.walkInChannelId, amount: '900.00' },
          { channelId: f.foodpandaChannelId, amount: '600.00' },
        ],
      }),
    );
    const res = await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));
    const lines = await linesFor(res.journalEntryId);

    const receivable = lines.find((l) => l.code === '1220');
    expect(receivable).toBeDefined();
    expect(receivable!.debit).toBe('600.00');
    expect(receivable!.party_type).toBe('channel');
    expect(receivable!.party_id).toBe(f.foodpandaChannelId);
  });

  it('⛔ a non-remitted channel with NO receivable account cannot even be configured', async () => {
    // The schema refuses it, so the DEF-059 shape cannot exist to be routed. Belt and braces:
    // routing refuses it too (unit-tested), in case a row predates the constraint.
    const f = await setup('inv5b');
    await expect(
      sql`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
          values (${f.orgId}, ${f.storeId}, 'Broken', false, null)`,
    ).rejects.toThrow(/non_remitted_needs_receivable/);
  });

  it('a channel from ANOTHER store is refused', async () => {
    const f = await setup('inv5c');
    const [other] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${f.orgId}, ${f.storeId2}, 'Other store walk-in', true, null) returning id
    `;
    await expect(
      asPerson(f.orgId, (tx) =>
        createSalesDay(tx, actor(f.orgId, f.staffId), {
          ...simpleDay(f.storeId, D1),
          channels: [{ channelId: other!.id, amount: '0.00' }],
        }),
      ),
    ).rejects.toThrow(/is not configured for store/);
  });
});

// =========================================================================================
// Invariant 6 — a day that does not balance QUARANTINES
// =========================================================================================

describe('invariant 6 — a day that cannot balance blocks, and stays fixable', () => {
  it('the schema refuses a revenue split that does not equal the total', async () => {
    const f = await setup('inv6a');
    await expect(
      asPerson(f.orgId, (tx) =>
        createSalesDay(tx, actor(f.orgId, f.staffId), {
          storeId: f.storeId,
          businessDate: D1,
          totalSales: '1000.00',
          unliSales: '600.00',
          alaCarteSales: '0.00',
          cashCollected: '1000.00',
        }),
      ),
    ).rejects.toThrow(/revenue_identity/);
  });

  it('a COLLECTED-vs-EARNED mismatch blocks at verify, and the day is left untouched and re-verifiable', async () => {
    // The tender identity spans two tables, so it cannot be a CHECK — it surfaces at posting.
    const f = await setup('inv6b');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        businessDate: D1,
        totalSales: '1000.00',
        unliSales: '1000.00',
        alaCarteSales: '0.00',
        cashCollected: '900.00', // ₱100 short
      }),
    );
    await expect(
      asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId))),
    ).rejects.toThrow(/does not reconcile/);

    // ⭐ Unchanged and still fixable — a failed verify is not a state change.
    const row = await dayRow(id);
    expect(row!.status).toBe('open');
    expect(row!.journal_entry_id).toBeNull();
    expect(await ledgerLineCount(f.orgId, id)).toBe(0);
  });
});

// =========================================================================================
// Invariant 7 — every capability denies an actor lacking it
// =========================================================================================

describe('invariant 7 — the denials fire', () => {
  it('staff cannot VERIFY — the segregation the matrix requires', async () => {
    const f = await setup('inv7a');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await expect(
      asPerson(f.orgId, (tx) => verifySalesDay(tx, actor(f.orgId, f.staffId), id)),
    ).rejects.toThrow(AuthorizationError);
  });

  it('staff cannot VOID', async () => {
    const f = await setup('inv7b');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));
    await expect(
      asPerson(f.orgId, (tx) => voidSalesDay(tx, actor(f.orgId, f.staffId), id, 'nope')),
    ).rejects.toThrow(AuthorizationError);
  });

  it('a manager scoped to store 1 cannot create for store 2', async () => {
    const f = await setup('inv7c');
    await expect(
      asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.managerId), simpleDay(f.storeId2, D1))),
    ).rejects.toThrow(AuthorizationError);
  });
});

// =========================================================================================
// DEF-068 — the day says WHERE the online money landed
// =========================================================================================

describe('DEF-068 — online tender names its wallet', () => {
  async function wallets(f: Fixture) {
    const mk = async (name: string, custodian: string) => {
      const [r] = await sql<{ id: string }[]>`
        insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
        values (${f.orgId}, ${f.storeId}, ${name}, 'ewallet', '1140', ${custodian})
        returning id
      `;
      return r!.id;
    };
    return { cashier: await mk('GCash — cashier', 'cashier'), office: await mk('BDO — office', 'office') };
  }

  const dayWithOnline = (storeId: string, businessDate: string) => ({
    storeId,
    businessDate,
    totalSales: '5000.00',
    unliSales: '5000.00',
    alaCarteSales: '0.00',
    cashCollected: '2000.00',
    onlineCollected: '3000.00',
  });

  it('⭐ posts ONE leg per wallet, not one lump to 1140', async () => {
    const f = await setup('def068');
    const w = await wallets(f);

    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), {
        ...dayWithOnline(f.storeId, D1),
        tenders: [
          { moneyAccountId: w.cashier, amount: '1800.00' },
          { moneyAccountId: w.office, amount: '1200.00' },
        ],
      }),
    );
    const res = await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));

    const lines = await linesFor(res.journalEntryId);
    const online = lines.filter((l) => l.code === '1140');
    expect(online).toHaveLength(2);
    expect(online.map((l) => l.debit).sort()).toEqual(['1200.00', '1800.00']);
    // ⭐ And each says WHOSE wallet it is — the question v2 could not answer before ADR-010.
    expect(online.every((l) => l.party_type === 'money_account')).toBe(true);
    expect(online.map((l) => l.party_id).sort()).toEqual([w.cashier, w.office].sort());
  });

  it('⛔ refuses a day whose wallets do not sum to its online total', async () => {
    const f = await setup('def068sum');
    const w = await wallets(f);
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), {
        ...dayWithOnline(f.storeId, D1),
        tenders: [{ moneyAccountId: w.cashier, amount: '1800.00' }],
      }),
    );
    await expect(
      asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId))),
    ).rejects.toThrow(/tender breakdown does not equal online collected/);
  });

  it('⛔ refuses online money with no wallet at all', async () => {
    const f = await setup('def068none');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), dayWithOnline(f.storeId, D1)),
    );
    await expect(
      asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId))),
    ).rejects.toThrow(/tender breakdown does not equal online collected/);
  });

  it("⛔ refuses another store's wallet", async () => {
    const f = await setup('def068store');
    const [other] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${f.orgId}, ${f.storeId2}, 'GCash — other branch', 'ewallet', '1140', 'cashier')
      returning id
    `;
    await expect(
      asPerson(f.orgId, (tx) =>
        createSalesDay(tx, actor(f.orgId, f.staffId), {
          ...dayWithOnline(f.storeId, D1),
          tenders: [{ moneyAccountId: other!.id, amount: '3000.00' }],
        }),
      ),
    ).rejects.toThrow(/is not an active account for store/);
  });
});

// =========================================================================================
// Invariant 8 — Wave 0 guards, and org isolation
// =========================================================================================

describe('invariant 8 — all three tables classified and RLS-registered', () => {
  it('every new table declares a cutover class and an RLS scope', () => {
    for (const t of ['sales_channels', 'sales_days', 'sales_day_channels']) {
      expect(CUTOVER_CLASSIFICATION[t], `${t} has no cutover classification`).toBeDefined();
      expect(RLS_REGISTRY[t], `${t} is not in the RLS registry`).toBeDefined();
    }
    // Configuration survives the cutover; the operational documents do not.
    expect(CUTOVER_CLASSIFICATION['sales_channels']!.class).toBe('keep');
    expect(CUTOVER_CLASSIFICATION['sales_days']!.class).toBe('purge');
    expect(CUTOVER_CLASSIFICATION['sales_day_channels']!.class).toBe('purge');
  });
});

describe('invariant 9 — a sales day in org A is invisible to org B, with no WHERE org_id anywhere', () => {
  it('a bare count sees only its own org', async () => {
    const fA = await setup('inv9a');
    const [orgB] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values ('Org B', ${uid('sd-inv9b')}) returning id
    `;
    await asPerson(fA.orgId, (tx) =>
      createSalesDay(tx, actor(fA.orgId, fA.staffId), simpleDay(fA.storeId, D3)),
    );

    const seenByA = await asOrgRaw(fA.orgId, (tx) => tx<{ c: number }[]>`select count(*)::int c from sales_days`);
    expect(seenByA[0]!.c).toBeGreaterThan(0);

    const seenByB = await asOrgRaw(orgB!.id, (tx) => tx<{ c: number }[]>`select count(*)::int c from sales_days`);
    expect(seenByB[0]!.c).toBe(0);

    const channelsSeenByB = await asOrgRaw(orgB!.id, (tx) => tx<{ c: number }[]>`select count(*)::int c from sales_channels`);
    expect(channelsSeenByB[0]!.c).toBe(0);
  });
});

// =========================================================================================
// T-174 — ⭐ the transit-shortfall block
// =========================================================================================

/**
 * ⚠️ v1's reason, kept because it is exactly right: *forces resolution before revenue can be
 * understated further.* A commissary whose dispatched goods are unaccounted for is a commissary
 * whose cost of sales is wrong, and every day opened on top of that makes the figure worse and
 * harder to unpick later.
 */
describe('T-174 — an unresolved transit shortfall blocks a new day', () => {
  /** The minimum that can carry a discrepancy: a counterparty, an order, and one line. */
  async function shortfall(
    f: { orgId: string; storeId: string; staffId: string },
    over: { status?: string; deferredTo?: string | null } = {},
  ): Promise<string> {
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, 'Pork', 'raw_material', 'kg', ${f.staffId}) returning id`;
    const [cst] = await sql<{ id: string }[]>`
      insert into customers (org_id, name, customer_group, created_by)
      values (${f.orgId}, ${uid('Branch')}, 'internal', ${f.staffId}) returning id`;
    const [ord] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${f.orgId}, ${f.storeId}, ${cst!.id}, '2026-01-10', 'draft', 31000, ${f.staffId}) returning id`;
    const [line] = await sql<{ id: string }[]>`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
      values (${f.orgId}, ${ord!.id}, ${item!.id}, 100, 'kg', 310, 31000) returning id`;
    const [d] = await sql<{ id: string }[]>`
      insert into trade_discrepancies (org_id, store_id, order_id, order_line_id, quantity, value, status, deferred_to)
      values (${f.orgId}, ${f.storeId}, ${ord!.id}, ${line!.id}, 10, 3000,
              ${over.status ?? 'open'}, ${over.deferredTo ?? null}) returning id`;
    return d!.id;
  }

  it('⛔ refuses the day, and names what is unaccounted for', async () => {
    const f = await setup('t174a');
    await shortfall(f);
    await expect(
      asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1))),
    ).rejects.toThrow(TransitShortfallBlockedError);
  });

  it('opens once the shortfall is resolved', async () => {
    const f = await setup('t174b');
    const id = await shortfall(f);
    await sql`
      update trade_discrepancies
      set status = 'resolved', disposition = 'loss', resolved_at = now(), resolved_by = ${f.staffId}
      where id = ${id}`;
    const day = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    expect(day.id).toBeTruthy();
  });

  it('⭐ a deferral buys time and no more — clear before the date, blocking ON it', async () => {
    const f = await setup('t174c');
    await shortfall(f, { status: 'deferred', deferredTo: '2026-01-20' });
    // D1 is before the promised date, so the day opens.
    const day = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    expect(day.id).toBeTruthy();
  });

  it('⭐ …and blocks ON the promised date — the promise expires by itself', async () => {
    // ⚠️ A FRESH fixture with no earlier day: otherwise the older-unverified-day block fires
    // first and the test would pass on the wrong refusal.
    const f = await setup('t174c2');
    await shortfall(f, { status: 'deferred', deferredTo: '2026-01-20' });
    await expect(
      asPerson(f.orgId, (tx) =>
        createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, '2026-01-20')),
      ),
    ).rejects.toThrow(TransitShortfallBlockedError);
  });

  it('⚠️ another store is not blocked by this one’s dispute', async () => {
    const f = await setup('t174d');
    await shortfall(f);
    const day = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.adminId), simpleDay(f.storeId2, D1)),
    );
    expect(day.id).toBeTruthy();
  });

  it('⭐ an admin bypasses it, like the older-unverified-day block', async () => {
    const f = await setup('t174e');
    await shortfall(f);
    // The bypass is the SAME `canBypassBlock` the create-block already uses — one definition of
    // who may override, so the two blocks cannot drift apart on who is exempt.
    const day = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.adminId), simpleDay(f.storeId, D1)),
    );
    expect(day.id).toBeTruthy();
  });
});

describe('DEF-272 — a sub-centavo tender amount gets a written sentence, not money()\'s raw TypeError', () => {
  // ⭐ Not a guard-bypass site: `writeTenders` already called `money(t.amount)` before this fix, so
  // a sub-centavo tender was already refused — just with a developer-facing `TypeError`, not a
  // sentence someone entering the day's cash breakdown can act on.
  it('refuses "0.004" for a tender amount with a written sentence', async () => {
    const f = await setup('def272-tender');
    const [wallet] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${f.orgId}, ${f.storeId}, 'GCash — cashier', 'ewallet', '1140', 'cashier') returning id
    `;
    await expect(
      asPerson(f.orgId, (tx) =>
        createSalesDay(tx, actor(f.orgId, f.staffId), {
          ...simpleDay(f.storeId, D1),
          tenders: [{ moneyAccountId: wallet!.id, amount: '0.004' }],
        }),
      ),
    ).rejects.toThrow(/tenders:.*amount.*"0\.004"/);
  });
});

// =========================================================================================
// T-343 S5.1 — sales-days refusals name things in human terms, never a raw id (rows 7, 8, 12)
// docs/tasks/343-def-417-human-readable-refusals.md §S5.1.
// =========================================================================================

describe('T-343 S5.1 — sales-days refusals carry a human sentence', () => {
  // T-369 S3 R3: E1 used to pin the refusal of voiding an OPEN day. An open day is now withdrawn; the
  // sentence that carries over is the one for a day that is ALREADY voided.
  it('E1: voidSalesDay on an already-voided day — userMessage is exactly "This sales day is already voided."; no UUID; the raw diagnostic still names it', async () => {
    const f = await setup('t343-s51-e1');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await asPerson(f.orgId, (tx) => voidSalesDay(tx, actor(f.orgId, f.managerId), id, 'wrong day'));

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) => voidSalesDay(tx, actor(f.orgId, f.managerId), id, 'wrong day again'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('This sales day is already voided.');
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    // E5 (⛔ negative): the raw diagnostic carries the id for the log, and is not the user's sentence (Invariant 1).
    expect(err.message).toMatch(/is already voided/);
    expect(err.message).not.toBe(err.userMessage);
  });

  it('E2: a duplicate createSalesDay names the date and status; no UUID', async () => {
    const f = await setup('t343-s51-e2');
    await asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)));

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage, 'a duplicate day must carry a presentable userMessage').toBeDefined();
    // `humanDate('2026-01-10')` — no second date formatter (Design). D1 is defined above as
    // '2026-01-10'; independently formatted here to avoid the self-referential-control trap
    // (a-control-must-not-compute-its-own-expectation) — the literal is hand-verified, not called.
    expect(err.userMessage).toContain('Jan 10, 2026');
    expect(err.userMessage).toContain('open');
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    // E5 (⛔ negative): the raw diagnostic still matches today's regex, unedited (Invariant 1).
    expect(err.message).toMatch(/already exists for store/);
  });

  it('/code-review: a duplicate with an UNPADDED businessDate ("2026-1-10") still gets the refusal sentence, never "Invalid business date"', async () => {
    // Postgres's own `date` column parses "2026-1-10" and "2026-01-10" identically, so the
    // duplicate check finds the existing row either way — but `humanDate()` takes a `BusinessDate`
    // (`parseBusinessDate`'s strict `/^\d{4}-\d{2}-\d{2}$/`), which "2026-1-10" fails.
    // `create.ts`'s `safeHumanDate` (code-review item 7) catches that and falls back to the RAW
    // string rather than crashing the refusal it is naming — so the assertion here is the fallback
    // actually firing (the raw date shown verbatim, no crash), not that malformed input somehow
    // still gets the nicely-formatted date (a nicer message for genuinely malformed input is not
    // the safety property this guards; never crashing, and never leaking, is).
    const f = await setup('t343-s51-e2b');
    await asPerson(f.orgId, (tx) => createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, '2026-01-10')));

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) =>
        createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, '2026-1-10')),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage, 'must be the duplicate-day refusal, never a raw "Invalid business date" crash').not.toMatch(
      /Invalid business date/,
    );
    expect(err.userMessage).toContain('2026-1-10'); // safeHumanDate's fallback: raw string, verbatim
    expect(err.userMessage).toContain('open');
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('E6: a verified day planted with no journal entry throws InternalFaultError, never a userMessage', async () => {
    const f = await setup('t343-s51-e6');
    const { id } = await asPerson(f.orgId, (tx) =>
      createSalesDay(tx, actor(f.orgId, f.staffId), simpleDay(f.storeId, D1)),
    );
    await asPerson(f.orgId, (tx) => submitThenVerify(tx, actor(f.orgId, f.managerId), id, actor(f.orgId, f.staffId)));

    // Test-only corruption, planted directly against the real row (cheaper and more convincing
    // than a synthetic fixture — shareat-system-real-source-plant-when-cheap): the public API
    // never leaves a verified day with no journal_entry_id, so this state can only be reached by
    // writing around it, exactly as an actual data-inconsistency would be found.
    await sql`update sales_days set journal_entry_id = null where id = ${id}`;

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) => verifySalesDay(tx, actor(f.orgId, f.managerId), id));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalFaultError);
    const err = caught as InternalFaultError & { userMessage?: string };
    expect(Object.prototype.hasOwnProperty.call(err, 'userMessage')).toBe(false);
    expect(err.message).toMatch(/is verified but carries no journalEntryId/);
  });
});

