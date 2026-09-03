/**
 * The only place SQL is written for loans. T-126, bible row 158.
 *
 * ## ⭐ `positionOf` and `paymentsFor` are the point of this file
 *
 * v1 kept **four** running totals on the loan, a `loanPayments` collection, and a `LoanLedgerEntry`
 * with its own `balanceBefore` — three registers of one debt, and the ERPNext migration measured
 * the result: *"NEITHER figure is usable."* Here both come from the ledger, so there is nothing to
 * diverge.
 *
 * ⚠️ **Attribution is `source_type` + `source_id`, not the account.** `2400` is one control account
 * for every loan in the org, so the account cannot say whose debt a line is — the `party_id` and
 * the entry's `source_id` do.
 */
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { accounts } from '../../schema/accounts';
import { journalEntries, journalLines } from '../../schema/journal';
import {
  loans,
  type InterestMethod,
  type LoanStatus,
  type PaymentFrequency,
  type RatePeriod,
} from '../../schema/loans';

export const LOAN_LIABILITY_CODE = '2400';
export const INTEREST_EXPENSE_CODE = '7200';
export const DISBURSEMENT_SOURCE = 'loan_disbursement';
export const PAYMENT_SOURCE = 'loan_payment';
/** ⭐ `2400` is party-requiring and the party is THE LOAN, not the lender (bible row 158) — a
 *  lender can hold two loans, which v1's own data proves. That is what lets a position be read
 *  from the account rather than from a list of document types (DEF-145). */
export const LOAN_PARTY_TYPE = 'loan';

