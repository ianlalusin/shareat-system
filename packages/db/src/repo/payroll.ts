/**
 * The only place SQL is written for payroll. T-189.
 *
 * ⭐ **`rateInForceOn` is the whole point of this file.** `pay_rates` has no `effective_to`, so
 * "what did this job pay on 14 March" is a query, not a stored fact — the latest row whose
 * `effective_from <= that date`. One fact, nothing to close, nothing to drift.
 */
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { attendanceDays } from '../../schema/attendance-days';
import { employments } from '../../schema/employment';
import { payRates, payRuns, payslips, type PayBasis, type PayRunStatus } from '../../schema/payroll';
import { persons } from '../../schema/persons';
import type { Decimal, Money } from '@shareat/core/money';
import type { SafeInsert } from './numeric-input';

export interface PayRateRow {
  id: string;
  orgId: string;
  employmentId: string;
  basis: PayBasis;
  amount: string;
  effectiveFrom: string;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertPayRate(
  tx: Tx,
  input: Pick<SafeInsert<typeof payRates>, 'orgId' | 'employmentId' | 'basis' | 'effectiveFrom' | 'note' | 'createdBy'> & {
    amount: Money;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(payRates)
    .values({
      orgId: input.orgId,
      employmentId: input.employmentId,
      basis: input.basis,
      amount: input.amount,
      effectiveFrom: input.effectiveFrom,
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .returning({ id: payRates.id });
  return row!;
}

/**
 * ⭐ The rate in force for a job on a date.
 *
 * ⚠️ Returns `null` when the job had no rate yet on that date — a real state, and one the caller
 * must refuse rather than treat as zero. A day paid at ₱0 looks exactly like a day nobody worked.
 */
export async function rateInForceOn(
  tx: Tx,
  orgId: string,
  employmentId: string,
  on: string,
): Promise<PayRateRow | null> {
  const [row] = await tx
    .select()
    .from(payRates)
    .where(
      and(
        eq(payRates.orgId, orgId),
        eq(payRates.employmentId, employmentId),
        lte(payRates.effectiveFrom, on),
      ),
    )
    .orderBy(desc(payRates.effectiveFrom))
    .limit(1);
  return (row as PayRateRow | undefined) ?? null;
}

export async function listPayRates(
  tx: Tx,
  orgId: string,
  employmentId: string,
): Promise<PayRateRow[]> {
  const rows = await tx
    .select()
    .from(payRates)
    .where(and(eq(payRates.orgId, orgId), eq(payRates.employmentId, employmentId)))
    .orderBy(desc(payRates.effectiveFrom));
  return rows as PayRateRow[];
}

// -------------------------------------------------------------------------------------

export interface PayRunRow {
  id: string;
  orgId: string;
  storeId: string;
  periodStart: string;
  periodEnd: string;
  status: PayRunStatus;
  moneyAccountId: string;
  postedAt: Date | null;
  postedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertPayRun(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    periodStart: string;
    periodEnd: string;
    moneyAccountId: string;
    notes?: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(payRuns)
    .values({ ...input, notes: input.notes ?? null })
    .returning({ id: payRuns.id });
  return row!;
}

export async function getPayRun(tx: Tx, orgId: string, id: string): Promise<PayRunRow | null> {
  const [row] = await tx
    .select()
    .from(payRuns)
    .where(and(eq(payRuns.id, id), eq(payRuns.orgId, orgId)))
    .limit(1);
  return (row as PayRunRow | undefined) ?? null;
}

export async function listPayRuns(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string } = {},
): Promise<PayRunRow[]> {
  const rows = await tx
    .select()
    .from(payRuns)
    .where(
      and(eq(payRuns.orgId, orgId), filter.storeId ? eq(payRuns.storeId, filter.storeId) : undefined),
    )
    .orderBy(desc(payRuns.periodEnd));
  return rows as PayRunRow[];
}

/** ⚠️ Guarded in the WHERE, not read-then-write — two posts racing must not both succeed. */
export async function markPayRunPosted(
  tx: Tx,
  orgId: string,
  id: string,
  postedBy: string,
): Promise<boolean> {
  const rows = await tx
    .update(payRuns)
    .set({ status: 'posted', postedAt: new Date(), postedBy })
    .where(and(eq(payRuns.id, id), eq(payRuns.orgId, orgId), eq(payRuns.status, 'draft')))
    .returning({ id: payRuns.id });
  return rows.length > 0;
}

export async function markPayRunVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; reason: string },
): Promise<boolean> {
  const rows = await tx
    .update(payRuns)
    .set({
      status: 'voided',
      voidedAt: new Date(),
      voidedBy: input.voidedBy,
      voidReason: input.reason,
    })
    .where(and(eq(payRuns.id, id), eq(payRuns.orgId, orgId), eq(payRuns.status, 'posted')))
    .returning({ id: payRuns.id });
  return rows.length > 0;
}

// -------------------------------------------------------------------------------------

export interface PayslipRow {
  id: string;
  runId: string;
  employmentId: string;
  personId: string;
  personName: string | null;
  payRateId: string;
  daysWorked: string;
  minutesWorked: number;
  otMinutes: number;
  nightDiffMinutes: number;
  holidayMinutes: number;
  basicPay: string;
  otPay: string;
  nightDiffPay: string;
  holidayPay: string;
  /** T-436: paid leave days, and the year-end / final-pay SIL cash payout. Neither is part of `basicPay`. */
  leavePay: string;
  silConversionPay: string;
  grossPay: string;
  advanceRecovered: string;
  netPay: string;
  journalEntryId: string | null;
}

/**
 * T-371: the write side of a payslip. Every money/day figure is a branded `Decimal` of its column's shape — the caller
 * mints it through `@shareat/core/money`; no unparsed string can reach this insert.
 */
export type PayslipInsert = Pick<
  SafeInsert<typeof payslips>,
  | 'orgId'
  | 'runId'
  | 'employmentId'
  | 'personId'
  | 'payRateId'
  | 'minutesWorked'
  | 'otMinutes'
  | 'nightDiffMinutes'
  | 'holidayMinutes'
  | 'journalEntryId'
> & {
  daysWorked: Decimal<'6,2'>;
  basicPay: Money;
  /** NOT NULL DEFAULT 0 — omit to take the column default (R13). */
  otPay?: Money;
  nightDiffPay?: Money;
  holidayPay?: Money;
  /** T-436 (migration 0205). NOT NULL DEFAULT 0 - omit to take the column default. */
  leavePay?: Money;
  silConversionPay?: Money;
  grossPay: Money;
  advanceRecovered?: Money;
  netPay: Money;
};

export async function insertPayslip(tx: Tx, input: PayslipInsert): Promise<{ id: string }> {
  const [row] = await tx
    .insert(payslips)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      employmentId: input.employmentId,
      personId: input.personId,
      payRateId: input.payRateId,
      daysWorked: input.daysWorked,
      minutesWorked: input.minutesWorked,
      otMinutes: input.otMinutes,
      nightDiffMinutes: input.nightDiffMinutes,
      holidayMinutes: input.holidayMinutes,
      basicPay: input.basicPay,
      otPay: input.otPay,
      nightDiffPay: input.nightDiffPay,
      holidayPay: input.holidayPay,
      leavePay: input.leavePay,
      silConversionPay: input.silConversionPay,
      grossPay: input.grossPay,
      advanceRecovered: input.advanceRecovered,
      netPay: input.netPay,
      journalEntryId: input.journalEntryId,
    })
    .returning({ id: payslips.id });
  return row!;
}

