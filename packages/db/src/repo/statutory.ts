/**
 * The only place SQL is written for the statutory tables and the month-to-date totals. T-190.
 *
 * ⛔ Every lookup is AS OF a date (the run's `period_end`), never "today" and never "the newest row": a row takes effect on its
 * `effective_from` and the one in force is the latest row at or before the date. The rows are immutable (migration 0206).
 */
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { minimumWages, statutoryRates, withholdingBrackets } from '../../schema/statutory';
import type { StatutoryAgency, WithholdingFrequency } from '../../schema/statutory';
import { persons } from '../../schema/persons';
import type { Decimal, Money } from '@shareat/core/money';
import type { SafeInsert } from './numeric-input';

export interface StatutoryRateRow {
  id: string;
  orgId: string;
  agency: StatutoryAgency;
  effectiveFrom: string;
  eeRate: string;
  erRate: string;
  baseKind: 'gross' | 'basic';
  floor: string | null;
  ceiling: string | null;
  step: string | null;
  lowThreshold: string | null;
  lowEeRate: string | null;
  ecThreshold: string | null;
  ecLow: string | null;
  ecHigh: string | null;
  sourceRef: string;
  confirmedAt: Date | null;
  confirmedBy: string | null;
}

export type StatutoryRateInsert = Pick<
  SafeInsert<typeof statutoryRates>,
  'orgId' | 'agency' | 'effectiveFrom' | 'baseKind' | 'sourceRef'
> & {
  eeRate: Decimal<'14,4'>;
  erRate: Decimal<'14,4'>;
  floor?: Money | null;
  ceiling?: Money | null;
  step?: Money | null;
  lowThreshold?: Money | null;
  lowEeRate?: Decimal<'14,4'> | null;
  ecThreshold?: Money | null;
  ecLow?: Money | null;
  ecHigh?: Money | null;
};

export async function insertRate(tx: Tx, input: StatutoryRateInsert): Promise<{ id: string }> {
  const [row] = await tx
    .insert(statutoryRates)
    .values({
      orgId: input.orgId,
      agency: input.agency,
      effectiveFrom: input.effectiveFrom,
      eeRate: input.eeRate,
      erRate: input.erRate,
      baseKind: input.baseKind,
      floor: input.floor ?? null,
      ceiling: input.ceiling ?? null,
      step: input.step ?? null,
      lowThreshold: input.lowThreshold ?? null,
      lowEeRate: input.lowEeRate ?? null,
      ecThreshold: input.ecThreshold ?? null,
      ecLow: input.ecLow ?? null,
      ecHigh: input.ecHigh ?? null,
      sourceRef: input.sourceRef,
    })
    .returning({ id: statutoryRates.id });
  return row!;
}

export async function getRate(tx: Tx, orgId: string, id: string): Promise<StatutoryRateRow | null> {
  const [row] = await tx
    .select()
    .from(statutoryRates)
    .where(and(eq(statutoryRates.id, id), eq(statutoryRates.orgId, orgId)))
    .limit(1);
  return (row as StatutoryRateRow | undefined) ?? null;
}

/** The first confirmation only (the trigger refuses a second). Guarded in the WHERE so a race cannot confirm twice. */
export async function confirmRate(tx: Tx, orgId: string, id: string, by: string): Promise<boolean> {
  const rows = await tx
    .update(statutoryRates)
    .set({ confirmedAt: new Date(), confirmedBy: by })
    .where(and(eq(statutoryRates.id, id), eq(statutoryRates.orgId, orgId), isNull(statutoryRates.confirmedAt)))
    .returning({ id: statutoryRates.id });
  return rows.length > 0;
}

/** An unconfirmed row only; a confirmed one is refused by the trigger and a used one by the payslip FK. */
export async function deleteUnconfirmedRate(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(statutoryRates)
    .where(and(eq(statutoryRates.id, id), eq(statutoryRates.orgId, orgId), isNull(statutoryRates.confirmedAt)))
    .returning({ id: statutoryRates.id });
  return rows.length > 0;
}