export interface LoanRow {
  id: string;
  orgId: string;
  storeId: string;
  lenderName: string;
  name: string;
  principalAmount: string;
  interestRate: string;
  ratePeriod: RatePeriod;
  interestMethod: InterestMethod;
  paymentFrequency: PaymentFrequency;
  termPeriods: number;
  startDate: string;
  status: LoanStatus;
  closedOn: string | null;
  closeReason: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface InsertLoanInput {
  orgId: string;
  storeId: string;
  lenderName: string;
  name: string;
  principalAmount: string;
  interestRate: string;
  ratePeriod: RatePeriod;
  interestMethod: InterestMethod;
  paymentFrequency: PaymentFrequency;
  termPeriods: number;
  startDate: string;
  notes?: string | null;
  createdBy: string;
}

export async function insertLoan(tx: Tx, input: InsertLoanInput): Promise<{ id: string }> {
  const [row] = await tx.insert(loans).values(input).returning({ id: loans.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<LoanRow | undefined> {
  const [row] = await tx
    .select()
    .from(loans)
    .where(and(eq(loans.id, id), eq(loans.orgId, orgId)))
    .limit(1);
  return row as LoanRow | undefined;
}

export async function listLoans(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string; status?: LoanStatus } = {},
): Promise<LoanRow[]> {
  const conditions = [eq(loans.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(loans.storeId, filter.storeId));
  if (filter.status) conditions.push(eq(loans.status, filter.status));
  const rows = await tx
    .select()
    .from(loans)
    .where(and(...conditions))
    .orderBy(desc(loans.startDate));
  return rows as LoanRow[];
}

export async function setStatus(
  tx: Tx,
  orgId: string,
  id: string,
  input: { status: LoanStatus; closedOn?: string | null; closeReason?: string | null },
): Promise<void> {
  await tx
    .update(loans)
    .set({ ...input, updatedAt: sql`now()` })
    .where(and(eq(loans.id, id), eq(loans.orgId, orgId)));
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — from the ledger, never from a column
// -------------------------------------------------------------------------------------

export interface LoanPosition {
  /** Principal actually disbursed. ⚠️ Not the agreed principal — a loan can be drawn in stages. */
  disbursed: string;
  /** Principal repaid: debits to `2400` on payment entries. */
  principalPaid: string;
  /** Interest recognised: debits to `7200` on this loan's entries. */
  interestPaid: string;
  /** `disbursed − principalPaid`. ⛔ Never a column. */
  outstanding: string;
}

/**
 * What this loan currently owes, summed from the ledger.
 *
 * ## ⛔ DEF-145 — the principal is read from the ACCOUNT AND PARTY, never from a list of documents
 *
 * This used to filter `je.source_type in ('loan_disbursement', 'loan_payment')`, which quietly
 * assumed the loan module is the only thing that ever moves `2400`. It is not: a platform docks a
 * repayment out of a payout, and `recordChannelSettlement` posts that `2400` debit as a leg of a
 * `channel_settlement` entry (T-150 §6 — two of v1's live channels do exactly this, one of them
 * cross-store). Under the old filter that repayment was **invisible here**: the trial balance was
 * right, the loan screen still showed the full amount outstanding, and nothing anywhere disagreed
 * loudly enough to notice.
 *
 * ⭐ This is bible row 145's rule in a second place: *"summed over enumerated document types, any
 * transaction missing from the enumeration silently breaks the reconciliation."* `2400` is a
 * party-requiring control account, so the loan's own balance on it is the answer, and it counts
 * repayment paths nobody has invented yet.
 *
 * ⚠️ Interest stays keyed on `loan_payment` deliberately: `7200` carries no party, and a platform
 * dock posts no interest at all — it books the whole deduction to principal. That is a real gap in
 * the settlement's model, named in DEF-145 rather than papered over here.
 *
 * ## ⚠️ Reversed entries are INCLUDED, and that is the correction
 *
 * The obvious filter — `status <> 'reversed'` — is **worse than no filter at all**, and the tests
 * caught it. A reversal is itself a posted entry carrying the same `source_type` and `source_id`,
 * so excluding the original while keeping its mirror leaves the mirror counting **in the opposite
 * direction**: a reversed ₱1,000 payment made the loan owe ₱2,000.
 *
 * ⭐ **The ledger already nets.** The original and its reversal sum to zero on their own, which is
 * the whole reason reversal is preferred to deletion — filtering is not merely unnecessary here,
 * it actively breaks the arithmetic it was meant to protect.
 */
export async function positionOf(tx: Tx, orgId: string, loanId: string): Promise<LoanPosition> {
  const [row] = await tx.execute(sql`
    select
      coalesce(sum(case when a.code = ${LOAN_LIABILITY_CODE} and jl.party_id = ${loanId}
                         and je.source_type = ${DISBURSEMENT_SOURCE}
                        then jl.credit - jl.debit else 0 end), 0)::text as disbursed,
      coalesce(sum(case when a.code = ${LOAN_LIABILITY_CODE} and jl.party_id = ${loanId}
                         and je.source_type <> ${DISBURSEMENT_SOURCE}
                        then jl.debit - jl.credit else 0 end), 0)::text as principal_paid,
      coalesce(sum(case when a.code = ${INTEREST_EXPENSE_CODE} and je.source_id = ${loanId}
                         and je.source_type = ${PAYMENT_SOURCE}
                        then jl.debit - jl.credit else 0 end), 0)::text as interest_paid
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and je.status <> 'draft'
      and (
        (a.code = ${LOAN_LIABILITY_CODE} and jl.party_type = ${LOAN_PARTY_TYPE} and jl.party_id = ${loanId})
        or (a.code = ${INTEREST_EXPENSE_CODE} and je.source_type = ${PAYMENT_SOURCE} and je.source_id = ${loanId})
      )
  `) as unknown as Record<string, string>[];

  const disbursed = Number(row?.disbursed ?? 0);
  const principalPaid = Number(row?.principal_paid ?? row?.principalPaid ?? 0);
  const interestPaid = Number(row?.interest_paid ?? row?.interestPaid ?? 0);

  return {
    disbursed: disbursed.toFixed(2),
    principalPaid: principalPaid.toFixed(2),
    interestPaid: interestPaid.toFixed(2),
    outstanding: (disbursed - principalPaid).toFixed(2),
  };
}

export interface LoanPaymentRow {
  entryId: string;
  paidOn: string;
  principal: string;
  interest: string;
  total: string;
  memo: string | null;
}

/**
 * ⭐ The payment history, read from the ledger — **there is no `loan_payments` table.**
 *
 * A payment is not a thing that happens alongside the ledger; it *is* a ledger entry. Giving it a
 * second home is how v1 ended up with three registers of one debt.
 */
export async function paymentsFor(
  tx: Tx,
  orgId: string,
  loanId: string,
): Promise<LoanPaymentRow[]> {
  const rows = await tx.execute(sql`
    select je.id::text                                   as entry_id,
           je.entry_date::text                           as paid_on,
           je.memo                                       as memo,
           coalesce(sum(case when a.code = ${LOAN_LIABILITY_CODE} then jl.debit - jl.credit else 0 end), 0)::text as principal,
           coalesce(sum(case when a.code = ${INTEREST_EXPENSE_CODE} then jl.debit - jl.credit else 0 end), 0)::text as interest
    from journal_entries je
    join journal_lines jl on jl.entry_id = je.id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and je.source_id = ${loanId}
      and je.source_type = ${PAYMENT_SOURCE}
      and je.status <> 'draft'
      -- ⚠️ A LIST is not a SUM, so here both halves go: the reversed original AND the reversal
      -- itself (reversal_of_entry_id is not null). Netting is right for a figure and wrong for a
      -- history — nobody wants to read a payment beside its own undo.
      and je.status <> 'reversed'
      and je.reversal_of_entry_id is null
    group by je.id, je.entry_date, je.memo
    order by je.entry_date asc, je.created_at asc
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => {
    const principal = Number(r.principal ?? 0);
    const interest = Number(r.interest ?? 0);
    return {
      entryId: String(r.entry_id ?? r.entryId),
      paidOn: String(r.paid_on ?? r.paidOn),
      principal: principal.toFixed(2),
      interest: interest.toFixed(2),
      total: (principal + interest).toFixed(2),
      memo: (r.memo ?? null) as string | null,
    };
  });
}

/** The last payment date, or null — what interest accrues FROM. */
export async function lastPaymentDate(
  tx: Tx,
  orgId: string,
  loanId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ d: sql<string>`max(${journalEntries.entryDate})::text` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceId, loanId),
        eq(journalEntries.sourceType, PAYMENT_SOURCE),
        ne(journalEntries.status, 'draft'),
        // Interest accrues from the last payment that still STANDS — a reversed one never happened.
        ne(journalEntries.status, 'reversed'),
        isNull(journalEntries.reversalOfEntryId),
      ),
    );
  return row?.d ?? null;
}

/**
 * Every loan's position in one query — the register screen's N+1 guard.
 *
 * ⛔ **DEF-145 applies here identically**, and the register is where it showed: `2400` movements
 * are keyed on the LOAN PARTY, so a repayment docked out of a platform payout counts. Interest is
 * a second leg because `7200` carries no party — hence the union rather than one scan.
 */
export async function positionsByLoan(tx: Tx, orgId: string): Promise<Map<string, LoanPosition>> {
  const rows = await tx.execute(sql`
    select loan_id,
           coalesce(sum(disbursed), 0)::text      as disbursed,
           coalesce(sum(principal_paid), 0)::text as principal_paid,
           coalesce(sum(interest_paid), 0)::text  as interest_paid
    from (
      select jl.party_id::text as loan_id,
             case when je.source_type = ${DISBURSEMENT_SOURCE} then jl.credit - jl.debit else 0 end as disbursed,
             case when je.source_type <> ${DISBURSEMENT_SOURCE} then jl.debit - jl.credit else 0 end as principal_paid,
             0 as interest_paid
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      -- ⚠️ Reversed entries stay IN: they and their reversals net to zero. See positionOf.
      where je.org_id = ${orgId} and je.status <> 'draft'
        and a.code = ${LOAN_LIABILITY_CODE} and jl.party_type = ${LOAN_PARTY_TYPE} and jl.party_id is not null
      union all
      select je.source_id::text, 0, 0, jl.debit - jl.credit
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and je.status <> 'draft'
        and a.code = ${INTEREST_EXPENSE_CODE} and je.source_type = ${PAYMENT_SOURCE}
    ) legs
    group by loan_id
  `);

  const map = new Map<string, LoanPosition>();
  for (const r of rows as unknown as Record<string, string>[]) {
    const disbursed = Number(r.disbursed ?? 0);
    const principalPaid = Number(r.principal_paid ?? r.principalPaid ?? 0);
    const interestPaid = Number(r.interest_paid ?? r.interestPaid ?? 0);
    map.set(String(r.loan_id ?? r.loanId), {
      disbursed: disbursed.toFixed(2),
      principalPaid: principalPaid.toFixed(2),
      interestPaid: interestPaid.toFixed(2),
      outstanding: (disbursed - principalPaid).toFixed(2),
    });
  }
  return map;
}
