/**
 * The only place SQL is written for statutory payments (paying SSS / PhilHealth / Pag-IBIG / BIR what payroll credited
 * to 2210-2240). T-193 S2. `docs/tasks/193-statutory-remittance/REFRESH.md` s5 S2.
 *
 * OWED is never stored: it is summed live from the payslips of POSTED pay runs (ee + er + ec), by calendar month of the run's
 * `period_end` and by the run's store. PAID is the lines of POSTED payments (a voided payment's lines stay as history and
 * never count). Every amount leaves here as exact numeric text with two decimals - no JS number touches a sum.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { statutoryPaymentLines, statutoryPayments, type StatutoryPaymentAgency } from '../../schema/statutory';
import type { Money } from '@shareat/core/money';

export type StatutoryAgency = StatutoryPaymentAgency;

export interface MonthTotalRow {
  agency: StatutoryAgency;
  /** 'YYYY-MM-01' */
  month: string;
  storeId: string;
  owed: string;
  paid: string;
  outstanding: string;
}

export interface MonthDetailRow {
  payslipId: string;
  runId: string;
  storeId: string;
  personId: string;
  personName: string;
  ee: string;
  er: string;
  ec: string;
  total: string;
  /** The agency is in the payslip's `skipped_agencies`: the row stays, at 0.00. */
  notDeducted: boolean;
}

export interface ReconciliationRow {
  agency: StatutoryAgency;
  storeId: string;
  outstanding: string;
  glBalance: string;
}

export interface StatutoryPaymentRow {
  id: string;
  agency: StatutoryAgency;
  month: string;
  paidOn: string;
  moneyAccountId: string;
  referenceNo: string;
  penalty: string;
  notes: string | null;
  journalEntryId: string | null;
  status: 'posted' | 'voided';
  voidReason: string | null;
  voidedBy: string | null;
  createdBy: string;
  lines: { storeId: string; amount: string }[];
}

/** One row per (payslip, agency) of a pay run: ee / er / ec as that agency defines them. The caller filters the run. */
const owedSlips = sql`
  select pr.id as run_id, pr.store_id, pr.period_end, ps.id as payslip_id, ps.person_id, ps.skipped_agencies, x.agency, x.ee, x.er, x.ec
  from pay_runs pr
  join payslips ps on ps.run_id = pr.id and ps.org_id = pr.org_id
  cross join lateral (values
    ('sss',        ps.sss_ee,        ps.sss_er,        ps.sss_ec),
    ('philhealth', ps.philhealth_ee, ps.philhealth_er, 0::numeric),
    ('pagibig',    ps.pagibig_ee,    ps.pagibig_er,    0::numeric),
    ('bir',        ps.withholding,   0::numeric,       0::numeric)
  ) as x(agency, ee, er, ec)`;

export async function monthTotals(
  tx: Tx,
  orgId: string,
  filter: { agency?: StatutoryAgency; storeId?: string; year?: number } = {},
): Promise<MonthTotalRow[]> {
  const rows = await tx.execute(sql`
    with owed as (
      select o.agency, date_trunc('month', o.period_end)::date as month, o.store_id,
             sum(o.ee + o.er + o.ec) as amount
      from (${owedSlips} where pr.org_id = ${orgId} and pr.status = 'posted') o
      group by 1, 2, 3
    ),
    paid as (
      select sp.agency, sp.month, spl.store_id, sum(spl.amount) as amount
      from statutory_payments sp
      join statutory_payment_lines spl on spl.payment_id = sp.id and spl.org_id = sp.org_id
      where sp.org_id = ${orgId} and sp.status = 'posted'
      group by 1, 2, 3
    ),
    m as (
      select coalesce(o.agency, p.agency) as agency, coalesce(o.month, p.month) as month,
             coalesce(o.store_id, p.store_id) as store_id,
             coalesce(o.amount, 0) as owed, coalesce(p.amount, 0) as paid
      from owed o
      full join paid p on p.agency = o.agency and p.month = o.month and p.store_id = o.store_id
    )
    select m.agency, to_char(m.month, 'YYYY-MM-DD') as month, m.store_id::text as "storeId",
           m.owed::numeric(14,2)::text as owed, m.paid::numeric(14,2)::text as paid,
           (m.owed - m.paid)::numeric(14,2)::text as outstanding
    from m
    where (m.owed > 0 or m.paid > 0)
      ${filter.agency ? sql`and m.agency = ${filter.agency}` : sql``}
      ${filter.storeId ? sql`and m.store_id = ${filter.storeId}` : sql``}
      ${filter.year !== undefined ? sql`and extract(year from m.month) = ${filter.year}` : sql``}
    order by m.month, m.agency, m.store_id`);
  return rows as unknown as MonthTotalRow[];
}

