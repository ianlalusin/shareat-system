import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * ⛔ T-266 §4 — **an expense paid from a staff float could not post at all**, and this file is
 * the proof it now can. `docs/tasks/266-money-lines.md`.
 *
 * ## What was broken
 *
 * `1120` (cash on hand — staff custodian) is seeded `requires_party: true`
 * (`packages/db/seed/chart-of-accounts.ts:133`) because ONE staff-float account per store serves
 * MANY holders at once — the party is the only thing that can decompose it. But `routeExpense`'s
 * `fundingLine` attached a party only when the GL code was `1140`, under a comment asserting
 * *"1110/1120/1130 ARE the location, and the trigger refuses a party on them."* True for two of
 * the three. So the credit line went in party-less and `journal_lines_party_requirement`
 * (migration `0007`) raised.
 *
 * ⚠️ **Why no test caught it.** `expense-routing.test.ts` HAD a case routing a 1120 payment — it
 * asserted the account code and never the party, so it covered the line without covering the
 * property that was wrong. And nobody hit it in the app because the expense form makes you
 * hand-type a `cash_request` id into a free-text box.
 *
 * ## ⛔ Why the obvious fix is the dangerous one
 *
 * Reading `account 1120 requires a party on every line` and dropping `requires_party` makes the
 * error disappear and the expense save. It also makes `floatPositionOf`'s `spent` bucket — which
 * selects on `party_type = 'cash_request'` — never see the spend. `outstanding` never falls, the
 * request never reaches `liquidated`, and DEF-159's gate then refuses that person **every future
 * float, permanently.** So this file asserts the float's ARITHMETIC, not merely that a row saved.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { cashRequestsRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  approveExpense,
  createExpense,
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  storeId: string;
  staffId: string;
  managerId: string;
  /** ⭐ The ONE staff-float account for this store — shared by every holder, which is exactly
   *  why its lines need a party. */
  staffFloatId: string;
  officeSafeId: string;
  categoryId: string;
  supplierId: string;
  supplierInvoiceId: string;
}

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** An opening balance into a GL code, so the office safe has something to release FROM. */
async function fundAccount(orgId: string, storeId: string, code: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft')
      returning id`;
    const [target] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 1, ${target!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${equity!.id}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t266-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;

  const person = async (name: string, role: 'staff' | 'manager') => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const staffId = await person(`${hint} Ana`, 'staff');
  const managerId = await person(`${hint} Manager`, 'manager');
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: managerId,
  });

  // ⭐ NOT inserted — `stores_seed_foundation_money_accounts` (migration 0029) already created
  // the five every store has from the moment it exists (bible row 156), Staff float among them.
  // Selecting them is also the more honest fixture: these are the rows a real store actually has.
  const account = async (custodian: 'staff' | 'office') => {
    const [row] = await sql<{ id: string }[]>`
      select id from money_accounts
      where org_id = ${orgId} and store_id = ${storeId}
        and custodian = ${custodian} and instrument = 'cash'`;
    if (!row) throw new Error(`setup: no ${custodian} cash account was seeded for this store`);
    return row.id;
  };
  const staffFloatId = await account('staff');
  const officeSafeId = await account('office');
  await fundAccount(orgId, storeId, '1130', '500000.00');

  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and account_code is not null limit 1`;
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${orgId}, ${`${hint} Supplier`}, ${staffId})
    returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/${hint}.jpg`}, 'image/jpeg', 1024, ${`sum-${code}`}, ${staffId})
    returning id`;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (
      org_id, store_id, supplier_id, invoice_date, total_amount, status,
      receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price
    ) values (
      ${orgId}, ${storeId}, ${supplier!.id}, '2026-01-05', '99999999.00', 'verified',
      ${file!.id}, ${managerId}, now(), ${staffId}, true, true, true, true
    ) returning id`;

  return {
    orgId, storeId, staffId, managerId, staffFloatId, officeSafeId,
    categoryId: category!.id, supplierId: supplier!.id, supplierInvoiceId: invoice!.id,
  };
}

const actorOf = (f: Fixture, personId: string): Actor => ({ orgId: f.orgId, personId });

/** Request -> approve -> release, through the real domain functions, so the float's `1120` debit
 *  is posted with the party the ledger actually uses. */
async function releaseFloatTo(f: Fixture, personId: string, amount: string): Promise<string> {
  const manager = actorOf(f, f.managerId);
  const { id } = await asPerson(f.orgId, (tx) =>
    createCashRequest(tx, actorOf(f, personId), {
      storeId: f.storeId, requestedFor: personId, purpose: 'Market run', amount, on: '2026-01-05',
    }),
  );
  await asPerson(f.orgId, (tx) =>
    decideCashRequest(tx, manager, { requestId: id, decision: 'approve', amount, on: '2026-01-05' }),
  );
  await asPerson(f.orgId, (tx) =>
    releaseCashRequest(tx, manager, {
      requestId: id, amount, fromMoneyAccountId: f.officeSafeId, on: '2026-01-05',
    }),
  );
  return id;
}

async function recordAndApprove(
  f: Fixture,
  payments: { method: 'cash'; amount: string; moneyAccountId: string; cashRequestId?: string | null }[],
  total: string,
): Promise<string> {
  const staff = actorOf(f, f.staffId);
  const { id } = await asPerson(f.orgId, (tx) =>
    createExpense(tx, staff, {
      storeId: f.storeId, businessDate: '2026-01-05', categoryId: f.categoryId,
      supplierId: f.supplierId, supplierInvoiceId: f.supplierInvoiceId,
      particulars: `staff float spend ${total}`, payments,
    }),
  );
  await asPerson(f.orgId, (tx) => approveExpense(tx, actorOf(f, f.managerId), id));
  return id;
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-266 §4 — an expense paid from a staff float', () => {
  it('⭐ POSTS, crediting 1120 with the cash request as the party', async () => {
    const f = await setup('posts');
    const requestId = await releaseFloatTo(f, f.staffId, '2000.00');

    const expenseId = await recordAndApprove(
      f,
      [{ method: 'cash', amount: '1500.00', moneyAccountId: f.staffFloatId, cashRequestId: requestId }],
      '1500.00',
    );

    const [expense] = await sql<{ journal_entry_id: string | null; status: string }[]>`
      select journal_entry_id, status from expenses where id = ${expenseId}`;
    expect(expense!.status).toBe('posted');
    expect(expense!.journal_entry_id).not.toBeNull();

    const [credit] = await sql<{ code: string; party_type: string | null; party_id: string | null; credit: string }[]>`
      select a.code, jl.party_type, jl.party_id, jl.credit
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${expense!.journal_entry_id} and jl.credit > 0`;

    expect(credit!.code).toBe('1120');
    // ⭐ The REQUEST, not the money account — one staff-float account per store cannot
    // decompose itself (T-266 §7.2).
    expect(credit!.party_type).toBe('cash_request');
    expect(credit!.party_id).toBe(requestId);
    expect(Number(credit!.credit)).toBe(1500);
  });

  it('⭐ moves the float — spent rises, outstanding falls, and the two agree', async () => {
    const f = await setup('arith');
    const requestId = await releaseFloatTo(f, f.staffId, '2000.00');

    const before = await asPerson(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, requestId));
    expect(Number(before.released)).toBe(2000);
    expect(Number(before.spent)).toBe(0);
    expect(Number(before.outstanding)).toBe(2000);

    await recordAndApprove(
      f,
      [{ method: 'cash', amount: '1500.00', moneyAccountId: f.staffFloatId, cashRequestId: requestId }],
      '1500.00',
    );

    const after = await asPerson(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, requestId));
    // ⛔ THIS is the assertion that a dropped party requirement would not satisfy. The row would
    // save, and `spent` would still read 0 — the float never closing, and DEF-159's gate locking
    // this person out of every future float.
    expect(Number(after.spent)).toBe(1500);
    expect(Number(after.outstanding)).toBe(500);
    expect(Number(after.released)).toBe(2000);
  });

  it('⛔ BLOCKS with a named reason when the float is not named — never raw trigger text', async () => {
    const f = await setup('block');
    await releaseFloatTo(f, f.staffId, '2000.00');

    const staff = actorOf(f, f.staffId);
    const { id } = await asPerson(f.orgId, (tx) =>
      createExpense(tx, staff, {
        storeId: f.storeId, businessDate: '2026-01-05', categoryId: f.categoryId,
        supplierId: f.supplierId, supplierInvoiceId: f.supplierInvoiceId,
        particulars: 'float spend with no request named',
        payments: [{ method: 'cash', amount: '300.00', moneyAccountId: f.staffFloatId }],
      }),
    );

    await expect(
      asPerson(f.orgId, (tx) => approveExpense(tx, actorOf(f, f.managerId), id)),
    ).rejects.toThrow(/staff float/);

    // ⚠️ And the draft is UNCHANGED — a refused approval is fixable, not destructive.
    const [row] = await sql<{ status: string }[]>`select status from expenses where id = ${id}`;
    expect(row!.status).toBe('draft');
  });

  it('⭐ two different floats on the SAME account stay separate — the case 1120 exists for', async () => {
    const f = await setup('two');
    const [ben] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Ben Reyes') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${ben!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${ben!.id}, ${f.storeId})`;
    const [benEmployment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${f.orgId}, ${f.storeId}, ${ben!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
      returning id
    `;
    await grantEverydayPositionAccess(sql, {
      orgId: f.orgId, storeId: f.storeId, employmentId: benEmployment!.id, personId: ben!.id, setBy: f.managerId,
    });

    const anaRequest = await releaseFloatTo(f, f.staffId, '2000.00');
    const benRequest = await releaseFloatTo(f, ben!.id, '1000.00');

    // One expense, split across BOTH floats — same money account, same GL code, two parties.
    await recordAndApprove(
      f,
      [
        { method: 'cash', amount: '1200.00', moneyAccountId: f.staffFloatId, cashRequestId: anaRequest },
        { method: 'cash', amount: '400.00', moneyAccountId: f.staffFloatId, cashRequestId: benRequest },
      ],
      '1600.00',
    );

    const ana = await asPerson(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, anaRequest));
    const benPos = await asPerson(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, benRequest));
    expect(Number(ana.outstanding)).toBe(800);
    expect(Number(benPos.outstanding)).toBe(600);
  });

  it('the office safe still posts with NO party — the trigger refuses one there', async () => {
    const f = await setup('safe');
    const expenseId = await recordAndApprove(
      f,
      [{ method: 'cash', amount: '900.00', moneyAccountId: f.officeSafeId }],
      '900.00',
    );
    const [credit] = await sql<{ code: string; party_type: string | null }[]>`
      select a.code, jl.party_type
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join expenses e on e.journal_entry_id = jl.entry_id
      where e.id = ${expenseId} and jl.credit > 0`;
    expect(credit!.code).toBe('1130');
    expect(credit!.party_type).toBeNull();
  });
});