export async function listPayslips(tx: Tx, runId: string): Promise<PayslipRow[]> {
  const rows = await tx
    .select({
      id: payslips.id,
      runId: payslips.runId,
      employmentId: payslips.employmentId,
      personId: payslips.personId,
      personName: persons.displayName,
      payRateId: payslips.payRateId,
      daysWorked: payslips.daysWorked,
      minutesWorked: payslips.minutesWorked,
      otMinutes: payslips.otMinutes,
      nightDiffMinutes: payslips.nightDiffMinutes,
      holidayMinutes: payslips.holidayMinutes,
      basicPay: payslips.basicPay,
      otPay: payslips.otPay,
      nightDiffPay: payslips.nightDiffPay,
      holidayPay: payslips.holidayPay,
      leavePay: payslips.leavePay,
      silConversionPay: payslips.silConversionPay,
      grossPay: payslips.grossPay,
      advanceRecovered: payslips.advanceRecovered,
      netPay: payslips.netPay,
      journalEntryId: payslips.journalEntryId,
    })
    .from(payslips)
    .innerJoin(persons, eq(persons.id, payslips.personId))
    .where(eq(payslips.runId, runId))
    .orderBy(asc(persons.displayName));
  return rows as PayslipRow[];
}

export async function setPayslipEntry(tx: Tx, id: string, entryId: string): Promise<void> {
  await tx.update(payslips).set({ journalEntryId: entryId }).where(eq(payslips.id, id));
}

// -------------------------------------------------------------------------------------