export async function monthDetail(
  tx: Tx,
  orgId: string,
  agency: StatutoryAgency,
  month: string,
): Promise<MonthDetailRow[]> {
  const rows = await tx.execute(sql`
    select o.payslip_id::text as "payslipId", o.run_id::text as "runId", o.store_id::text as "storeId",
           o.person_id::text as "personId", p.display_name as "personName",
           o.ee::numeric(14,2)::text as ee, o.er::numeric(14,2)::text as er, o.ec::numeric(14,2)::text as ec,
           (o.ee + o.er + o.ec)::numeric(14,2)::text as total,
           (${agency}::text = any(o.skipped_agencies)) as "notDeducted"
    from (${owedSlips} where pr.org_id = ${orgId} and pr.status = 'posted'
            and pr.period_end >= ${month}::date and pr.period_end < (${month}::date + interval '1 month')) o
    join persons p on p.id = o.person_id and p.org_id = ${orgId}
    where o.agency = ${agency}
    order by o.store_id, p.display_name, o.payslip_id`);
  return rows as unknown as MonthDetailRow[];
}

/** ALL-TIME: outstanding (owed - paid over every month) next to the ledger's 22x0 balance (credit - debit, non-draft entries) per agency and store. */
export async function reconciliation(tx: Tx, orgId: string): Promise<ReconciliationRow[]> {
  const rows = await tx.execute(sql`
    with owed as (
      select o.agency, o.store_id, sum(o.ee + o.er + o.ec) as amount
      from (${owedSlips} where pr.org_id = ${orgId} and pr.status = 'posted') o
      group by 1, 2
    ),
    paid as (
      select sp.agency, spl.store_id, sum(spl.amount) as amount
      from statutory_payments sp
      join statutory_payment_lines spl on spl.payment_id = sp.id and spl.org_id = sp.org_id
      where sp.org_id = ${orgId} and sp.status = 'posted'
      group by 1, 2
    ),
    gl as (
      select c.agency, jl.store_id, sum(jl.credit - jl.debit) as amount
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      join (values ('sss','2210'), ('philhealth','2220'), ('pagibig','2230'), ('bir','2240')) as c(agency, code) on c.code = a.code
      where je.org_id = ${orgId} and a.org_id = ${orgId} and je.status <> 'draft' and jl.store_id is not null
      group by 1, 2
    ),
    keys as (
      select agency, store_id from owed union select agency, store_id from paid union select agency, store_id from gl
    )
    select k.agency, k.store_id::text as "storeId",
           (coalesce(o.amount, 0) - coalesce(p.amount, 0))::numeric(14,2)::text as outstanding,
           coalesce(g.amount, 0)::numeric(14,2)::text as "glBalance"
    from keys k
    left join owed o on o.agency = k.agency and o.store_id = k.store_id
    left join paid p on p.agency = k.agency and p.store_id = k.store_id
    left join gl g on g.agency = k.agency and g.store_id = k.store_id
    order by k.agency, k.store_id`);
  return rows as unknown as ReconciliationRow[];
}

