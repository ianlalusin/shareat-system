import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-126 — loans. Bible row 158.
 *
 * ⭐ The figures come from the two real Grab loans the ERPNext migration measured, because they are
 * how this business actually borrows: straight-line, quoted monthly, repaid by whatever the day's
 * net allows.
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
import { closeDb, loansRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createLoan,
  disburseLoan,
  recordLoanPayment,
  reverseLoanEntry,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`ln-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const periods: readonly (readonly [string, string])[] = [
    ['2026-05-01', '2026-05-31'],
    ['2026-06-01', '2026-06-30'],
    ['2026-07-01', '2026-07-31'],
  ];
  for (const [from, to] of periods) {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${org!.id}, ${from}, ${to}, 'open')`;
  }
  return { orgId: org!.id, storeId: store!.id };
}

async function person(orgId: string, storeId: string, name: string, role: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** ⭐ Grab's Loan A: ₱200,000 at 2%/month straight, 90 daily instalments, started 2026-05-11. */
async function fixture(hint: string) {
  const o = await newOrg(hint);
  const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
  const admin = actor(o.orgId, adminId);
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${o.storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  const loan = await asOrg(o.orgId, (tx) =>
    createLoan(tx, admin, {
      storeId: o.storeId,
      lenderName: 'Grab',
      name: 'Grab cash advance A',
      principalAmount: '200000.00',
      interestRate: '2',
      ratePeriod: 'month',
      interestMethod: 'straight',
      paymentFrequency: 'daily',
      termPeriods: 90,
      startDate: '2026-05-11',
    }),
  );
  return { ...o, adminId, admin, safe: safe!.id, loanId: loan.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function legsOf(entryId: string) {
  return sql<{ code: string; debit: string; credit: string; party_type: string | null }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.party_type
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by a.code
  `;
}

async function position(f: Fixture) {
  return asOrg(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, f.loanId));
}

beforeAll(async () => {
  await sql`
    truncate table
      loans, stored_files, remittance_variances, remittance_allocations, remittance_lines,
      remittances, scheduler_runs, prepaid_items, money_transfers, money_accounts,
      expense_payments, expenses, expense_categories, person_grants, person_store_scope,
      person_roles, journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('⛔ none of v1’s four running totals exists as a column', () => {
  it('the register holds TERMS, and the ledger holds the money', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'loans'
        and column_name in ('total_paid','principal_paid','interest_paid','outstanding_balance')
    `;
    // v1 carried all four, plus a loanPayments collection, plus a LoanLedgerEntry with its own
    // balanceBefore — three registers of one debt. The migration measured the result: "NEITHER
    // figure is usable."
    expect(cols).toEqual([]);
  });

  it('⛔ and there is no loan_payments table either', async () => {
    const [t] = await sql<{ n: number }[]>`
      select count(*)::int n from pg_tables where schemaname = 'public' and tablename = 'loan_payments'
    `;
    // A payment is not a thing beside the ledger; it IS a ledger entry.
    expect(t!.n).toBe(0);
  });
});

describe('the postings', () => {
  it('disbursement: DR the money account, CR 2400 with the LOAN as party', async () => {
    const f = await fixture('disburse');
    const r = await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId,
        amount: '200000.00',
        intoMoneyAccountId: f.safe,
        on: '2026-05-11',
      }),
    );
    expect(await legsOf(r.entryId)).toEqual([
      { code: '1130', debit: '200000.00', credit: '0.00', party_type: null },
      // ⭐ The party is the LOAN, not the lender — a lender can hold two loans, and v1's own data
      // has exactly that.
      { code: '2400', debit: '0.00', credit: '200000.00', party_type: 'loan' },
    ]);
    expect((await position(f)).outstanding).toBe('200000.00');
  });

  it('⭐ payment: the split is COMPUTED, and one day of straight interest is ₱133.33', async () => {
    const f = await fixture('pay');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId, amount: '200000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );

    // One day later, the scheduled instalment. ₱200,000 × 2%/30 = ₱133.33 interest.
    const r = await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, {
        loanId: f.loanId, amount: '2355.56', fromMoneyAccountId: f.safe, on: '2026-05-12',
      }),
    );
    expect(r.split.interest).toBe('133.33');
    expect(r.split.principal).toBe('2222.23');

    expect(await legsOf(r.entryId)).toEqual([
      { code: '1130', debit: '0.00', credit: '2355.56', party_type: null },
      { code: '2400', debit: '2222.23', credit: '0.00', party_type: 'loan' },
      { code: '7200', debit: '133.33', credit: '0.00', party_type: null },
    ]);
    expect(r.outstanding).toBe('197777.77');
  });

  it('⭐ a payment SMALLER than the interest retires no principal', async () => {
    const f = await fixture('small');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId, amount: '200000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );
    // "The history shows Grab repeatedly deducting LESS than the instalment when the day's net is
    // small." ₱100 against ₱133.33 accrued.
    const r = await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, {
        loanId: f.loanId, amount: '100.00', fromMoneyAccountId: f.safe, on: '2026-05-12',
      }),
    );
    expect(r.split).toMatchObject({ interest: '100.00', principal: '0.00' });
    // ⚠️ The debt is unchanged. A split that quietly moved some to principal would show it
    // shrinking on a day it did not.
    expect(r.outstanding).toBe('200000.00');
  });
});

describe('the refusals', () => {
  it('⛔ refuses to draw more than the agreement', async () => {
    const f = await fixture('overdraw');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId, amount: '200000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        disburseLoan(tx, f.admin, {
          loanId: f.loanId, amount: '1000.00', intoMoneyAccountId: f.safe, on: '2026-05-12',
        }),
      ),
    ).rejects.toThrow(/still undrawn on this agreement/);
  });

  it('⛔ refuses an overpayment rather than absorbing it', async () => {
    const f = await fixture('over');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId, amount: '1000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );
    // ⛔ Money beyond the debt is a refund from the lender, not a negative loan.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordLoanPayment(tx, f.admin, {
          loanId: f.loanId, amount: '5000.00', fromMoneyAccountId: f.safe, on: '2026-05-12',
        }),
      ),
    ).rejects.toThrow(/would be an overpayment/);
  });

  it('⛔ staff cannot disburse or pay', async () => {
    const f = await fixture('deny');
    const staffId = await person(f.orgId, f.storeId, 'Staff', 'staff');
    await expect(
      asOrg(f.orgId, (tx) =>
        disburseLoan(tx, actor(f.orgId, staffId), {
          loanId: f.loanId, amount: '100.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe('⭐ paid_off is DERIVED, and a reversal re-opens it', () => {
  it('clears on the final payment and comes back when it is reversed', async () => {
    const f = await fixture('cleared');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId, amount: '1000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );
    // Same day, so no interest has accrued — the whole payment retires principal.
    const paid = await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, {
        loanId: f.loanId, amount: '1000.00', fromMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );
    expect(paid.paidOff).toBe(true);
    expect((await asOrg(f.orgId, (tx) => loansRepo.getById(tx, f.orgId, f.loanId)))!.status)
      .toBe('paid_off');

    await asOrg(f.orgId, (tx) =>
      reverseLoanEntry(tx, f.admin, {
        loanId: f.loanId, entryId: paid.entryId, reason: 'Posted against the wrong loan',
      }),
    );

    // ⚠️ Otherwise a reversed final payment leaves a settled-looking loan that still owes money —
    // exactly the state a stored total gets stuck in.
    expect((await asOrg(f.orgId, (tx) => loansRepo.getById(tx, f.orgId, f.loanId)))!.status)
      .toBe('active');
    expect((await position(f)).outstanding).toBe('1000.00');
  });

  it('the payment history reads from the ledger, and drops reversed entries', async () => {
    const f = await fixture('history');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId, amount: '10000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );
    const a = await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, {
        loanId: f.loanId, amount: '500.00', fromMoneyAccountId: f.safe, on: '2026-05-12',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, {
        loanId: f.loanId, amount: '500.00', fromMoneyAccountId: f.safe, on: '2026-05-13',
      }),
    );

    expect(await asOrg(f.orgId, (tx) => loansRepo.paymentsFor(tx, f.orgId, f.loanId))).toHaveLength(2);

    await asOrg(f.orgId, (tx) =>
      reverseLoanEntry(tx, f.admin, { loanId: f.loanId, entryId: a.entryId, reason: 'Duplicate' }),
    );
    // ⚠️ The reversed one drops out with no repair — there is no total to walk back.
    const after = await asOrg(f.orgId, (tx) => loansRepo.paymentsFor(tx, f.orgId, f.loanId));
    expect(after).toHaveLength(1);
    expect(after[0]!.paidOn).toBe('2026-05-13');
  });
});

describe('⛔ DEF-156 — reverseLoanEntry refuses an entry that is not this loan\'s own', () => {
  it('refuses to reverse a DIFFERENT loan\'s disbursement, and leaves it untouched', async () => {
    const f = await fixture('ownership-a');
    const otherLoan = await asOrg(f.orgId, (tx) =>
      createLoan(tx, f.admin, {
        storeId: f.storeId,
        lenderName: 'BDO',
        name: 'BDO term loan',
        principalAmount: '50000.00',
        interestRate: '1.5',
        ratePeriod: 'month',
        interestMethod: 'straight',
        paymentFrequency: 'monthly',
        termPeriods: 12,
        startDate: '2026-05-11',
      }),
    );
    const otherDisbursement = await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: otherLoan.id, amount: '50000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        reverseLoanEntry(tx, f.admin, {
          loanId: f.loanId, entryId: otherDisbursement.entryId, reason: 'Wrong loan',
        }),
      ),
    ).rejects.toThrow(/does not belong to loan/);

    // The other loan's own disbursement must still stand — nothing reversed it.
    const otherPosition = await asOrg(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, otherLoan.id));
    expect(otherPosition.disbursed).toBe('50000.00');
    expect(otherPosition.outstanding).toBe('50000.00');
  });

  it('still reverses the loan\'s OWN entry exactly as before', async () => {
    const f = await fixture('ownership-b');
    const disbursed = await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, {
        loanId: f.loanId, amount: '1000.00', intoMoneyAccountId: f.safe, on: '2026-05-11',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      reverseLoanEntry(tx, f.admin, {
        loanId: f.loanId, entryId: disbursed.entryId, reason: 'Wrong amount',
      }),
    );
    expect((await position(f)).disbursed).toBe('0.00');
  });
});

describe('DEF-272 — a sub-centavo amount is refused with a written sentence, not driver text', () => {
  it('disburseLoan refuses "0.004" — a true bypass site (no money() call anywhere in the function before this fix)', async () => {
    const f = await fixture('def272-disburse');
    await expect(
      asOrg(f.orgId, (tx) =>
        disburseLoan(tx, f.admin, { loanId: f.loanId, amount: '0.004', intoMoneyAccountId: f.safe, on: '2026-05-11' }),
      ),
    ).rejects.toMatchObject({"name":"RefusalError","message":"loans.disburseLoan.amount: money check failed","userMessage":"The loan amount — \"0.004\" is not a valid amount. Use at most two decimal places."});
  });

  it('disburseLoan refuses "1.234" too', async () => {
    const f = await fixture('def272-disburse-precision');
    await expect(
      asOrg(f.orgId, (tx) =>
        disburseLoan(tx, f.admin, { loanId: f.loanId, amount: '1.234', intoMoneyAccountId: f.safe, on: '2026-05-11' }),
      ),
    ).rejects.toMatchObject({"name":"RefusalError","message":"loans.disburseLoan.amount: money check failed","userMessage":"The loan amount — \"1.234\" is not a valid amount. Use at most two decimal places."});
  });

  it('an ordinary disbursement still works, and the exact value reaches the row', async () => {
    const f = await fixture('def272-disburse-happy');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, { loanId: f.loanId, amount: '0.01', intoMoneyAccountId: f.safe, on: '2026-05-11' }),
    );
    expect((await position(f)).disbursed).toBe('0.01');
  });

  // ⭐ Before this fix, recordLoanPayment already refused "0.004" — but with money()'s raw
  // TypeError (`splitPayment({ payment: money(input.amount), ... })` called it unguarded), not a
  // written sentence. The DB was never at risk here; the message was the defect.
  it('recordLoanPayment refuses "0.004" with a written sentence, not money()\'s developer-facing TypeError', async () => {
    const f = await fixture('def272-payment');
    await asOrg(f.orgId, (tx) =>
      disburseLoan(tx, f.admin, { loanId: f.loanId, amount: '200000.00', intoMoneyAccountId: f.safe, on: '2026-05-11' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        recordLoanPayment(tx, f.admin, { loanId: f.loanId, amount: '0.004', fromMoneyAccountId: f.safe, on: '2026-05-12' }),
      ),
    ).rejects.toMatchObject({"name":"RefusalError","message":"loans.recordLoanPayment.amount: money check failed","userMessage":"The payment amount — \"0.004\" is not a valid amount. Use at most two decimal places."});
  });
});
