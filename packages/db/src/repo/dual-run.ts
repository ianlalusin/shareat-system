/**
 * dual-run - T-392 S3. The comparator's storage (reports, lines, dispositions) and the v2 side's figures.
 * docs/tasks/392-dual-run-comparator.md Contract sections 2 and 3, R5 / R5a, and "S3 rulings".
 *
 * Every function takes `tx` first and runs under the caller's principal. Reports, lines and dispositions are append-only
 * (the app role has SELECT and INSERT only), so nothing here updates or deletes.
 *
 * `v2Figures` reads the POSTED ledger only (`journal_entries.status` in posted / reversed; a draft contributes nothing).
 * Amounts are numeric(14,2) and leave as 2dp strings, never numbers. Dating:
 *  - `cash_bank`, `staff_cash`, `ap_supplier`, `inventory_basis`, `unassigned_store` keep the entry's OWN `entry_date`.
 *  - `sales_tender` and `expense_category` re-date a correction to the day it corrects (ruling 1), in this order:
 *    (a) `reversal_of_entry_id`: the original's resolved date, recursively; (b) `source_type 'sale'` with a
 *    `source_id` found in `sales_day_pos_corrections`: that sales day's `business_date`; (c) the same source as an earlier
 *    POSTED entry: the earliest one's `entry_date`. An entry none of (a)-(c) resolves keeps its own date and, when the same
 *    source also holds a DRAFT, is listed in `datedLater`.
 * The week is `weekStart..through` (Manila business dates: entry_date is already one, nothing here reads the clock).
 */
import { and, asc, between, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Money } from '@shareat/core/money';
import type { Tx } from '../client';
import {
  dualRunDispositions,
  dualRunLines,
  dualRunReports,
  type DualRunKind,
  type DualRunVerdict,
} from '../../schema/dual-run';
import { salesDays } from '../../schema/sales-days';
import { stores } from '../../schema/stores';
import { recordGone } from './record-gone';

const INVENTORY_CODES = ['1310', '1320', '1330', '1340', '5100', '5110', '5120', '5130', '5140', '5150', '5160', '5170', '5175', '5200', '5300', '5400', '5450'];
const invList = () => sql.join(INVENTORY_CODES.map((c) => sql`${c}`), sql`, `);

const rowsOf = <T>(r: unknown): T[] => r as unknown as T[];

export interface PerDay {
  date: string;
  v1: string;
  v2: string;
  delta: string;
  state: string;
}

export interface ReportInput {
  orgId: string;
  storeId: string;
  weekStart: string;
  through: string;
  v1Fingerprint: string;
  v2Fingerprint: string;
  keysSha: string;
  v1SnapshotSha: string;
  v1ExtractedAt: Date;
  verdict: DualRunVerdict;
  comparedDays: number;
  createdBy: string;
}

export interface LineInput {
  kind: DualRunKind;
  lineKey: string;
  label: string;
  v1Amount: Money;
  v2Amount: Money;
  delta: Money;
  class: string;
  paired: boolean;
  autoReason: string | null;
  perDay: PerDay[];
  v1Counter: Money | null;
  openingGap: Money | null;
}

export interface DispositionInput {
  orgId: string;
  storeId: string;
  weekStart: string;
  kind: DualRunKind;
  lineKey: string;
  deltaAt: Money;
  class: 'V1_DEFECT' | 'V2_DEFECT';
  ref: string;
  note: string;
  createdBy: string;
}

export interface LineRow {
  id: string;
  reportId: string;
  kind: DualRunKind;
  lineKey: string;
  label: string;
  v1Amount: string;
  v2Amount: string;
  delta: string;
  class: string;
  paired: boolean;
  autoReason: string | null;
  perDay: PerDay[];
  v1Counter: string | null;
  openingGap: string | null;
}

export async function insertReport(tx: Tx, input: ReportInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(dualRunReports)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      weekStart: input.weekStart,
      through: input.through,
      v1Fingerprint: input.v1Fingerprint,
      v2Fingerprint: input.v2Fingerprint,
      keysSha: input.keysSha,
      v1SnapshotSha: input.v1SnapshotSha,
      v1ExtractedAt: input.v1ExtractedAt,
      verdict: input.verdict,
      comparedDays: input.comparedDays,
      createdBy: input.createdBy,
    })
    .returning({ id: dualRunReports.id });
  return row!;
}

