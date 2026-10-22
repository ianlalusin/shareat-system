import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * Proves the 16 invariants of docs/tasks/122-expenses.md against a real PostgreSQL
 * (PROJECT_BIBLE.md §9 rule 3) — never a mock. `packages/domain/src/expenses/*.ts`
 * (create · approve · edit · void) and `packages/db/src/repo/expenses.ts` already exist
 * and are exercised here for the first time at the integration level; `routing.ts`'s own
 * pure-function invariants 6-10 are re-proven THROUGH `approveExpense`, not just at the
 * routing layer, because the point of this file is the WIRING (does the service actually
 * call `postEntry`/`authorize` correctly), not the pure logic in isolation.
 *
 * Two test-execution patterns are borrowed, one for each half of what this file proves:
 *
 *  - `asPerson` (packages/auth/tests/integration/authorize.test.ts) — opens a Drizzle
 *    transaction, applies the RLS principal via `set local role` + `set_config`, and
 *    hands that SAME `tx` into the domain function under test (every one of
 *    create/approve/edit/voidExpense accepts `tx: Tx | null` for exactly this reason).
 *    Used for every test that calls a service function, so every posting and every
 *    authorize() check in this file runs under real RLS, not the owner connection.
 *
 *  - `asOrgRaw` (packages/db/tests/integration/rls.test.ts) — a raw postgres.js
 *    transaction with the same principal applied, used ONLY for invariant 16's bare,
 *    unfiltered `select count(*)` — the literal proof that org isolation holds with "no
 *    WHERE org_id written anywhere", which a Drizzle query builder could not demonstrate
 *    (it always writes SOME where clause).
 *
 * Fixtures are built once per test via `setup(hint)` (mirrors post-entry-party.test.ts's
 * `baseFixture`) rather than shared across a describe block — this file mutates expense
 * and journal-entry status heavily (approve, void, edit), and a fresh org per test is
 * cheaper to reason about than tracking which prior test already posted or voided a given
 * row. Org codes are uid()-unique, so no truncation is needed between tests, only once at
 * the start (bible §3.4 row 94 — no two tests may share mutable state).
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
import { closeDb, findingsRepo, moneyAccountsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { approveExpense, createExpense, deleteExpenseDraft, editExpense, voidExpense, routeExpense, recordInvoice, verifyInvoice, setTillFloat, payReimbursement } from '@shareat/domain';
import { reimbursablePayableOf, markExpenseVoided } from '../../../db/src/repo/expenses';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

// ---------------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------------

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`exp-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  return row!.id;
}

async function insertStore(orgId: string, hint: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  return row!.id;
}

async function insertPerson(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  return row!.id;
}

async function insertRoleRaw(personId: string, orgId: string, role: 'super_admin' | 'admin' | 'manager' | 'staff'): Promise<void> {
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
}

async function insertStoreScopeRaw(personId: string, storeId: string): Promise<void> {
  await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
}

async function revokeStoreScopeRaw(personId: string, storeId: string): Promise<void> {
  await sql`delete from person_store_scope where person_id = ${personId} and store_id = ${storeId}`;
}

async function insertPeriod(orgId: string, startsOn: string, endsOn: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, 'open')
    returning id
  `;
  return row!.id;
}

interface Fixture {
  orgId: string;
  storeId: string;
  storeId2: string;
  staffId: string;
  managerId: string;
  adminId: string;
  /** ⭐ The wallet an online payment leaves. Since ADR-010, `1140` is a control account keyed by
   *  the money account, so an online payment with no wallet is refused — by `routeExpense` with a
   *  reason, and by the database underneath it. */
  walletId: string;
  /** ⭐ And since DEF-058, CASH names its place too: the account decides both the GL code and who
   *  owned the money, replacing the "office drawer" tickbox that let a cashier route cash away
   *  from their own till. */
  cashDrawerId: string;
  officeSafeId: string;
  /** ⭐ T-130: every expense now names a real, verified supplier invoice. A single
   *  fixture-wide invoice with a huge ceiling (₱99,999,999) so no individual test has to
   *  think about capacity — this file's own invariants are about expenses, not AP. */
  supplierId: string;
  supplierInvoiceId: string;
  fixtureFileId: string;
}

/** One org, one open 2026-01 period, a full chart of accounts, the seeded expense
 *  category crosswalk, and a store + one persona per role — everyone scoped to `storeId`
 *  only (never `storeId2`), so a test can prove a store-scope denial without any extra
 *  setup. */
async function setup(hint: string): Promise<Fixture> {
  const orgId = await insertOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await insertPeriod(orgId, '2026-01-01', '2026-01-31');
  const storeId = await insertStore(orgId, `${hint}-s1`);
  const storeId2 = await insertStore(orgId, `${hint}-s2`);
  const staffId = await insertPerson(orgId, `${hint} Staff`);
  const managerId = await insertPerson(orgId, `${hint} Manager`);
  const adminId = await insertPerson(orgId, `${hint} Admin`);
  await insertRoleRaw(staffId, orgId, 'staff');
  await insertRoleRaw(managerId, orgId, 'manager');
  await insertRoleRaw(adminId, orgId, 'admin');
  await insertStoreScopeRaw(staffId, storeId);
  await insertStoreScopeRaw(managerId, storeId);
  await insertStoreScopeRaw(adminId, storeId);
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: adminId,
  });
  const [wallet] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash — cashier', 'ewallet', '1140', 'cashier')
    returning id
  `;
  // T-316 S1: reuse the store's foundation Cashier cash (0029 trigger) — a second cashier cash row
  // would make setTillFloat refuse ("more than one cashier cash account").
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts
    where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier'
      and gl_account_code = '1110' and is_foundation
  `;
  // ⭐ An OFFICE safe too. Since bible row 154 the overdraft rule turns on the CUSTODIAN — a
  // cashier account only ever warns — so proving the blocking half needs an account whose
  // balance is complete.
  const [safe] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Office safe', 'cash', '1130', 'office')
    returning id
  `;

  // ⭐ FUND BOTH ACCOUNTS. Since T-139's overdraw block, approving an expense requires the
  // account it draws on to actually hold the money — so a fixture that spends must first have
  // something to spend, exactly as a real store has a float in the drawer and collections in the
  // wallet before anyone buys anything.
  //
  // ⚠️ Every test in this file previously posted expenses out of accounts holding ₱0. That was
  // never realistic; it was simply unchecked.
  await fundAccount(orgId, storeId, '1110', '500000.00', null);
  await fundAccount(orgId, storeId, '1140', '500000.00', wallet!.id);
  await fundAccount(orgId, storeId, '1130', '500000.00', null);

  // ⭐ T-130 — the gate. One supplier, one already-verified invoice with a huge ceiling, so
  // every createExpense() call in this file (which tests EXPENSE invariants, not AP ones) has
  // somewhere valid to point.
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${orgId}, ${`${hint} Supplier`}, ${staffId})
    returning id
  `;
  // Evidence is a real stored_files row now (migration 0046) — a typed string is not evidence.
  const [fixtureFile] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${hint}.jpg`},
            'image/jpeg', 1024, ${`sum-${hint}`}, ${staffId})
    returning id
  `;
  const fixtureFileId = fixtureFile!.id;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (
      org_id, store_id, supplier_id, invoice_date, total_amount, status,
      receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price
    ) values (
      ${orgId}, ${storeId}, ${supplier!.id}, '2026-01-01', '99999999.00', 'verified',
      ${fixtureFileId}, ${managerId}, now(), ${staffId}, true, true, true, true
    )
    returning id
  `;

  return {
    orgId, storeId, storeId2, staffId, managerId, adminId, walletId: wallet!.id,
    cashDrawerId: drawer!.id, officeSafeId: safe!.id,
    supplierId: supplier!.id, supplierInvoiceId: invoice!.id, fixtureFileId,
  };
}

/**
 * Puts opening money into one account, as a plain balanced entry against equity.
 *
 * ⚠️ `moneyAccountId` is required for `1140` and must be null for cash: 1140 is ONE control
 * account for every wallet, so a line without a party belongs to no wallet in particular and
 * `balanceOf` would not see it. Cash codes name their location already.
 */
async function fundAccount(
  orgId: string,
  storeId: string,
  code: string,
  amount: string,
  moneyAccountId: string | null,
): Promise<void> {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${orgId} limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft')
      returning id
    `;
    const [target] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${orgId} and code = ${code}
    `;
    // ⚠️ 3900, not 3200. Funding an account is an OPENING BALANCE, and its counterpart is
    // "Opening balance equity" — 3200 is Owner's DRAWINGS, debit-normal contra-equity, so crediting
    // it to put cash in a till is backwards even as a fixture. T-127 made 3200 party-requiring and
    // that is what surfaced it: every one of these fixtures started failing at once.
    const [equity] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${orgId} and code = '3900'
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${target!.id}, ${storeId}, ${amount}, '0',
              ${moneyAccountId ? 'money_account' : null}, ${moneyAccountId})
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${equity!.id}, ${storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function categoryId(orgId: string, category: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = ${category}
  `;
  if (!row) throw new Error(`fixture: category "${category}" not found for org ${orgId}`);
  return row.id;
}

