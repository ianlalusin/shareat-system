/**
 * Reporting views — docs/tasks/110-reporting-views-and-screens.md.
 *
 * PROJECT_BIBLE.md §4.2 rule 7: derived data is a VIEW, never a maintained summary row.
 * No `account_balances` table, no rollup job, no cache. Every figure here is computed
 * from `journal_lines` at read time, every time — the audit run on 2026-08-24 found 34 of
 * 115 v1 account balances disagreeing with v1's own maintained counters, which is what
 * maintained counters do: they drift, silently, while looking authoritative.
 *
 * These are declared via `pgView(name, columns).as(sql\`...\`)` — the MANUAL view builder,
 * not `.as((qb) => qb.select(...)...)`. That is a deliberate choice, not the default: a
 * trial balance that must tie to the CENTAVO, with no tolerance, is exactly the kind of
 * correctness-critical SQL where "the query builder's translation of a multi-join,
 * GROUP BY, signed CASE expression is probably right" is a bet not worth making. Passing
 * the exact SQL text directly means what you read below IS what `pg_views` stores and IS
 * what runs — nothing is generated FROM these strings, drizzle-kit only records them
 * verbatim as the view body in migration 0010. The `columns` argument exists purely so the
 * repo layer (packages/db/src/repo/reports.ts) gets typed, autocompleted columns to select
 * from — it must match the SELECT list below exactly, in name and order, or the generated
 * DDL and the declared TypeScript type disagree silently.
 *
 * ---------------------------------------------------------------------------------------
 * v_account_balance — Contract §1. One row per (org_id, store_id, account_id, period_id).
 * `net_balance` is SIGNED BY THE ACCOUNT'S OWN `normal_balance` — a debit-normal account
 * with more debits reads positive, a credit-normal account with more credits reads
 * positive. A reader never needs to know an account's normal balance to interpret the
 * sign of this column. Only `journal_entries.status IN ('posted', 'reversed')` rows
 * contribute — a draft is not an assertion about anything (Contract §1) and a reversed
 * entry's own (now-net-zero) pair must both still count, or the trial balance would not
 * tie (Contract §1's own worked note).
 *
 * v_trial_balance — Contract §2. The SAME shape as v_account_balance, but grouped by
 * `entry_date` (and `source_type`, so the year-close entry can be excluded) instead of
 * `period_id` — a fiscal period is the wrong grain for "filterable by ... date range",
 * since a caller may ask for any arbitrary range, finer or wider than one period. The
 * repo layer re-aggregates this fine grain into per-account totals for the requested
 * range (packages/db/src/repo/reports.ts's `getTrialBalance`). This is still a VIEW
 * queried live, not a cache — "double aggregation at read time" is not the same thing as
 * a maintained summary row; nothing here is written by anyone, ever.
 *
 * v_income_statement — Contract §3. Restricted to `accounts.type IN ('income', 'expense')`
 * — Contract's own restriction. Two more columns beyond the Contract's literal text:
 *
 *   - `category` — 'revenue' | 'cost_of_sales' | 'operating_expense' |
 *     'other_income_expense' | 'other', derived from the account's PARENT HEADER code
 *     (4000/5000/6000/7000). This is what makes the Screen's fuller "revenue / cost of
 *     sales / gross profit / operating expenses / net income" breakdown possible: the
 *     Contract's own literal "GROUP BY account_type" gives only income-vs-expense, which
 *     cannot distinguish 5xxx cost-of-sales from 6xxx operating expenses (both
 *     type='expense'). Deriving the split from the account HIERARCHY already in the seed
 *     data (bible §16.9's fixed seven headers) is structurally identical to
 *     "GROUP BY account_type" — a small, fixed, bounded categorisation over EXISTING
 *     schema structure, not a per-account maintained list. A new account posted under an
 *     existing header buckets correctly with zero code change, which is exactly exit-gate
 *     condition 3 (invariant 8) and the defect v1 has (bible §16.7 #4). See the task
 *     report for the full reasoning and the alternative considered (a hardcoded per-code
 *     CASE list, rejected — it would BE the v1 defect).
 *   - `net_amount` — signed by the account's TYPE (not its individual normal_balance):
 *     income is credit-positive, expense is debit-positive, UNIFORMLY across every
 *     account of that type. This is deliberately different from v_account_balance's
 *     per-account signing, and it is what makes contra-revenue net correctly: 4900/4950
 *     are type='income' but normal_balance='debit' (Contract §3's two exceptions), so a
 *     debit against them produces a NEGATIVE net_amount in this credit-positive
 *     convention — summed together with ordinary revenue's positive net_amount, contra
 *     revenue subtracts automatically. No account-specific "is this a contra account"
 *     branch exists anywhere; the sign is a pure function of `accounts.type`.
 *
 * The year-close entry (ADR-006, `source_type = 'year_close'`) is not filtered out by
 * either view itself — `source_type` is exposed as a column precisely so the CALLER
 * decides, per ADR-006's own requirement: "a date-range P&L must be able to exclude it; a
 * balance-sheet-as-of must include it." Baking the exclusion into the view would make the
 * other case impossible.
 */