export async function insertPayment(
  tx: Tx,
  input: {
    id: string;
    orgId: string;
    agency: StatutoryAgency;
    month: string;
    paidOn: string;
    moneyAccountId: string;
    referenceNo: string;
    penalty: Money;
    notes: string | null;
    createdBy: string;
  },
): Promise<void> {
  await tx.insert(statutoryPayments).values({
    id: input.id,
    orgId: input.orgId,
    agency: input.agency,
    month: input.month,
    paidOn: input.paidOn,
    moneyAccountId: input.moneyAccountId,
    referenceNo: input.referenceNo,
    penalty: input.penalty,
    notes: input.notes,
    createdBy: input.createdBy,
  });
}

export async function insertLines(
  tx: Tx,
  orgId: string,
  paymentId: string,
  lines: { storeId: string; amount: Money }[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx
    .insert(statutoryPaymentLines)
    .values(lines.map((l) => ({ orgId, paymentId, storeId: l.storeId, amount: l.amount })));
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<StatutoryPaymentRow | null> {
  const [row] = await tx
    .select()
    .from(statutoryPayments)
    .where(and(eq(statutoryPayments.id, id), eq(statutoryPayments.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  const lines = await tx
    .select({ storeId: statutoryPaymentLines.storeId, amount: statutoryPaymentLines.amount })
    .from(statutoryPaymentLines)
    .where(and(eq(statutoryPaymentLines.paymentId, id), eq(statutoryPaymentLines.orgId, orgId)));
  return {
    id: row.id,
    agency: row.agency,
    month: row.month,
    paidOn: row.paidOn,
    moneyAccountId: row.moneyAccountId,
    referenceNo: row.referenceNo,
    penalty: row.penalty,
    notes: row.notes,
    journalEntryId: row.journalEntryId,
    status: row.status,
    voidReason: row.voidReason,
    voidedBy: row.voidedBy,
    createdBy: row.createdBy,
    lines,
  };
}

/** Links the ledger entry, once. False = nothing changed (not this org's, or already linked). */
export async function setEntry(tx: Tx, orgId: string, id: string, journalEntryId: string): Promise<boolean> {
  const rows = await tx
    .update(statutoryPayments)
    .set({ journalEntryId })
    .where(and(eq(statutoryPayments.id, id), eq(statutoryPayments.orgId, orgId), sql`${statutoryPayments.journalEntryId} is null`))
    .returning({ id: statutoryPayments.id });
  return rows.length > 0;
}

/** Guarded in the WHERE (status = 'posted'), not read-then-write - two voids racing must not both succeed. */
export async function markVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; reason: string },
): Promise<boolean> {
  const rows = await tx
    .update(statutoryPayments)
    .set({ status: 'voided', voidReason: input.reason, voidedBy: input.voidedBy, voidedAt: new Date() })
    .where(and(eq(statutoryPayments.id, id), eq(statutoryPayments.orgId, orgId), eq(statutoryPayments.status, 'posted')))
    .returning({ id: statutoryPayments.id });
  return rows.length > 0;
}

/**
 * Locks the month's POSTED runs of these stores (month = calendar month of period_end), ids ascending so two callers cannot
 * deadlock. The status filter is IN the locking statement: a run voided while we waited is re-checked after the wait and drops out.
 */
export async function lockMonthRuns(tx: Tx, orgId: string, month: string, storeIds: string[]): Promise<string[]> {
  if (storeIds.length === 0) return [];
  const stores = sql.join(
    storeIds.map((s) => sql`${s}::uuid`),
    sql`, `,
  );
  const rows = await tx.execute(sql`
    select id::text as id from pay_runs
    where org_id = ${orgId} and status = 'posted' and store_id in (${stores})
      and period_end >= ${month}::date and period_end < (${month}::date + interval '1 month')
    order by id
    for update`);
  return (rows as unknown as { id: string }[]).map((r) => r.id);
}