/** Inserts a category with a NULL account_code — the state invariant 7 exists to reject.
 *  Never produced by `seedExpenseCategories` itself (every seeded row is mapped), so this
 *  goes straight at the table. */
async function insertUnmappedCategory(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${orgId}, 'OPEX', ${name}, null)
    returning id
  `;
  return row!.id;
}

/** Runs `fn` inside one Drizzle transaction with the 'staff' RLS principal applied for
 *  `orgId` — mirrors packages/auth/tests/integration/authorize.test.ts's `asPerson`
 *  exactly, so a service function called through this runs under the same RLS every real
 *  request would. */
async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Raw postgres.js transaction with the same principal — used ONLY for invariant 16's
 *  bare, unfiltered query (packages/db/tests/integration/rls.test.ts's `asOrg`). */
async function asOrgRaw<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

interface Line {
  code: string;
  debit: string;
  credit: string;
  party_type: string | null;
  party_id: string | null;
}

async function linesFor(entryId: string): Promise<Line[]> {
  return sql<Line[]>`
    select a.code, jl.debit, jl.credit, jl.party_type, jl.party_id
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId}
    order by jl.line_no
  `;
}

async function expenseRow(orgId: string, id: string) {
  const [row] = await sql<
    { status: string; journal_entry_id: string | null; total_amount: string }[]
  >`select status, journal_entry_id, total_amount from expenses where id = ${id} and org_id = ${orgId}`;
  return row;
}

function actor(orgId: string, personId: string): Actor {
  return { personId, orgId };
}

beforeAll(async () => {
  await sql`
    truncate table
      money_accounts,
      ap_payment_allocations, ap_payments, supplier_invoices, suppliers,
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

const BUSINESS_DATE = '2026-01-15';

// =========================================================================================
// Posting — invariants 1-5
// =========================================================================================

describe('invariant 1 — a single cash expense posts exactly POSTING-PATTERNS.md\'s expense.cash.simple', () => {
  it('DR 5100 / CR 1110, no more, no less', async () => {
    const f = await setup('inv1');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Pork delivery, cash',
        payments: [{ method: 'cash', amount: '1200.00', moneyAccountId: f.cashDrawerId }],
      }),
    );

    const posted = await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    expect(posted.created).toBe(true);

    const lines = await linesFor(posted.journalEntryId);
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => l.debit !== '0.00')!;
    const credit = lines.find((l) => l.credit !== '0.00')!;
    expect(debit.code).toBe('5100');
    expect(debit.debit).toBe('1200.00');
    expect(credit.code).toBe('1110');
    expect(credit.credit).toBe('1200.00');
  });
});

describe('invariant 2 — a three-way split posts ONE entry with three credit lines', () => {
  it('cash + online + reimbursable, one journal_entries row, four lines', async () => {
    const f = await setup('inv2');
    const catId = await categoryId(f.orgId, 'Supplies and Stocks');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Supplies, three-way split',
        payments: [
          { method: 'cash', amount: '1500.00', moneyAccountId: f.cashDrawerId },
          { method: 'online', amount: '1000.00', moneyAccountId: f.walletId },
          { method: 'reimbursable', amount: '1000.00', staffId: f.staffId },
        ],
      }),
    );

    const posted = await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    expect(posted.created).toBe(true);

    // Exactly ONE journal_entries row for this source document.
    const [entryCount] = await sql<{ c: number }[]>`
      select count(*)::int c from journal_entries where source_type = 'expense_payment' and source_id = ${created.id}
    `;
    expect(entryCount!.c).toBe(1);

    const lines = await linesFor(posted.journalEntryId);
    expect(lines).toHaveLength(4);
    const debits = lines.filter((l) => l.debit !== '0.00');
    const credits = lines.filter((l) => l.credit !== '0.00');
    expect(debits).toHaveLength(1);
    expect(credits).toHaveLength(3);
    expect(debits[0]!.code).toBe('6500');
    expect(debits[0]!.debit).toBe('3500.00');
    expect(credits.map((c) => c.code).sort()).toEqual(['1110', '1140', '2130']);
    expect(credits.find((c) => c.code === '1110')!.credit).toBe('1500.00');
    expect(credits.find((c) => c.code === '1140')!.credit).toBe('1000.00');
    const reimbursableLine = credits.find((c) => c.code === '2130')!;
    expect(reimbursableLine.credit).toBe('1000.00');
    expect(reimbursableLine.party_type).toBe('employee');
    expect(reimbursableLine.party_id).toBe(f.staffId);
  });
});

describe('invariant 3 — reimbursable credits 2130 with the staff party; without it, rejected', () => {
  it('positive case already proven by invariant 2\'s reimbursable line (2130, party_type employee)', () => {
    // Kept as a named marker so the invariant list in this file matches the spec 1:1 —
    // the actual proof is invariant 2's assertion above, since a reimbursable-only
    // expense would otherwise duplicate that test almost verbatim.
    expect(true).toBe(true);
  });

  it('a reimbursable payment with no staffId is rejected at approve, never posted', async () => {
    const f = await setup('inv3');
    const catId = await categoryId(f.orgId, 'Repairs and Maintenance');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Emergency repair, no staffId supplied',
        payments: [{ method: 'reimbursable', amount: '650.00' }],
      }),
    );

    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id)),
    ).rejects.toThrow(/staffId/);

    // Nothing posted — the expense is unchanged, still a draft, no journal entry.
    const row = await expenseRow(f.orgId, created.id);
    expect(row!.status).toBe('draft');
    expect(row!.journal_entry_id).toBeNull();
  });
});