import { sql } from 'drizzle-orm';
import { date, numeric, pgView, text, uuid } from 'drizzle-orm/pg-core';

export const vAccountBalance = pgView('v_account_balance', {
  orgId: uuid('org_id').notNull(),
  storeId: uuid('store_id'),
  accountId: uuid('account_id').notNull(),
  periodId: uuid('period_id').notNull(),
  accountCode: text('account_code').notNull(),
  accountName: text('account_name').notNull(),
  accountType: text('account_type').notNull(),
  normalBalance: text('normal_balance').notNull(),
  debitTotal: numeric('debit_total', { precision: 14, scale: 2 }).notNull(),
  creditTotal: numeric('credit_total', { precision: 14, scale: 2 }).notNull(),
  netBalance: numeric('net_balance', { precision: 14, scale: 2 }).notNull(),
}).as(sql`
  select
    je.org_id as org_id,
    jl.store_id as store_id,
    jl.account_id as account_id,
    je.period_id as period_id,
    a.code as account_code,
    a.name as account_name,
    a.type as account_type,
    a.normal_balance as normal_balance,
    coalesce(sum(jl.debit), 0)::numeric(14,2) as debit_total,
    coalesce(sum(jl.credit), 0)::numeric(14,2) as credit_total,
    (case
      when a.normal_balance = 'debit' then coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0)
      else coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0)
    end)::numeric(14,2) as net_balance
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  join accounts a on a.id = jl.account_id
  where je.status in ('posted', 'reversed')
  group by je.org_id, jl.store_id, jl.account_id, je.period_id, a.code, a.name, a.type, a.normal_balance
`);

export const vTrialBalance = pgView('v_trial_balance', {
  orgId: uuid('org_id').notNull(),
  storeId: uuid('store_id'),
  accountId: uuid('account_id').notNull(),
  accountCode: text('account_code').notNull(),
  accountName: text('account_name').notNull(),
  accountType: text('account_type').notNull(),
  normalBalance: text('normal_balance').notNull(),
  entryDate: date('entry_date').notNull(),
  sourceType: text('source_type').notNull(),
  debitTotal: numeric('debit_total', { precision: 14, scale: 2 }).notNull(),
  creditTotal: numeric('credit_total', { precision: 14, scale: 2 }).notNull(),
  netBalance: numeric('net_balance', { precision: 14, scale: 2 }).notNull(),
}).as(sql`
  select
    je.org_id as org_id,
    jl.store_id as store_id,
    jl.account_id as account_id,
    a.code as account_code,
    a.name as account_name,
    a.type as account_type,
    a.normal_balance as normal_balance,
    je.entry_date as entry_date,
    je.source_type as source_type,
    coalesce(sum(jl.debit), 0)::numeric(14,2) as debit_total,
    coalesce(sum(jl.credit), 0)::numeric(14,2) as credit_total,
    (case
      when a.normal_balance = 'debit' then coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0)
      else coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0)
    end)::numeric(14,2) as net_balance
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  join accounts a on a.id = jl.account_id
  where je.status in ('posted', 'reversed')
  group by je.org_id, jl.store_id, jl.account_id, a.code, a.name, a.type, a.normal_balance, je.entry_date, je.source_type
`);

export const vIncomeStatement = pgView('v_income_statement', {
  orgId: uuid('org_id').notNull(),
  storeId: uuid('store_id'),
  accountId: uuid('account_id').notNull(),
  accountCode: text('account_code').notNull(),
  accountName: text('account_name').notNull(),
  accountType: text('account_type').notNull(),
  category: text('category').notNull(),
  entryDate: date('entry_date').notNull(),
  sourceType: text('source_type').notNull(),
  debitTotal: numeric('debit_total', { precision: 14, scale: 2 }).notNull(),
  creditTotal: numeric('credit_total', { precision: 14, scale: 2 }).notNull(),
  netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(),
}).as(sql`
  select
    je.org_id as org_id,
    jl.store_id as store_id,
    jl.account_id as account_id,
    a.code as account_code,
    a.name as account_name,
    a.type as account_type,
    (case hdr.code
      when '4000' then 'revenue'
      when '5000' then 'cost_of_sales'
      when '6000' then 'operating_expense'
      when '7000' then 'other_income_expense'
      else 'other'
    end) as category,
    je.entry_date as entry_date,
    je.source_type as source_type,
    coalesce(sum(jl.debit), 0)::numeric(14,2) as debit_total,
    coalesce(sum(jl.credit), 0)::numeric(14,2) as credit_total,
    (case
      when a.type = 'income' then coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0)
      else coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0)
    end)::numeric(14,2) as net_amount
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  join accounts a on a.id = jl.account_id
  left join accounts hdr on hdr.id = a.parent_id
  where je.status in ('posted', 'reversed')
    and a.type in ('income', 'expense')
  group by je.org_id, jl.store_id, jl.account_id, a.code, a.name, a.type, hdr.code, je.entry_date, je.source_type
`);