export async function listRates(tx: Tx, orgId: string): Promise<StatutoryRateRow[]> {
  const rows = await tx
    .select()
    .from(statutoryRates)
    .where(eq(statutoryRates.orgId, orgId))
    .orderBy(asc(statutoryRates.agency), desc(statutoryRates.effectiveFrom));
  return rows as StatutoryRateRow[];
}

/** ⭐ The contribution row in force for an agency on a date: the latest row at or before it. `null` when none exists yet. */
export async function rateInForceOn(
  tx: Tx,
  orgId: string,
  agency: StatutoryAgency,
  on: string,
): Promise<StatutoryRateRow | null> {
  const [row] = await tx
    .select()
    .from(statutoryRates)
    .where(and(eq(statutoryRates.orgId, orgId), eq(statutoryRates.agency, agency), lte(statutoryRates.effectiveFrom, on)))
    .orderBy(desc(statutoryRates.effectiveFrom))
    .limit(1);
  return (row as StatutoryRateRow | undefined) ?? null;
}

export interface BracketSet {
  effectiveFrom: string;
  rows: { over: string; baseTax: string; rate: string }[];
  /** Every row of the set is confirmed. */
  confirmed: boolean;
}

/** ⭐ The bracket SET in force for a pay frequency on a date: every row sharing the latest `effective_from` at or before it. */
export async function bracketSetInForceOn(
  tx: Tx,
  orgId: string,
  frequency: WithholdingFrequency,
  on: string,
): Promise<BracketSet | null> {
  const [latest] = await tx
    .select({ effectiveFrom: withholdingBrackets.effectiveFrom })
    .from(withholdingBrackets)
    .where(
      and(
        eq(withholdingBrackets.orgId, orgId),
        eq(withholdingBrackets.frequency, frequency),
        lte(withholdingBrackets.effectiveFrom, on),
      ),
    )
    .orderBy(desc(withholdingBrackets.effectiveFrom))
    .limit(1);
  if (!latest) return null;
  const rows = await tx
    .select({
      over: withholdingBrackets.over,
      baseTax: withholdingBrackets.baseTax,
      rate: withholdingBrackets.rate,
      confirmedAt: withholdingBrackets.confirmedAt,
    })
    .from(withholdingBrackets)
    .where(
      and(
        eq(withholdingBrackets.orgId, orgId),
        eq(withholdingBrackets.frequency, frequency),
        eq(withholdingBrackets.effectiveFrom, latest.effectiveFrom),
      ),
    )
    .orderBy(asc(withholdingBrackets.over));
  return {
    effectiveFrom: latest.effectiveFrom,
    rows: rows.map((r) => ({ over: r.over, baseTax: r.baseTax, rate: r.rate })),
    confirmed: rows.length > 0 && rows.every((r) => r.confirmedAt !== null),
  };
}

export interface MinimumWageRow {
  id: string;
  dailyRate: string;
  effectiveFrom: string;
  confirmedAt: Date | null;
}

/** ⭐ The store's minimum daily wage in force on a date. `null` when the store has none. */
export async function minimumWageInForceOn(
  tx: Tx,
  orgId: string,
  storeId: string,
  on: string,
): Promise<MinimumWageRow | null> {
  const [row] = await tx
    .select({
      id: minimumWages.id,
      dailyRate: minimumWages.dailyRate,
      effectiveFrom: minimumWages.effectiveFrom,
      confirmedAt: minimumWages.confirmedAt,
    })
    .from(minimumWages)
    .where(and(eq(minimumWages.orgId, orgId), eq(minimumWages.storeId, storeId), lte(minimumWages.effectiveFrom, on)))
    .orderBy(desc(minimumWages.effectiveFrom))
    .limit(1);
  return row ?? null;
}