export async function insertLines(tx: Tx, reportId: string, lines: readonly LineInput[]): Promise<void> {
  if (lines.length === 0) return;
  // org_id is the REPORT's (S3 money ruling e). A report this principal cannot see (another org's) yields no row: raise.
  const [rep] = await tx.select({ orgId: dualRunReports.orgId }).from(dualRunReports).where(eq(dualRunReports.id, reportId));
  if (!rep) throw recordGone(`dual_run_lines: report ${reportId} not found in this org; nothing inserted`, 'dual-run report');
  await tx.insert(dualRunLines).values(
    lines.map((l) => ({
      orgId: rep.orgId,
      reportId,
      kind: l.kind,
      lineKey: l.lineKey,
      label: l.label,
      v1Amount: l.v1Amount,
      v2Amount: l.v2Amount,
      delta: l.delta,
      class: l.class,
      paired: l.paired,
      autoReason: l.autoReason,
      perDay: l.perDay,
      v1Counter: l.v1Counter,
      openingGap: l.openingGap,
    })),
  );
}

export async function insertDisposition(tx: Tx, input: DispositionInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(dualRunDispositions)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      weekStart: input.weekStart,
      kind: input.kind,
      lineKey: input.lineKey,
      deltaAt: input.deltaAt,
      class: input.class,
      ref: input.ref,
      note: input.note,
      createdBy: input.createdBy,
    })
    .returning({ id: dualRunDispositions.id });
  return row!;
}

export async function linesOf(tx: Tx, reportId: string): Promise<LineRow[]> {
  const rows = await tx
    .select()
    .from(dualRunLines)
    .where(eq(dualRunLines.reportId, reportId))
    .orderBy(asc(dualRunLines.kind), asc(dualRunLines.lineKey));
  return rows.map((r) => ({
    id: r.id,
    reportId: r.reportId,
    kind: r.kind,
    lineKey: r.lineKey,
    label: r.label,
    v1Amount: r.v1Amount,
    v2Amount: r.v2Amount,
    delta: r.delta,
    class: r.class,
    paired: r.paired,
    autoReason: r.autoReason,
    perDay: (typeof r.perDay === 'string' ? JSON.parse(r.perDay) : r.perDay) as PerDay[],
    v1Counter: r.v1Counter,
    openingGap: r.openingGap,
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// reads for the run (T-392 S4)
// ---------------------------------------------------------------------------------------------------------------------

/** The org's stores with these codes (RLS keeps another org's invisible). */
export async function storesByCode(tx: Tx, orgId: string, codes: readonly string[]): Promise<{ id: string; code: string }[]> {
  if (codes.length === 0) return [];
  return tx.select({ id: stores.id, code: stores.code }).from(stores).where(and(eq(stores.orgId, orgId), inArray(stores.code, [...codes])));
}

/** Business dates of the store's VERIFIED sales days in the window: v2's trading days (R13). */
export async function verifiedSalesDays(tx: Tx, orgId: string, storeId: string, weekStart: string, through: string): Promise<string[]> {
  const rows = await tx
    .select({ d: salesDays.businessDate })
    .from(salesDays)
    .where(and(eq(salesDays.orgId, orgId), eq(salesDays.storeId, storeId), eq(salesDays.status, 'verified'), between(salesDays.businessDate, weekStart, through)))
    .orderBy(asc(salesDays.businessDate));
  return rows.map((r) => r.d);
}

export interface DispositionRow {
  kind: DualRunKind;
  lineKey: string;
  deltaAt: string;
  class: 'V1_DEFECT' | 'V2_DEFECT';
  ref: string;
  createdAt: Date;
}

/** Every disposition recorded for a store-week (the comparator picks the latest per line). */
export async function dispositionsFor(tx: Tx, orgId: string, storeId: string, weekStart: string): Promise<DispositionRow[]> {
  return tx
    .select({
      kind: dualRunDispositions.kind,
      lineKey: dualRunDispositions.lineKey,
      deltaAt: dualRunDispositions.deltaAt,
      class: dualRunDispositions.class,
      ref: dualRunDispositions.ref,
      createdAt: dualRunDispositions.createdAt,
    })
    .from(dualRunDispositions)
    .where(and(eq(dualRunDispositions.orgId, orgId), eq(dualRunDispositions.storeId, storeId), eq(dualRunDispositions.weekStart, weekStart)))
    .orderBy(asc(dualRunDispositions.createdAt), asc(dualRunDispositions.id));
}

export interface ReportIdentity {
  orgId: string;
  storeId: string;
  weekStart: string;
  through: string;
  v1Fingerprint: string;
  keysSha: string;
  v2Fingerprint: string;
}

/** The report version with exactly this R8 identity, if one exists. */
export async function findReport(tx: Tx, key: ReportIdentity): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: dualRunReports.id })
    .from(dualRunReports)
    .where(
      and(
        eq(dualRunReports.orgId, key.orgId),
        eq(dualRunReports.storeId, key.storeId),
        eq(dualRunReports.weekStart, key.weekStart),
        eq(dualRunReports.through, key.through),
        eq(dualRunReports.v1Fingerprint, key.v1Fingerprint),
        eq(dualRunReports.keysSha, key.keysSha),
        eq(dualRunReports.v2Fingerprint, key.v2Fingerprint),
      ),
    )
    .orderBy(desc(dualRunReports.createdAt))
    .limit(1);
  return row;
}

/** The newest `v1_extracted_at` among the store-week's report versions; null when it has none. */
export async function latestExtractedAt(tx: Tx, orgId: string, storeId: string, weekStart: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: dualRunReports.v1ExtractedAt })
    .from(dualRunReports)
    .where(and(eq(dualRunReports.orgId, orgId), eq(dualRunReports.storeId, storeId), eq(dualRunReports.weekStart, weekStart)))
    .orderBy(desc(dualRunReports.v1ExtractedAt))
    .limit(1);
  return row?.at ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// v2 figures
