/**
 * T-431 "Everything unpaid" - the read queries that have no other home. Read-only; nothing is stored.
 * docs/tasks/431-unpaid-liabilities-view.md.
 *
 * Every function is ONE grouped query for the whole scope (never a loop over stores). `storeIds`
 * omitted = every store; an empty list = nothing (fail closed).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client';

function storeTail(column: SQL, storeIds: readonly string[] | undefined): SQL {
  if (storeIds === undefined) return sql``;
  if (storeIds.length === 0) return sql`and false`;
  return sql`and ${column} in (${sql.join(storeIds.map((id) => sql`${id}`), sql`, `)})`;
}

export interface UnpaidDraftRow {
  expenseId: string;
  storeId: string;
  supplierName: string | null;
  templateName: string;
  dueOn: string;
  /** Exact `numeric(14,2)` text. */
  amount: string;
}

/**
 * Recurring bills the runner drafted that nobody has recorded yet: a draft row JOINED to an expense
 * whose status is `draft`. A posted, voided or deleted (dangling `expense_id`) draft is not here.
 */
export async function unpaidRecurringDrafts(
  tx: Tx,
  orgId: string,
  storeIds?: readonly string[],
): Promise<UnpaidDraftRow[]> {
  const rows = (await tx.execute(sql`
    select d.expense_id::text as expense_id, e.store_id::text as store_id, s.name as supplier_name,
           t.name as template_name, d.due_date::text as due_on, e.total_amount::numeric(14,2)::text as amount
    from recurring_expense_drafts d
    join recurring_expenses t on t.id = d.recurring_expense_id
    join expenses e on e.id = d.expense_id and e.status = 'draft'
    left join suppliers s on s.id = e.supplier_id
    where d.org_id = ${orgId} ${storeTail(sql`e.store_id`, storeIds)}
    order by d.due_date asc, d.created_at asc
  `)) as unknown as Record<string, string | null>[];
  return rows.map((r) => ({
    expenseId: String(r.expense_id),
    storeId: String(r.store_id),
    supplierName: r.supplier_name ?? null,
    templateName: String(r.template_name),
    dueOn: String(r.due_on),
    amount: String(r.amount),
  }));
}

export interface LedgerBalanceRow {
  accountCode: string;
  accountName: string;
  /** null = a ledger line posted with no store. */
  storeId: string | null;
  partyType: string | null;
  partyId: string | null;
  /** Exact `numeric(14,2)` text of credit - debit (liability side positive), non-draft entries, reversals included. */
  balance: string;
}

/**
 * Ledger balance (credit - debit) per account, store and party, for the given account codes. The
 * source for kind 6 (the lines ARE these balances) and for every "Unmatched in the books" leftover.
 */
export async function ledgerBalancesByAccount(
  tx: Tx,
  orgId: string,
  codes: readonly string[],
  storeIds?: readonly string[],
): Promise<LedgerBalanceRow[]> {
  if (codes.length === 0) return [];
  const rows = (await tx.execute(sql`
    select a.code as account_code, a.name as account_name, jl.store_id::text as store_id, jl.party_type, jl.party_id::text as party_id,
           coalesce(sum(jl.credit - jl.debit), 0)::numeric(14,2)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.code in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
      ${storeTail(sql`jl.store_id`, storeIds)}
    group by a.code, a.name, jl.store_id, jl.party_type, jl.party_id
  `)) as unknown as Record<string, string | null>[];
  return rows.map((r) => ({
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    storeId: r.store_id === null || r.store_id === undefined ? null : String(r.store_id),
    partyType: r.party_type ?? null,
    partyId: r.party_id ?? null,
    balance: String(r.balance),
  }));
}

/** Store names and person names in one round trip, for labelling ledger parties. */
export async function partyNames(
  tx: Tx,
  orgId: string,
): Promise<{ stores: Map<string, string>; persons: Map<string, string> }> {
  const rows = (await tx.execute(sql`
    select 'store' as kind, id::text as id, name from stores where org_id = ${orgId}
    union all
    select 'person', id::text, display_name from persons where org_id = ${orgId}
  `)) as unknown as { kind: string; id: string; name: string }[];
  const stores = new Map<string, string>();
  const persons = new Map<string, string>();
  for (const r of rows) (r.kind === 'store' ? stores : persons).set(r.id, r.name);
  return { stores, persons };
}