/** One attendance day, reduced to what payroll needs from it. */
export interface PayableDay {
  id: string;
  employmentId: string;
  personId: string;
  shiftDay: string;
  isHalfDay: boolean;
  computedMinutes: number;
  pendingOtMinutes: number;
  nightDiffMinutes: number;
  holidayMinutes: number;
  /** ⭐ Which KIND of holiday, so payroll applies the right configured multiplier. */
  holidayType: 'regular' | 'special_non_working' | 'special_working' | null;
  /**
   * ⛔ **The overtime a manager has APPROVED**, not the overtime worked.
   *
   * `pendingOtMinutes` is what the day recorded; this is what somebody agreed to pay for.
   * `null` means nobody has decided yet — which is NOT the same as a decision of zero, and is why
   * payroll pays nothing rather than everything (DEF-109).
   */
  approvedOtMinutes: number | null;
}

/**
 * The days a run may pay: in period, in this store, payable, and **not already frozen**.
 *
 * ⛔ `needs_review` is excluded here and COUNTED separately by `needsReviewCount` — a run that
 * silently skipped a day nobody had settled would look identical to a run where nobody worked.
 */
export async function payableDays(
  tx: Tx,
  orgId: string,
  input: { storeId: string; from: string; to: string },
): Promise<PayableDay[]> {
  const rows = await tx.execute(sql`
    select d.id::text                  as "id",
           d.employment_id::text       as "employmentId",
           d.person_id::text           as "personId",
           d.shift_day::text           as "shiftDay",
           d.is_half_day               as "isHalfDay",
           d.computed_minutes          as "computedMinutes",
           d.pending_ot_minutes        as "pendingOtMinutes",
           d.night_diff_minutes        as "nightDiffMinutes",
           d.holiday_minutes           as "holidayMinutes",
           d.holiday_type              as "holidayType",
           adj.approved_ot_minutes     as "approvedOtMinutes"
    from attendance_days d
    -- ⭐ The LIVE overtime approval for this day, if a manager has made one. Superseded rows are
    -- excluded: a second decision replaces the first, it does not add to it.
    left join attendance_adjustments adj
      on adj.employment_id = d.employment_id
     and adj.shift_day = d.shift_day
     and adj.kind = 'overtime_approved'
     and adj.superseded_by_adjustment_id is null
    where d.org_id = ${orgId}
      and d.store_id = ${input.storeId}
      and d.shift_day between ${input.from} and ${input.to}
      and d.status in ('computed', 'verified')
      and d.frozen_at is null
    order by d.employment_id, d.shift_day
  `);
  return rows as unknown as PayableDay[];
}

export async function needsReviewCount(
  tx: Tx,
  orgId: string,
  input: { storeId: string; from: string; to: string },
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(attendanceDays)
    .where(
      and(
        eq(attendanceDays.orgId, orgId),
        eq(attendanceDays.storeId, input.storeId),
        eq(attendanceDays.status, 'needs_review'),
        sql`${attendanceDays.shiftDay} between ${input.from} and ${input.to}`,
      ),
    );
  return row?.n ?? 0;
}

/** ⭐ Freezes the days a run paid. The column has waited for this since T-157. */
export async function freezeDays(
  tx: Tx,
  dayIds: string[],
  runId: string,
): Promise<void> {
  if (dayIds.length === 0) return;
  await tx.execute(sql`
    update attendance_days
       set frozen_at = now(), frozen_by_pay_run_id = ${runId}
     where id = any(${sql.raw(`array[${dayIds.map((d) => `'${d}'`).join(',')}]::uuid[]`)})
  `);
}

/** ⚠️ The ONLY place a freeze is lifted — a voided run did not pay, so its days are payable again. */
export async function unfreezeDaysOfRun(tx: Tx, runId: string): Promise<number> {
  const rows = await tx.execute(sql`
    update attendance_days
       set frozen_at = null, frozen_by_pay_run_id = null
     where frozen_by_pay_run_id = ${runId}
    returning id
  `);
  return (rows as unknown as unknown[]).length;
}

/** Employments a run would consider: active, in this store. */
export async function employmentsForStore(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<{ id: string; personId: string; personName: string }[]> {
  const rows = await tx
    .select({
      id: employments.id,
      personId: employments.personId,
      personName: persons.displayName,
    })
    .from(employments)
    .innerJoin(persons, eq(persons.id, employments.personId))
    .where(and(eq(employments.orgId, orgId), eq(employments.storeId, storeId)))
    .orderBy(asc(persons.displayName));
  return rows;
}