// ---------------------------------------------------------------------------------------------------------------------

export type V2Kind = DualRunKind;

export interface V2Line {
  kind: V2Kind;
  /** null on `unassigned_store`. */
  storeId: string | null;
  glCode: string;
  partyType: string | null;
  partyId: string | null;
  /** `expense_category` only, and only when the entry's source is an expense (ruling 5). */
  categoryId?: string;
  debit: string;
  credit: string;
  /** debit - credit, except account 2110 (credit - debit): each line's natural balance. */
  amount: string;
  byDay: { date: string; amount: string }[];
}

export interface V2Figures {
  lines: V2Line[];
  /** Entries the dating rules could not place: they stay on their own date (ruling 1). */
  datedLater: { entryId: string }[];
}

/**
 * The entries of the org that touch the store (or no store), each with its effective date for the two re-dating kinds.
 * `eff_date` = (a) the reversal chain's root, then (b) the sales day of a POS correction, then (c) the earliest earlier
 * posted entry of the same source, then the entry's own date.
 */
function datedEntries(orgId: string, storeId: string) {
  return sql`
    ent as (
      select e.id, e.entry_date, e.source_type, e.source_id, e.reversal_of_entry_id
      from journal_entries e
      where e.org_id = ${orgId}::uuid and e.status in ('posted', 'reversed')
        and exists (select 1 from journal_lines jl where jl.entry_id = e.id and (jl.store_id = ${storeId}::uuid or jl.store_id is null))
    ),
    chain as (
      select id as entry_id, id as cur, reversal_of_entry_id as nxt from ent
      union all
      select c.entry_id, j.id, j.reversal_of_entry_id
      from chain c join journal_entries j on j.id = c.nxt and j.org_id = ${orgId}::uuid
    ),
    root as (select entry_id, cur as root_id from chain where nxt is null),
    dated as (
      select e.id, e.entry_date, e.source_type, e.source_id, r.source_type as root_src,
        coalesce(pb.d, pc.d, r.entry_date) as eff_date,
        (r.id = e.id and pb.d is null and pc.d is null and exists (
           select 1 from journal_entries dr
           where dr.org_id = ${orgId}::uuid and dr.source_type = r.source_type and dr.source_id = r.source_id and dr.id <> r.id
             and (dr.entry_date, dr.id) < (r.entry_date, r.id)
        )) as unresolved
      from ent e
      join root rt on rt.entry_id = e.id
      join journal_entries r on r.id = rt.root_id
      left join lateral (
        select sd.business_date as d
        from sales_day_pos_corrections c join sales_days sd on sd.id = c.sales_day_id
        where r.source_type = 'sale' and c.org_id = ${orgId}::uuid and c.id::text = r.source_id
      ) pb on true
      left join lateral (
        select min(s.entry_date) as d
        from journal_entries s
        where s.org_id = ${orgId}::uuid and s.status in ('posted', 'reversed')
          and s.source_type = r.source_type and s.source_id = r.source_id and s.id <> r.id
          and (s.entry_date, s.id) < (r.entry_date, r.id)
      ) pc on true
    )`;
}