export async function insertBrackets(
  tx: Tx,
  orgId: string,
  frequency: WithholdingFrequency,
  effectiveFrom: string,
  rows: { over: Money; baseTax: Money; rate: Decimal<'14,4'> }[],
  sourceRef: string,
): Promise<string[]> {
  const out = await tx
    .insert(withholdingBrackets)
    .values(rows.map((r) => ({ orgId, frequency, effectiveFrom, over: r.over, baseTax: r.baseTax, rate: r.rate, sourceRef })))
    .returning({ id: withholdingBrackets.id, over: withholdingBrackets.over });
  return out.sort((a, b) => Number(a.over) - Number(b.over)).map((r) => r.id);
}

/** Confirms the still-unconfirmed rows of one set. */
export async function confirmBrackets(
  tx: Tx,
  orgId: string,
  frequency: WithholdingFrequency,
  effectiveFrom: string,
  by: string,
): Promise<string[]> {
  const rows = await tx
    .update(withholdingBrackets)
    .set({ confirmedAt: new Date(), confirmedBy: by })
    .where(
      and(
        eq(withholdingBrackets.orgId, orgId),
        eq(withholdingBrackets.frequency, frequency),
        eq(withholdingBrackets.effectiveFrom, effectiveFrom),
        isNull(withholdingBrackets.confirmedAt),
      ),
    )
    .returning({ id: withholdingBrackets.id });
  return rows.map((r) => r.id);
}

export async function insertMinimumWage(
  tx: Tx,
  input: { orgId: string; storeId: string; effectiveFrom: string; dailyRate: Money; wageOrderRef: string },
): Promise<{ id: string }> {
  const [row] = await tx.insert(minimumWages).values(input).returning({ id: minimumWages.id });
  return row!;
}

export async function confirmMinimumWage(tx: Tx, orgId: string, id: string, by: string): Promise<boolean> {
  const rows = await tx
    .update(minimumWages)
    .set({ confirmedAt: new Date(), confirmedBy: by })
    .where(and(eq(minimumWages.id, id), eq(minimumWages.orgId, orgId), isNull(minimumWages.confirmedAt)))
    .returning({ id: minimumWages.id });
  return rows.length > 0;
}

export interface BracketSetSummary {
  frequency: WithholdingFrequency;
  effectiveFrom: string;
  rows: number;
  unconfirmed: number;
  sourceRef: string;
}

/** One line per bracket SET (frequency + date), newest first, for the rates screen. */
export async function listBracketSets(tx: Tx, orgId: string): Promise<BracketSetSummary[]> {
  const rows = (await tx.execute(sql`
    select frequency, effective_from::text as "effectiveFrom", count(*)::int as "rows",
           count(*) filter (where confirmed_at is null)::int as "unconfirmed", min(source_ref) as "sourceRef"
    from withholding_brackets where org_id = ${orgId}
    group by frequency, effective_from order by frequency, effective_from desc
  `)) as unknown as BracketSetSummary[];
  return rows;
}

export interface MinimumWageListRow {
  id: string;
  storeId: string;
  storeName: string;
  effectiveFrom: string;
  dailyRate: string;
  wageOrderRef: string;
  confirmedAt: Date | null;
}

export async function listMinimumWages(tx: Tx, orgId: string): Promise<MinimumWageListRow[]> {
  const rows = (await tx.execute(sql`
    select m.id::text as "id", m.store_id::text as "storeId", s.name as "storeName", m.effective_from::text as "effectiveFrom",
           m.daily_rate::text as "dailyRate", m.wage_order_ref as "wageOrderRef", m.confirmed_at as "confirmedAt"
    from minimum_wages m join stores s on s.id = m.store_id
    where m.org_id = ${orgId} order by s.name, m.effective_from desc
  `)) as unknown as MinimumWageListRow[];
  return rows;
}

// -------------------------------------------------------------------------------------

export interface MonthToDateRow {
  agency: StatutoryAgency;
  base: string;
  ee: string;
  er: string;
  ec: string;
}