describe('invariant 4 — re-posting is idempotent: one entry, created:false the second time', () => {
  it('approving an already-posted expense returns the same journalEntryId and writes nothing new', async () => {
    const f = await setup('inv4');
    const catId = await categoryId(f.orgId, 'Utilities');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Electric bill',
        payments: [{ method: 'cash', amount: '3000.00', moneyAccountId: f.cashDrawerId }],
      }),
    );

    const first = await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    expect(first.created).toBe(true);

    const second = await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    expect(second.created).toBe(false);
    expect(second.journalEntryId).toBe(first.journalEntryId);

    const [entryCount] = await sql<{ c: number }[]>`
      select count(*)::int c from journal_entries where source_type = 'expense_payment' and source_id = ${created.id}
    `;
    expect(entryCount!.c).toBe(1);
  });
});

describe('invariant 5 — a void reverses through reverseEntry and every account nets to zero', () => {
  it('voidExpense reverses the entry, and 5100/1110 both net to 0 across the pair', async () => {
    const f = await setup('inv5');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Wrong delivery, to be voided',
        payments: [{ method: 'cash', amount: '800.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    const posted = await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));

    const voided = await asPerson(f.orgId, (tx) => voidExpense(tx, actor(f.orgId, f.managerId), created.id, 'Wrong supplier'));
    expect(voided.created).toBe(true);

    const row = await expenseRow(f.orgId, created.id);
    expect(row!.status).toBe('voided');

    for (const code of ['5100', '1110']) {
      const [net] = await sql<{ net: string }[]>`
        select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2) as net
        from journal_lines jl
        join accounts a on a.id = jl.account_id
        where a.code = ${code} and jl.entry_id in (${posted.journalEntryId}, ${voided.reversalEntryId})
      `;
      expect(Number(net!.net)).toBe(0);
    }
  });
});

// =========================================================================================
// Routing — invariants 6-10 (proven through approveExpense, not routing.ts directly)
// =========================================================================================

describe('invariant 6 — a mapped category routes to its declared account', () => {
  it('an OPEX category (Rent -> 6200) debits exactly 6200', async () => {
    const f = await setup('inv6');
    const catId = await categoryId(f.orgId, 'Rent');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Monthly rent',
        payments: [{ method: 'cash', amount: '25000.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    const posted = await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    const lines = await linesFor(posted.journalEntryId);
    const debit = lines.find((l) => l.debit !== '0.00')!;
    expect(debit.code).toBe('6200');
  });
});

describe('invariant 7 — an unmapped category BLOCKS, naming the category, never falls back to 6900', () => {
  it('a category seeded with account_code NULL cannot post', async () => {
    const f = await setup('inv7');
    const catId = await insertUnmappedCategory(f.orgId, 'Mystery Spend');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Nobody knows what this was for',
        payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.cashDrawerId }],
      }),
    );

    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id)),
    ).rejects.toThrow(/Mystery Spend/);

    // And specifically NEVER 6900 — the forbidden fallback (spec §4).
    const row = await expenseRow(f.orgId, created.id);
    expect(row!.status).toBe('draft');
    expect(row!.journal_entry_id).toBeNull();
  });

  it('routeExpense names the category, and does not route to 6900 as a fallback account', () => {
    const result = routeExpense({
      totalAmount: '500.00' as never,
      supplierId: null,
      categoryName: 'Mystery Spend',
      categoryAccountCode: null,
      // A pure-routing check: the account only has to be NAMED for the category failure to
      // be the one that surfaces. `routeExpense` never looks an id up — it is given the code.
      payments: [{ method: 'cash', amount: '500.00' as never, moneyAccountId: 'drawer', moneyAccountGlCode: '1110' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Mystery Spend');
      // The rejection message legitimately MENTIONS 6900 to explain what it refused to do
      // (see routing.ts) — the actual proof of "never falls back" is that no line was
      // produced at all: `result.ok === false` above, and invariant 7's other test
      // confirms nothing posted (status stays 'draft', journal_entry_id stays null).
      expect(result.ok).toBe(false);
    }
  });
});

/**
 * ⭐ T-127 CHANGED WHAT THIS INVARIANT MEANS. A personal expense has no single account: it is a
 * DRAWING only when the business does not expect the money back, and a RECEIVABLE when it does —
 * the line the tax treatment turns on, since a payment made with no expectation of repayment is a
 * distribution however it is labelled. Both routes are proven here, and so is the refusal.
 */
async function ownerFor(f: Fixture, treatment: 'repayable' | 'drawing'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into owners (org_id, store_id, person_id, personal_expense_treatment, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.staffId}, ${treatment}, ${f.managerId})
    returning id
  `;
  return row!.id;
}

async function postPersonal(
  f: Fixture,
  ownerId: string | null,
): Promise<{ ok: boolean; code?: string; partyType?: string | null }> {
  const catId = await categoryId(f.orgId, "Owner's Personal Expense");
  const created = await asPerson(f.orgId, (tx) =>
    createExpense(tx, actor(f.orgId, f.staffId), {
      storeId: f.storeId,
      supplierId: f.supplierId,
      supplierInvoiceId: f.supplierInvoiceId,
      businessDate: BUSINESS_DATE,
      categoryId: catId,
      particulars: "Owner's personal expense",
      ...(ownerId ? { ownerId } : {}),
      payments: [{ method: 'cash', amount: '2000.00', moneyAccountId: f.cashDrawerId }],
    }),
  );
  const posted = await asPerson(f.orgId, (tx) =>
    approveExpense(tx, actor(f.orgId, f.managerId), created.id),
  );
  if (!posted.journalEntryId) return { ok: false };
  const lines = await linesFor(posted.journalEntryId);
  const debit = lines.find((l) => l.debit !== '0.00')!;
  return { ok: true, code: debit.code, partyType: debit.party_type ?? null };
}

describe('invariant 8 — a personal expense routes by whether it is expected back, never to a P&L line', () => {
  it('⭐ NOT repayable → debits 3200, which is typed equity, not expense', async () => {
    const f = await setup('inv8');
    const result = await postPersonal(f, await ownerFor(f, 'drawing'));
    expect(result.code).toBe('3200');
    // The party is what lets a drawing limit see it at all.
    expect(result.partyType).toBe('owner');

    const [account] = await sql<{ type: string }[]>`select type from accounts where org_id = ${f.orgId} and code = '3200'`;
    expect(account!.type).toBe('equity');
  });

  it('⭐ repayable → debits 1260, an ASSET — equity does not move for money coming back', async () => {
    const f = await setup('inv8b');
    const result = await postPersonal(f, await ownerFor(f, 'repayable'));
    expect(result.code).toBe('1260');
    expect(result.partyType).toBe('owner');

    const [account] = await sql<{ type: string }[]>`select type from accounts where org_id = ${f.orgId} and code = '1260'`;
    expect(account!.type).toBe('asset');
  });

  it('⛔ with NO owner it BLOCKS, naming the reason — an unattributed personal expense escapes the limit', async () => {
    const f = await setup('inv8c');
    // Invariant 7's rule unchanged: unresolvable BLOCKS at approve and never defaults to "some
    // owner". ⚠️ It THROWS rather than returning `{ ok: false }` — approveExpense turns a routing
    // refusal into an error, so the caller cannot ignore it by not reading a field.
    await expect(postPersonal(f, null)).rejects.toThrow(/belongs to a specific owner/);
  });
});


describe('invariant 9 — CAPEX routes to a 15xx asset, never a P&L line', () => {
  it('debits 1510, and 1510 is typed asset, not expense', async () => {
    const f = await setup('inv9');
    const catId = await categoryId(f.orgId, 'Capital Expenditure');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'New grill purchase',
        payments: [{ method: 'cash', amount: '45000.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    const posted = await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    const lines = await linesFor(posted.journalEntryId);
    const debit = lines.find((l) => l.debit !== '0.00')!;
    expect(debit.code).toBe('1510');

    const [account] = await sql<{ type: string }[]>`select type from accounts where org_id = ${f.orgId} and code = '1510'`;
    expect(account!.type).toBe('asset');
  });
});

// invariant 10 (DEF-054) retired by T-367 S5: 'other' / 'ar_collection' can no longer be CREATED; the refusal and
// the approve-time backstop are proven in t367-s5-methods-retired.test.ts (F3a, F3d) and t367-s5-routing-retired.test.ts (F3c).

// =========================================================================================
// Controls — invariants 11-14
// =========================================================================================

describe('invariant 11 — no VERIFIED invoice, no POSTING (T-196 retimed the gate from EXISTENCE to POSTING)', () => {
  /**
   * ⭐ T-196 (docs/tasks/196-draft-expense-on-a-pending-invoice.md) rewrites what this invariant
   * means. Before T-196, `createExpense` itself refused a pending invoice — DEF-055's photo gate,
   * relocated here by T-130. After T-196, a DRAFT may sit against a pending invoice; only
   * POSTING (`approveExpense`) still requires `verified`, and `verifyInvoice` posts the SAME
   * draft the moment it verifies — no second `createExpense` call, no second document.
   */
  it('createExpense succeeds against a PENDING invoice (draft, zero journal rows); approveExpense on it is refused; verifying it posts the same draft', async () => {
    const f = await setup('inv11');
    const catId = await categoryId(f.orgId, 'Marketing and Advertising');

    const pending = await asPerson(f.orgId, (tx) =>
      recordInvoice(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        invoiceDate: BUSINESS_DATE,
        totalAmount: '300.00',
        receiptFileId: f.fixtureFileId,
      }),
    );

    // Test 1 — a cashier holding only create_expense drafts against a pending invoice.
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: pending.id,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Drafted before verification',
        payments: [{ method: 'cash', amount: '300.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    const draftRow = await expenseRow(f.orgId, created.id);
    expect(draftRow!.status).toBe('draft');
    expect(draftRow!.journal_entry_id).toBeNull();

    // Test 2 — the same actor (now a manager, so authorization is not what refuses this)
    // calls approveExpense directly: still refused, by name, because the invoice is pending.
    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id)),
    ).rejects.toThrow(/is pending/);
    const stillDraft = await expenseRow(f.orgId, created.id);
    expect(stillDraft!.status).toBe('draft');
    expect(stillDraft!.journal_entry_id).toBeNull();

    // Verifying it posts the SAME draft, in the same transaction as the status flip.
    await asPerson(f.orgId, (tx) =>
      verifyInvoice(tx, actor(f.orgId, f.managerId), pending.id, { supplier: true, invoice: true, items: true, price: true }),
    );
    const posted = await expenseRow(f.orgId, created.id);
    expect(posted!.status).toBe('posted');
    expect(posted!.journal_entry_id).not.toBeNull();
  });

  // Test 3 — "the service check is a convenience; this is the control." The trigger
  // (expenses_check_invoice_open_for_recording, migration 0113) is what actually holds when the
  // service is bypassed entirely, e.g. a hand-written UPDATE.
  it('⛔ a raw UPDATE that flips a draft to posted on a PENDING invoice is refused by the TRIGGER, not the service', async () => {
    const f = await setup('inv11-trigger');
    const catId = await categoryId(f.orgId, 'Marketing and Advertising');

    const pending = await asPerson(f.orgId, (tx) =>
      recordInvoice(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        invoiceDate: BUSINESS_DATE,
        totalAmount: '300.00',
        receiptFileId: f.fixtureFileId,
      }),
    );
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: pending.id,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Bypassing the service entirely',
        payments: [{ method: 'cash', amount: '300.00', moneyAccountId: f.cashDrawerId }],
      }),
    );

    await expect(
      sql`update expenses set status = 'posted' where id = ${created.id}`,
    ).rejects.toThrow(/cannot post until it is verified/);
  });
});

describe('invariant 12 — the creator edits their own draft inside 48h; outside it, they cannot', () => {
  it('within the window, the creator (staff) edits successfully', async () => {
    const f = await setup('inv12a');
    const catId = await categoryId(f.orgId, 'Smallwares');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Original particulars',
        payments: [{ method: 'cash', amount: '150.00', moneyAccountId: f.cashDrawerId }],
      }),
    );

    await asPerson(f.orgId, (tx) =>
      editExpense(tx, actor(f.orgId, f.staffId), created.id, { particulars: 'Corrected particulars' }),
    );
    const [row] = await sql<{ particulars: string }[]>`select particulars from expenses where id = ${created.id}`;
    expect(row!.particulars).toBe('Corrected particulars');
  });

  it('outside the window, the same creator (staff) is denied — they lack edit_any_expense', async () => {
    const f = await setup('inv12b');
    const catId = await categoryId(f.orgId, 'Smallwares');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Aging draft',
        payments: [{ method: 'cash', amount: '150.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    // Backdate created_at past the 48h window — the ONLY way to reach this state without
    // waiting two real days; every other field is untouched.
    await sql`update expenses set created_at = now() - interval '49 hours' where id = ${created.id}`;

    await expect(
      asPerson(f.orgId, (tx) =>
        editExpense(tx, actor(f.orgId, f.staffId), created.id, { particulars: 'Too late' }),
      ),
    ).rejects.toThrow(AuthorizationError);

    // A manager (who DOES hold edit_any_expense) can still fix it — the window is about
    // WHO may act unsupervised, not a permanent freeze.
    await asPerson(f.orgId, (tx) =>
      editExpense(tx, actor(f.orgId, f.managerId), created.id, { particulars: 'Fixed by a manager' }),
    );
    const [row] = await sql<{ particulars: string }[]>`select particulars from expenses where id = ${created.id}`;
    expect(row!.particulars).toBe('Fixed by a manager');
  });
});

describe('invariant 13 — a posted expense cannot be edited by anyone, including an admin', () => {
  it('editExpense rejects a posted expense before authorize() is even reached', async () => {
    const f = await setup('inv13');
    const catId = await categoryId(f.orgId, 'Insurance');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Annual premium',
        payments: [{ method: 'cash', amount: '5000.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));

    await expect(
      asPerson(f.orgId, (tx) =>
        editExpense(tx, actor(f.orgId, f.adminId), created.id, { particulars: 'Admin tries to sneak a change in' }),
      ),
    ).rejects.toThrow(/only a draft may be edited/);
  });
});

describe('invariant 14 — each of the five capabilities denies an actor lacking it', () => {
  // create_expense and edit_own_expense are ✅ for ALL FOUR roles in CAPABILITY-MATRIX.md
  // — there is no ROLE that lacks them (packages/auth's own authorize.test.ts calls this
  // set UNIVERSALLY_GRANTED and exempts it from role-based denial for the same reason).
  // Denial is still proven for both, on the only axis that remains: no role at all for
  // create_expense, and a store-scope gap for edit_own_expense — reported in the task
  // report as a spec-defect finding, since T-122 §6 implies all five have a denying role.

  it('create_expense denies a person with NO role at all in the org', async () => {
    const f = await setup('inv14-create');
    const nobody = await insertPerson(f.orgId, 'Unconfigured');
    const catId = await categoryId(f.orgId, 'Bank Fees');

    await expect(
      asPerson(f.orgId, (tx) =>
        createExpense(tx, actor(f.orgId, nobody), {
          storeId: f.storeId,
          supplierId: f.supplierId,
          supplierInvoiceId: f.supplierInvoiceId,
          businessDate: BUSINESS_DATE,
          categoryId: catId,
          particulars: 'Should never be created',
          payments: [{ method: 'cash', amount: '10.00', moneyAccountId: f.cashDrawerId }],
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('edit_own_expense denies the creator once their store scope is revoked', async () => {
    const f = await setup('inv14-edit-own');
    const catId = await categoryId(f.orgId, 'Bank Fees');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Creator about to lose store scope',
        payments: [{ method: 'cash', amount: '10.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await revokeStoreScopeRaw(f.staffId, f.storeId);

    await expect(
      asPerson(f.orgId, (tx) =>
        editExpense(tx, actor(f.orgId, f.staffId), created.id, { particulars: 'Should be denied' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('edit_any_expense denies staff (matrix-false for staff)', async () => {
    const f = await setup('inv14-edit-any');
    const catId = await categoryId(f.orgId, 'Bank Fees');
    // Created by the MANAGER, so staff is never the creator and always routes to
    // edit_any_expense regardless of timing.
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.managerId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Created by manager',
        payments: [{ method: 'cash', amount: '10.00', moneyAccountId: f.cashDrawerId }],
      }),
    );

    await expect(
      asPerson(f.orgId, (tx) =>
        editExpense(tx, actor(f.orgId, f.staffId), created.id, { particulars: 'Staff should not be able to' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('void_expense denies staff (matrix-false for staff)', async () => {
    const f = await setup('inv14-void');
    const catId = await categoryId(f.orgId, 'Bank Fees');
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Posted then staff tries to void',
        payments: [{ method: 'cash', amount: '10.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));

    await expect(
      asPerson(f.orgId, (tx) => voidExpense(tx, actor(f.orgId, f.staffId), created.id, 'staff attempt')),
    ).rejects.toThrow(AuthorizationError);
  });

  it('approve_expense denies staff (matrix-false for staff)', async () => {
    const f = await setup('inv14-approve');
    const catId = await categoryId(f.orgId, 'Bank Fees');
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Staff tries to self-approve',
        payments: [{ method: 'cash', amount: '10.00', moneyAccountId: f.cashDrawerId }],
      }),
    );

    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.staffId), created.id)),
    ).rejects.toThrow(AuthorizationError);
  });
});

// =========================================================================================
// Wave 0 holds — invariants 15-16
// =========================================================================================

describe('invariant 15 — all three tables classified for cutover and declared in the RLS registry', () => {
  it('expenses, expense_payments and expense_categories all carry a cutover classification', () => {
    expect(CUTOVER_CLASSIFICATION.expenses?.class).toBe('purge');
    expect(CUTOVER_CLASSIFICATION.expense_payments?.class).toBe('purge');
    expect(CUTOVER_CLASSIFICATION.expense_categories?.class).toBe('keep');
  });

  it('all three carry an RLS registry entry', () => {
    expect(RLS_REGISTRY.expenses?.scope).toBe('org_column');
    expect(RLS_REGISTRY.expense_categories?.scope).toBe('org_column');
    expect(RLS_REGISTRY.expense_payments?.scope).toBe('derived');
    expect(RLS_REGISTRY.expense_payments?.via).toContain('app_current_org()');
  });

  it('RLS is actually ENABLED and FORCED for all three, in real Postgres — a registry entry is a promise, this is the control', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in ('expenses', 'expense_payments', 'expense_categories')
    `;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname}: RLS not enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname}: RLS enabled but not FORCED — the owner still bypasses`).toBe(true);
    }
  });
});

describe('invariant 16 — an expense in org A is invisible to org B, with no WHERE org_id written anywhere', () => {
  it('a bare, unfiltered select from org B sees zero of org A\'s expenses and payments', async () => {
    const fA = await setup('inv16-a');
    const orgB = await insertOrg('inv16-b');

    const catId = await categoryId(fA.orgId, 'Bank Fees');
    await asPerson(fA.orgId, (tx) =>
      createExpense(tx, actor(fA.orgId, fA.staffId), {
        storeId: fA.storeId,
        supplierId: fA.supplierId,
        supplierInvoiceId: fA.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: "Org A's own expense",
        payments: [{ method: 'cash', amount: '10.00', moneyAccountId: fA.cashDrawerId }],
      }),
    );

    const seenByA = await asOrgRaw(fA.orgId, (tx) => tx<{ c: number }[]>`select count(*)::int c from expenses`);
    expect(seenByA[0]!.c).toBeGreaterThan(0);

    const seenByB = await asOrgRaw(orgB, (tx) => tx<{ c: number }[]>`select count(*)::int c from expenses`);
    expect(seenByB[0]!.c).toBe(0);

    const paymentsSeenByB = await asOrgRaw(orgB, (tx) => tx<{ c: number }[]>`select count(*)::int c from expense_payments`);
    expect(paymentsSeenByB[0]!.c).toBe(0);

    const categoriesSeenByB = await asOrgRaw(orgB, (tx) => tx<{ c: number }[]>`select count(*)::int c from expense_categories`);
    expect(categoriesSeenByB[0]!.c).toBe(0);
  });
});

describe('invariant 17 — a DRAFT is deletable; a posted or voided expense never is', () => {
  // Ian 2026-08-25: "delete for simplicity." A draft is not a financial record — no entry,
  // no balance touched, nobody asserted it. Everything posted is reversed, never removed.

  it('the creator deletes their own draft, and its payment rows go with it', async () => {
    const f = await setup('inv17a');
    const catId = await categoryId(f.orgId, 'Smallwares');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Wrong store, start again',
        payments: [
          { method: 'cash', amount: '120.00', moneyAccountId: f.cashDrawerId },
          { method: 'online', amount: '80.00', moneyAccountId: f.walletId },
        ],
      }),
    );

    const before = await sql<{ c: number }[]>`select count(*)::int c from expense_payments where expense_id = ${created.id}`;
    expect(before[0]!.c).toBe(2);

    await asPerson(f.orgId, (tx) => deleteExpenseDraft(tx, actor(f.orgId, f.staffId), created.id));

    const rows = await sql<{ c: number }[]>`select count(*)::int c from expenses where id = ${created.id}`;
    expect(rows[0]!.c).toBe(0);
    // The child rows must go too — expense_payments does not cascade, so a delete that
    // forgot them would either fail or orphan them. Proven, not assumed.
    const after = await sql<{ c: number }[]>`select count(*)::int c from expense_payments where expense_id = ${created.id}`;
    expect(after[0]!.c).toBe(0);
  });

  it('a POSTED expense is not deletable, by anyone — including an admin', async () => {
    const f = await setup('inv17b');
    const catId = await categoryId(f.orgId, 'Insurance');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.managerId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Posted, therefore permanent',
        payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));

    await expect(
      asPerson(f.orgId, (tx) => deleteExpenseDraft(tx, actor(f.orgId, f.adminId), created.id)),
    ).rejects.toThrow(/only a draft may be deleted/);

    const rows = await sql<{ c: number }[]>`select count(*)::int c from expenses where id = ${created.id}`;
    expect(rows[0]!.c).toBe(1);
  });

  it('a VOIDED expense is not deletable either — the reversal must stay visible', async () => {
    const f = await setup('inv17c');
    const catId = await categoryId(f.orgId, 'Insurance');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.managerId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Voided, and it stays',
        payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    await asPerson(f.orgId, (tx) => voidExpense(tx, actor(f.orgId, f.managerId), created.id, 'wrong supplier'));

    await expect(
      asPerson(f.orgId, (tx) => deleteExpenseDraft(tx, actor(f.orgId, f.adminId), created.id)),
    ).rejects.toThrow(/only a draft may be deleted/);
  });

  it('outside the 48h window the creator (staff) is DENIED — same gate as editing', async () => {
    // The whole point of reusing edit_own/edit_any rather than minting a delete capability:
    // the window cannot drift, because there is only one window.
    const f = await setup('inv17d');
    const catId = await categoryId(f.orgId, 'Smallwares');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Aging draft nobody finished',
        payments: [{ method: 'cash', amount: '99.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await sql`update expenses set created_at = now() - interval '49 hours' where id = ${created.id}`;

    await expect(
      asPerson(f.orgId, (tx) => deleteExpenseDraft(tx, actor(f.orgId, f.staffId), created.id)),
    ).rejects.toThrow(AuthorizationError);

    // A manager holds edit_any_expense and can still clear it — the window governs who may
    // act unsupervised, it does not strand the draft forever.
    await asPerson(f.orgId, (tx) => deleteExpenseDraft(tx, actor(f.orgId, f.managerId), created.id));
    const rows = await sql<{ c: number }[]>`select count(*)::int c from expenses where id = ${created.id}`;
    expect(rows[0]!.c).toBe(0);
  });
});

// =========================================================================================
// T-139 extended — no expense may overdraw the account it draws on (Ian, 2026-08-26)
// =========================================================================================

describe('overdrawing an expense account — warn for cashier, block for office (row 154)', () => {
  /** Drains an account to a known balance, so the ceiling in each test is exact. */
  async function drainTo(orgId: string, storeId: string, code: string, keep: string) {
    const [row] = await sql<{ total: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as total
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and je.status <> 'draft' and a.code = ${code}
        and jl.store_id = ${storeId}
    `;
    const excess = (Number(row!.total) - Number(keep)).toFixed(2);
    if (Number(excess) <= 0) return;
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${orgId} limit 1
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${orgId}, '2026-01-03', ${period!.id}, 'test', ${uid('drain')}, 'draft') returning id
      `;
      const [cash] = await tx<{ id: string }[]>`
        select id from accounts where org_id = ${orgId} and code = ${code}
      `;
      // ⚠️ 3900 for the same reason as fundAccount above — draining a till is an opening-balance
      // adjustment, not an owner's drawing.
      const [equity] = await tx<{ id: string }[]>`
        select id from accounts where org_id = ${orgId} and code = '3900'
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, 1, ${equity!.id}, ${storeId}, ${excess}, '0')
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, 2, ${cash!.id}, ${storeId}, '0', ${excess})
      `;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
  }

  async function draft(f: Fixture, amount: string, moneyAccountId: string): Promise<string> {
    const cat = await categoryId(f.orgId, 'Supplies and Stocks');
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: '2026-01-15',
        categoryId: cat,
        particulars: 'Cleaning supplies',
        payments: [{ method: 'cash', amount, moneyAccountId }],
      }),
    );
    return created.id;
  }

  it('⭐ a CASHIER drawer POSTS with a warning — the till holds what the ledger cannot see', async () => {
    const f = await setup('od1');
    await drainTo(f.orgId, f.storeId, '1110', '1000.00');
    const id = await draft(f, '1500.00', f.cashDrawerId);

    // Ian, 2026-08-26: "warning for now, don't block ... only to cashier owned account, since
    // only cashier owned account might experience this." A sales day posts at VERIFY, so at 2pm
    // the drawer reads ₱0 while holding the day's takings.
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), id),
    );
    expect(posted.journalEntryId).toBeTruthy();
    expect(posted.warnings?.[0]).toMatch(/short 500\.00/);
    expect(posted.warnings?.[0]).toMatch(/unverified/);

    // ⭐ It really posted. The warning is information, not a soft failure.
    const row = await expenseRow(f.orgId, id);
    expect(row!.status).toBe('posted');
  });

  it('⛔ an OFFICE safe is REFUSED, and the draft survives to be fixed', async () => {
    const f = await setup('od2');
    await drainTo(f.orgId, f.storeId, '1130', '1000.00');
    const id = await draft(f, '1500.00', f.officeSafeId);

    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), id)),
    ).rejects.toThrow(/balance is complete/);

    // ⚠️ The refusal must not consume the document. This is why the check lives at APPROVE and
    // not at create: a draft naming money that has not arrived yet is legitimate — only the
    // moment it POSTS has to be true.
    const still = await expenseRow(f.orgId, id);
    expect(still!.status).toBe('draft');

    await fundAccount(f.orgId, f.storeId, '1130', '5000.00', null);
    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), id)),
    ).resolves.toBeTruthy();
  });

  it('⭐ sums the SPLIT per account — two affordable lines that together are not', async () => {
    const f = await setup('od3');
    await drainTo(f.orgId, f.storeId, '1130', '1000.00');

    const cat = await categoryId(f.orgId, 'Supplies and Stocks');
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: '2026-01-15',
        categoryId: cat,
        particulars: 'Two cash lines, one safe',
        payments: [
          { method: 'cash', amount: '600.00', moneyAccountId: f.officeSafeId },
          { method: 'cash', amount: '600.00', moneyAccountId: f.officeSafeId },
        ],
      }),
    );

    // ⛔ ₱600 and ₱600 are each affordable against ₱1,000; together they are not. Checking one
    // payment row at a time would let exactly this through — the DEF-065 family of error, where
    // a split's rows are only ever right when considered together.
    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id)),
    ).rejects.toThrow(/holds 1000\.00 and this takes 1200\.00/);
  });

  it('a REIMBURSABLE expense is unaffected — it moves no store money now', async () => {
    const f = await setup('od4');
    await drainTo(f.orgId, f.storeId, '1110', '0.00');
    await drainTo(f.orgId, f.storeId, '1130', '0.00');

    const cat = await categoryId(f.orgId, 'Supplies and Stocks');
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: '2026-01-15',
        categoryId: cat,
        particulars: 'Staff paid out of pocket',
        payments: [{ method: 'reimbursable', amount: '9000.00', staffId: f.staffId }],
      }),
    );

    // ⭐ Staff paying out of their own pocket from an empty drawer is not an overdraft — no store
    // money leaves today, it becomes a payable to them. The guard only ever looks at payments
    // that name a money account.
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), created.id),
    );
    expect(posted.warnings).toBeUndefined();
  });
});

// =====================================================================================
// T-153 — the till float as a payment source. Ian's worked example, 2026-08-29.
// =====================================================================================

describe("T-153 — Ian's worked example: the drawer runs out and the float covers the rest", () => {
  it('⭐ T-316 S1: an expense of takings plus float draws ONE 1110 leg — the float is a target on the drawer, not a second account', async () => {
    // > **Ian, 2026-08-29:** *"sales comes say cashier cash +1000, online +500. Then a delivery
    // > came worth 3000 so cashier cash −1000 = 0, online not touched cause delivery is cash…
    // > 2000 from float then 18k balance to total 3k. So it has its own line on split payment."*
    //
    // ⭐ His example, to the peso. The drawer covers what it has and the side pocket covers the
    // rest; the online wallet is untouched because a cash delivery is a cash delivery.
    const f = await setup('t153-split');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');

    const { moneyAccountId: potId } = await asPerson(f.orgId, (tx) =>
      setTillFloat(tx, actor(f.orgId, f.adminId), { storeId: f.storeId, target: '20000.00' }),
    );
    // T-316 S1: the float and the takings are ONE drawer now, so it holds both (was 1115 20,000 + 1110 1,000).
    expect(potId).toBe(f.cashDrawerId);
    await fundAccount(f.orgId, f.storeId, '1110', '21000.00', null);

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Delivery, part drawer part float',
        payments: [{ method: 'cash', amount: '3000.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    const posted = await asPerson(f.orgId, (tx) =>
      approveExpense(tx, actor(f.orgId, f.managerId), created.id),
    );
    expect(posted.created).toBe(true);

    // ⭐ Two separate credit legs — 1110 for the takings, 1115 for the side pocket. The float's
    // spending is visible as its own movement rather than buried in one cash figure.
    const lines = await linesFor(posted.journalEntryId);
    const byCode = Object.fromEntries(lines.map((l) => [l.code, l]));
    expect(Number(byCode['1110']!.credit)).toBeCloseTo(3000, 2); // was 1000 here + 1115 2000
    expect(byCode['1115']).toBeUndefined(); // T-316 S1: no second cash leg
    expect(lines.filter((l) => Number(l.credit) > 0)).toHaveLength(1);

    // ⭐ The pot now stands at ₱18,000 — Ian's "18k balance" — and says so as a finding, which is
    // exactly the state that asks to be topped back up to target.
    const pot = await asPerson(f.orgId, async (tx) => {
      const acct = await moneyAccountsRepo.getById(tx, f.orgId, potId);
      return moneyAccountsRepo.balanceOf(tx, f.orgId, acct!);
    });
    // setup() already funds the drawer with 500,000: 500,000 + 21,000 - 3,000.
    expect(Number(pot)).toBeCloseTo(518000, 2);

  });

  it('⛔ T-316 S1: a float-carrying drawer is NOT a side pocket — an expense past its balance is allowed (a warning) within the overdraft limit', async () => {
    // Ian, 2026-08-29: "we guard all accounts to never go negative, all stops at 0 never below."
    const f = await setup('t153-guard');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');
    const { moneyAccountId: potId } = await asPerson(f.orgId, (tx) =>
      setTillFloat(tx, actor(f.orgId, f.adminId), { storeId: f.storeId, target: '20000.00' }),
    );
    await fundAccount(f.orgId, f.storeId, '1110', '2000.00', null);

    const posted = await asPerson(f.orgId, async (tx) => {
        const created = await createExpense(tx, actor(f.orgId, f.staffId), {
          storeId: f.storeId,
          supplierId: f.supplierId,
          supplierInvoiceId: f.supplierInvoiceId,
          businessDate: BUSINESS_DATE,
          categoryId: catId,
          particulars: 'More than the drawer holds',
          payments: [{ method: 'cash', amount: '510000.00', moneyAccountId: potId }],
        });
        return approveExpense(tx, actor(f.orgId, f.managerId), created.id);
      });
    expect(potId).toBe(f.cashDrawerId);
    expect(posted.created).toBe(true); // was: rejects /side pocket/
  });

  it('⛔ T-316 S1 control: past the overdraft limit the same float-carrying drawer still refuses', async () => {
    const f = await setup('t316-guard-limit');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');
    const { moneyAccountId: potId } = await asPerson(f.orgId, (tx) =>
      setTillFloat(tx, actor(f.orgId, f.adminId), { storeId: f.storeId, target: '20000.00' }),
    );
    await fundAccount(f.orgId, f.storeId, '1110', '2000.00', null);
    await expect(
      asPerson(f.orgId, async (tx) => {
        const created = await createExpense(tx, actor(f.orgId, f.staffId), {
          storeId: f.storeId,
          supplierId: f.supplierId,
          supplierInvoiceId: f.supplierInvoiceId,
          businessDate: BUSINESS_DATE,
          categoryId: catId,
          particulars: 'Far past the overdraft',
          payments: [{ method: 'cash', amount: '600000.00', moneyAccountId: potId }],
        });
        return approveExpense(tx, actor(f.orgId, f.managerId), created.id);
      }),
    ).rejects.toThrow(/overdraft/);
  });
});

describe('⛔ DEF-157 — payReimbursement settles 2130, which nothing previously cleared', () => {
  async function reimbursableExpense(f: Fixture, amount: string): Promise<void> {
    const catId = await categoryId(f.orgId, 'Supplies and Stocks');
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'Staff fronted the cost',
        payments: [{ method: 'reimbursable', amount, staffId: f.staffId }],
      }),
    );
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
  }

  it('DR 2130 (party=employee) / CR the money account, and the outstanding balance drops', async () => {
    const f = await setup('def157-basic');
    await fundAccount(f.orgId, f.storeId, '1110', '10000.00', null);
    await reimbursableExpense(f, '1000.00');

    expect((await asPerson(f.orgId, (tx) => reimbursablePayableOf(tx, f.orgId, f.staffId))).outstanding)
      .toBe('1000.00');

    const paid = await asPerson(f.orgId, (tx) =>
      payReimbursement(tx, actor(f.orgId, f.managerId), {
        storeId: f.storeId, employeeId: f.staffId, amount: '600.00', payoutId: crypto.randomUUID(),
        fromMoneyAccountId: f.cashDrawerId, on: '2026-01-16',
      }),
    );
    expect(paid.outstanding).toBe('400.00');

    const lines = await linesFor(paid.entryId);
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => l.debit !== '0.00')!;
    const credit = lines.find((l) => l.credit !== '0.00')!;
    expect(debit.code).toBe('2130');
    expect(debit.debit).toBe('600.00');
    expect(debit.party_type).toBe('employee');
    expect(debit.party_id).toBe(f.staffId);
    expect(credit.code).toBe('1110');
    expect(credit.credit).toBe('600.00');
  });

  it('⛔ refuses to pay more than is owed — there is nowhere for the overpayment to land', async () => {
    const f = await setup('def157-over');
    await fundAccount(f.orgId, f.storeId, '1110', '10000.00', null);
    await reimbursableExpense(f, '500.00');

    await expect(
      asPerson(f.orgId, (tx) =>
        payReimbursement(tx, actor(f.orgId, f.managerId), {
          storeId: f.storeId, employeeId: f.staffId, amount: '5000.00', payoutId: crypto.randomUUID(),
          fromMoneyAccountId: f.cashDrawerId, on: '2026-01-16',
        }),
      ),
    ).rejects.toThrow(/more than the 500.00 owed/);
  });

  it('⛔ refuses an employee with nothing outstanding', async () => {
    const f = await setup('def157-nothing');
    await fundAccount(f.orgId, f.storeId, '1110', '10000.00', null);

    await expect(
      asPerson(f.orgId, (tx) =>
        payReimbursement(tx, actor(f.orgId, f.managerId), {
          storeId: f.storeId, employeeId: f.staffId, amount: '100.00', payoutId: crypto.randomUUID(),
          fromMoneyAccountId: f.cashDrawerId, on: '2026-01-16',
        }),
      ),
    ).rejects.toThrow(/has nothing outstanding/);
  });

  it('DEF-272 — refuses "0.004" with a written sentence, not driver text', async () => {
    const f = await setup('def272-reimb');
    await fundAccount(f.orgId, f.storeId, '1110', '10000.00', null);
    await reimbursableExpense(f, '1000.00');
    await expect(
      asPerson(f.orgId, (tx) =>
        payReimbursement(tx, actor(f.orgId, f.managerId), {
          storeId: f.storeId, employeeId: f.staffId, amount: '0.004', payoutId: crypto.randomUUID(),
          fromMoneyAccountId: f.cashDrawerId, on: '2026-01-16',
        }),
      ),
    ).rejects.toMatchObject({"name":"RefusalError","message":"expenses.reimbursement.amount: money check failed","userMessage":"The reimbursement amount — \"0.004\" is not a valid amount. Use at most two decimal places."});
  });
});

// =========================================================================================
// T-343 S3 / DEF-417 part 2 — C3. `docs/tasks/343-def-417-human-readable-refusals.md`.
// ⛔ RED until the builder converts `expensesRepo.markExpenseVoided`'s throw to `recordGone(...)`
// — today it throws a bare `Error` whose message contains raw UUIDs, so `err.userMessage` is
// `undefined` and the regex below never matches.
//
// ⚠️ NOT a plain second `voidExpense(...)` call: `runVoidExpense` (`expenses/void.ts:54-61`) routes
// through `reverseEntry`, which is ALREADY idempotent (invariant 4's `created:false` pattern) — a
// second `voidExpense` on the same expense returns `created:false` and never even calls
// `expensesRepo.markExpenseVoided` again, so this exact repo guard is unreachable through the
// domain wrapper in a simple sequential double-click. It IS reachable — the guard exists for a
// genuine race between two concurrent void requests — so this test calls the repo function this
// task's own census names (`expenses.ts:524`) directly for the second write, which is the accurate
// way to prove THAT function's contract without fabricating a real concurrent race.
// =========================================================================================
describe('T-343 S3 — voiding an already-voided expense names the record, never a raw id', () => {
  it('markExpenseVoided on an already-voided row throws RecordGoneError: "That expense could not be found, or it is no longer posted."', async () => {
    const f = await setup('t343-c3');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');

    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'T-343 C3 — voided twice',
        payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    await asPerson(f.orgId, (tx) => voidExpense(tx, actor(f.orgId, f.managerId), created.id, 'First void'));

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) =>
        markExpenseVoided(tx, f.orgId, created.id, { voidedBy: f.managerId, voidReason: 'Second void' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage, 'the second void must carry a presentable userMessage').toBeDefined();
    expect(err.userMessage).toMatch(/^That expense could not be found, or it is no longer posted\./);
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // NEGATIVE — the raw diagnostic still names the org/expense ids, unedited (Invariant 1).
    expect(err.message).toMatch(new RegExp(created.id));
  });
});

// =========================================================================================
// T-343 S5.1 — expense refusals name things in human terms, never a raw id (rows 7, 8, 12)
// docs/tasks/343-def-417-human-readable-refusals.md §S5.1.
// =========================================================================================

/** A second supplier — created locally rather than added to the shared Fixture, since only
 *  create.ts:146's mismatch scenario (E4, F6) needs one. */
async function insertSupplier(orgId: string, name: string, createdBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${orgId}, ${name}, ${createdBy}) returning id
  `;
  return row!.id;
}