export async function v2Figures(
  tx: Tx,
  orgId: string,
  input: { storeId: string; weekStart: string; through: string },
): Promise<V2Figures> {
  const { storeId, weekStart, through } = input;
  const inv = invList();
  const rows = rowsOf<{
    kind: V2Kind;
    store_id: string | null;
    gl_code: string;
    party_type: string | null;
    party_id: string | null;
    category_id: string | null;
    debit: string;
    credit: string;
    amount: string;
    by_day: { date: string; amount: string }[];
  }>(
    await tx.execute(sql`
      with recursive
      ${datedEntries(orgId, storeId)},
      l as (
        select jl.store_id, a.code, jl.party_type, jl.party_id, jl.debit, jl.credit,
               d.entry_date as own_date, d.eff_date, d.source_type, d.source_id, d.root_src
        from journal_lines jl
        join dated d on d.id = jl.entry_id
        join accounts a on a.id = jl.account_id
        where jl.store_id = ${storeId}::uuid or jl.store_id is null
      ),
      staff as (
        select distinct gl_account_code as code from money_accounts
        where org_id = ${orgId}::uuid and store_id = ${storeId}::uuid and custodian = 'staff'
      ),
      catc as (
        select distinct account_code as code from expense_categories
        where org_id = ${orgId}::uuid and account_code is not null and account_code not in (${inv})
      ),
      u as (
        -- cash and bank: money (11xx) codes of this store except the staff custodian's, the entry's own date.
        select 'cash_bank'::text as kind, l.store_id, l.code as gl,
               case when l.party_type = 'money_account' then l.party_type end as ptype,
               case when l.party_type = 'money_account' then l.party_id end as pid,
               null::uuid as cat, l.own_date as day, l.debit, l.credit
        from l
        where l.store_id = ${storeId}::uuid and l.code ~ '^11[0-9]{2}$' and l.code not in (select code from staff)
          and l.own_date between ${weekStart}::date and ${through}::date
        union all
        -- staff cash: the staff custodian's code; employee lines are summed per store, any other party stays under itself.
        select 'staff_cash', l.store_id, l.code, l.party_type,
               case when l.party_type = 'employee' then null else l.party_id end,
               null::uuid, l.own_date, l.debit, l.credit
        from l
        where l.store_id = ${storeId}::uuid and l.code in (select code from staff)
          and l.own_date between ${weekStart}::date and ${through}::date
        union all
        -- sales tender: the tender side of a sale entry, a correction placed on the day it corrects.
        select 'sales_tender', l.store_id, l.code,
               case when l.party_type in ('money_account', 'channel') then l.party_type end,
               case when l.party_type in ('money_account', 'channel') then l.party_id end,
               null::uuid, l.eff_date, l.debit, l.credit
        from l
        where l.store_id = ${storeId}::uuid and l.source_type = 'sale'
          and ((l.code ~ '^11[0-9]{2}$' and l.code not in (select code from staff)) or l.code in ('1220', '1221', '1222'))
          and l.eff_date between ${weekStart}::date and ${through}::date
        union all
        -- credit sales (S4 tender keys): DEBITS to 1210 from entries whose reversal-chain root is an ar_charge, by entry date;
        -- 1210 credits (collections, and a charge's reversal) are excluded.
        select 'sales_tender', l.store_id, l.code, null::text, null::text, null::uuid, l.own_date,
               l.debit, l.credit
        from l
        where l.store_id = ${storeId}::uuid and l.code = '1210' and l.root_src = 'ar_charge'
          and l.debit > 0
          and l.own_date between ${weekStart}::date and ${through}::date
        union all
        -- expense category: lines on a category account; the category is known only from an expense source (ruling 5).
        select 'expense_category', l.store_id, l.code, null::text, null::text,
               (select ec.id from expenses x
                  join expense_categories ec on ec.id = x.category_id and ec.org_id = x.org_id
                 where x.org_id = ${orgId}::uuid and l.source_type = 'expense_payment' and x.id::text = l.source_id
                   and ec.account_code = l.code),
               l.eff_date, l.debit, l.credit
        from l
        where l.store_id = ${storeId}::uuid and l.code in (select code from catc) and l.root_src = 'expense_payment'
          and l.eff_date between ${weekStart}::date and ${through}::date
        union all
        select 'ap_supplier', l.store_id, l.code, l.party_type, l.party_id, null::uuid, l.own_date, l.debit, l.credit
        from l
        where l.store_id = ${storeId}::uuid and l.code in ('2110', '1240')
          and l.own_date between ${weekStart}::date and ${through}::date
        union all
        select 'inventory_basis', l.store_id, l.code, null::text, null::text, null::uuid, l.own_date, l.debit, l.credit
        from l
        where l.store_id = ${storeId}::uuid and l.code in (${inv})
          and l.own_date between ${weekStart}::date and ${through}::date
        union all
        -- the org's lines with no store, on any tie-set account: one line per account (and online / supplier party).
        select 'unassigned_store', null::uuid, l.code,
               case when l.party_type in ('money_account', 'supplier') then l.party_type end,
               case when l.party_type in ('money_account', 'supplier') then l.party_id end,
               null::uuid, l.own_date, l.debit, l.credit
        from l
        where l.store_id is null
          and (l.code ~ '^11[0-9]{2}$' or l.code in ('1210', '1220', '1221', '1222', '2110', '1240', ${inv})
               or (l.code in (select code from catc) and l.root_src = 'expense_payment'))
          and l.own_date between ${weekStart}::date and ${through}::date
      ),
      daily as (
        select kind, store_id, gl, ptype, pid, cat, day, sum(debit) as d, sum(credit) as c
        from u group by kind, store_id, gl, ptype, pid, cat, day
      )
      select kind, store_id, gl as gl_code, ptype as party_type, pid as party_id, cat as category_id,
             sum(d)::text as debit, sum(c)::text as credit,
             sum(case when gl = '2110' then c - d else d - c end)::text as amount,
             jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'amount', (case when gl = '2110' then c - d else d - c end)::text) order by day) as by_day
      from daily
      group by kind, store_id, gl, ptype, pid, cat
      order by kind, gl, ptype, pid, cat
    `),
  );
  const lateRows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      with recursive
      ${datedEntries(orgId, storeId)}
      select d.id from dated d
      where d.unresolved and d.entry_date between ${weekStart}::date and ${through}::date
        and exists (
          select 1 from journal_lines jl join accounts a on a.id = jl.account_id
          where jl.entry_id = d.id and (jl.store_id = ${storeId}::uuid or jl.store_id is null)
            and ((d.source_type = 'sale' and (a.code ~ '^11[0-9]{2}$' or a.code in ('1210', '1220', '1221', '1222')))
                 or (d.root_src = 'expense_payment' and a.code in (select account_code from expense_categories
                               where org_id = ${orgId}::uuid and account_code is not null and account_code not in (${inv}))))
        )
      order by d.entry_date, d.id
    `),
  );
  return {
    lines: rows.map((r) => ({
      kind: r.kind,
      storeId: r.store_id,
      glCode: r.gl_code,
      partyType: r.party_type,
      partyId: r.party_id,
      ...(r.category_id ? { categoryId: r.category_id } : {}),
      debit: r.debit,
      credit: r.credit,
      amount: r.amount,
      byDay: r.by_day,
    })),
    datedLater: lateRows.map((r) => ({ entryId: r.id })),
  };
}