/**
 * ⭐ What a PERSON's earlier payslips of the calendar month of `periodEnd` already deducted, per agency.
 *
 * Counts only POSTED, non-voided payslips (a voided run's status is `voided`) of the person in the org - across employments and
 * stores: two jobs are one contributor - and only those where the agency WAS deducted (the rate id is set). The base is the one the
 * payslip's own rate row names (`gross` or `basic`). A payslip posted before T-190 has no rate id and counts for nothing.
 */
export async function monthToDate(tx: Tx, orgId: string, personId: string, periodEnd: string): Promise<MonthToDateRow[]> {
  const rows = (await tx.execute(sql`
    select a.agency                                                                        as "agency",
           coalesce(sum(case r.base_kind when 'gross' then p.gross_pay else p.basic_pay end), 0)::text as "base",
           coalesce(sum(case a.agency when 'sss' then p.sss_ee when 'philhealth' then p.philhealth_ee else p.pagibig_ee end), 0)::text as "ee",
           coalesce(sum(case a.agency when 'sss' then p.sss_er when 'philhealth' then p.philhealth_er else p.pagibig_er end), 0)::text as "er",
           coalesce(sum(case a.agency when 'sss' then p.sss_ec else 0 end), 0)::text         as "ec"
    from payslips p
    join pay_runs pr on pr.id = p.run_id
    cross join (values ('sss'), ('philhealth'), ('pagibig')) as a(agency)
    join statutory_rates r
      on r.id = case a.agency when 'sss' then p.sss_rate_id when 'philhealth' then p.philhealth_rate_id else p.pagibig_rate_id end
    where p.org_id = ${orgId}
      and p.person_id = ${personId}
      and pr.status = 'posted'
      and date_trunc('month', pr.period_end) = date_trunc('month', ${periodEnd}::date)
      and not (a.agency = any(p.skipped_agencies))
    group by a.agency
  `)) as unknown as MonthToDateRow[];
  return rows;
}

/** ⭐ Locks the people's rows, in id order, so a post and a void for the same person run one after the other. */
export async function lockPersons(tx: Tx, orgId: string, personIds: string[]): Promise<void> {
  const ids = [...new Set(personIds)].sort();
  if (ids.length === 0) return;
  await tx
    .select({ id: persons.id })
    .from(persons)
    .where(and(eq(persons.orgId, orgId), inArray(persons.id, ids)))
    .orderBy(asc(persons.id))
    .for('update');
}

export interface GovernmentIdsRow {
  personId: string;
  sssNo: string | null;
  philhealthNo: string | null;
  pagibigNo: string | null;
  tin: string | null;
}

/** ⚠️ Personal data. Called only behind `run_payroll` (payroll) or `enrol_staff` (the staff page). */
export async function governmentIdsFor(tx: Tx, orgId: string, personIds: string[]): Promise<GovernmentIdsRow[]> {
  if (personIds.length === 0) return [];
  return tx
    .select({
      personId: persons.id,
      sssNo: persons.sssNo,
      philhealthNo: persons.philhealthNo,
      pagibigNo: persons.pagibigNo,
      tin: persons.tin,
    })
    .from(persons)
    .where(and(eq(persons.orgId, orgId), inArray(persons.id, personIds)));
}

export async function setGovernmentIds(
  tx: Tx,
  orgId: string,
  personId: string,
  ids: { sssNo: string | null; philhealthNo: string | null; pagibigNo: string | null; tin: string | null },
): Promise<boolean> {
  const rows = await tx
    .update(persons)
    .set({ sssNo: ids.sssNo, philhealthNo: ids.philhealthNo, pagibigNo: ids.pagibigNo, tin: ids.tin, updatedAt: new Date() })
    .where(and(eq(persons.id, personId), eq(persons.orgId, orgId)))
    .returning({ id: persons.id });
  return rows.length > 0;
}