describe('T-343 S5.1 — expense refusals carry a human sentence', () => {
  it('E3a: approveExpense on a voided expense — exact sentence, no UUID', async () => {
    const f = await setup('t343-s51-e3a');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');
    const created = await asPerson(f.orgId, (tx) =>
      createExpense(tx, actor(f.orgId, f.staffId), {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: f.supplierInvoiceId,
        businessDate: BUSINESS_DATE,
        categoryId: catId,
        particulars: 'T-343 E3a',
        payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.cashDrawerId }],
      }),
    );
    await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    await asPerson(f.orgId, (tx) => voidExpense(tx, actor(f.orgId, f.managerId), created.id, 'wrong category'));

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) => approveExpense(tx, actor(f.orgId, f.managerId), created.id));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe("This expense has been voided, so it can't be posted.");
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // E5 (⛔ negative): the raw diagnostic still matches today's regex, unedited (Invariant 1).
    expect(err.message).toMatch(/is voided — cannot post/);
  });

  it('E3b: voidExpense on a stale id — "That expense could not be found.", no UUID', async () => {
    const f = await setup('t343-s51-e3b');
    const staleId = '00000000-0000-4000-8000-000000000000';

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) => voidExpense(tx, actor(f.orgId, f.managerId), staleId, 'anything'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toMatch(/^That expense could not be found\./);
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('E4: createExpense with supplier A\'s invoice and supplierId B names both suppliers, no UUID', async () => {
    const f = await setup('t343-s51-e4');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');
    const supplierBId = await insertSupplier(f.orgId, 'T-343 E4 Supplier B', f.staffId);

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) =>
        createExpense(tx, actor(f.orgId, f.staffId), {
          storeId: f.storeId,
          supplierId: supplierBId,
          supplierInvoiceId: f.supplierInvoiceId, // belongs to supplier A (f.supplierId)
          businessDate: BUSINESS_DATE,
          categoryId: catId,
          particulars: 'T-343 E4',
          payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.cashDrawerId }],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe(
      'That invoice is from t343-s51-e4 Supplier, not T-343 E4 Supplier B. An expense takes its supplier from its invoice.',
    );
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // E5 (⛔ negative): the raw diagnostic still matches today's regex, unedited (Invariant 1).
    expect(err.message).toMatch(/does not own supplier invoice/);
  });

  /**
   * F6 (R1.4). ⚠️ **Read this before touching the fixture below — a genuine ambiguity, flagged
   * rather than silently resolved (shareat-system-flag-unruled-behavior-in-new-tests):** the
   * spec's own words are "an expense WHOSE PARTICULARS are 'Rice\n sack' and an invoice number
   * containing U" — grammatically `input.particulars` and the invoice's own number. But
   * `create.ts:146`'s actual sentence (confirmed against the now-converted source) is
   * `` `That invoice is from ${supplier.name}, not ${picked?.name ?? '...'}. An expense takes
   * its supplier from its invoice.` `` — it interpolates NEITHER `particulars` NOR an invoice
   * number; the ONLY free-text, lookup-driven substitution is `picked.name` (the MISMATCHED
   * supplier's own name, refusal-path-looked-up from `input.supplierId`). There is no mechanism
   * by which `input.particulars` or an invoice number could reach this specific sentence at all.
   * **Read here as:** the picked supplier's NAME carries the messy content this fixture needs to
   * prove sanitisation against — "Rice\n sack" standing in for the newline-bearing free text,
   * and an appended UUID standing in for the id `refuse()` must redact. If this reading is wrong,
   * the planner corrects it; the assertions below are exactly F4's rules (whitespace collapse +
   * UUID redaction), just exercised through this real call site instead of a synthetic `refuse()`.
   */
  it('F6: sanitisation survives a real createExpense mismatch — one line, UUID hidden', async () => {
    const f = await setup('t343-s51-f6');
    const catId = await categoryId(f.orgId, 'Cost of Goods Sold — General');
    const messyU = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
    const supplierBId = await insertSupplier(f.orgId, `Rice\n sack ${messyU}`, f.staffId);

    let caught: unknown;
    try {
      await asPerson(f.orgId, (tx) =>
        createExpense(tx, actor(f.orgId, f.staffId), {
          storeId: f.storeId,
          supplierId: supplierBId,
          supplierInvoiceId: f.supplierInvoiceId,
          businessDate: BUSINESS_DATE,
          categoryId: catId,
          particulars: 'T-343 F6',
          payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.cashDrawerId }],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage, 'sanitised sentence must exist').toBeDefined();
    expect(err.userMessage).not.toMatch(/\n/);
    expect(err.userMessage).not.toContain(messyU);
    expect(err.userMessage).toContain('[hidden]');
    expect(err.userMessage).toBe('That invoice is from t343-s51-f6 Supplier, not Rice sack [hidden]. An expense takes its supplier from its invoice.');
  });
});
