/**
 * The only place SQL is written for 13th-month pay. T-191.
 *
 * ⭐ **`basicPayEarnedInYear` is the whole point of this file.** Everything else here is the same
 * run/payout CRUD shape `payroll.ts` already has for `pay_runs`/`payslips` — this is the one new
 * query, and it is the one that has to get the year boundary and the "posted only" filter right.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { payRuns, payslips } from '../../schema/payroll';
import { persons } from '../../schema/persons';
import {
  thirteenthMonthPayouts,
  thirteenthMonthRuns,
  type ThirteenthMonthRunStatus,
} from '../../schema/thirteenth-month';

/**
 * Total `basic_pay` a job earned in a calendar year, from POSTED regular pay runs only.
 *
 * ⛔ **Voided runs are excluded.** A voided run's basic pay never happened economically — the
 * journal entries were reversed and the days unfrozen, so counting it would pay 13th-month on
 * money that was taken back.
 *
 * ⚠️ Attributed by `period_end` falling in `[year-01-01, year-12-31]` — the year a period is PAID
 * FOR, not the year it happens to be posted in. A period straddling New Year's is rare enough at
 * semi-monthly/monthly cadence that this is the defensible simple answer, not a rounding hack.
 */
export async function basicPayEarnedInYear(
  tx: Tx,
  orgId: string,
  employmentId: string,
  year: number,
): Promise<string> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${payslips.basicPay}), 0)::text` })
    .from(payslips)
    .innerJoin(payRuns, eq(payRuns.id, payslips.runId))
    .where(
      and(
        eq(payslips.orgId, orgId),
        eq(payslips.employmentId, employmentId),
        eq(payRuns.status, 'posted'),
        gte(payRuns.periodEnd, `${year}-01-01`),
        lte(payRuns.periodEnd, `${year}-12-31`),
      ),
    );
  return row?.total ?? '0';
}

// -------------------------------------------------------------------------------------

export interface ThirteenthMonthRunRow {
  id: string;
  orgId: string;
  storeId: string;
  year: number;
  status: ThirteenthMonthRunStatus;
  moneyAccountId: string;
  postedAt: Date | null;
  postedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertThirteenthMonthRun(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    year: number;
    moneyAccountId: string;
    notes?: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(thirteenthMonthRuns)
    .values({ ...input, notes: input.notes ?? null })
    .returning({ id: thirteenthMonthRuns.id });
  return row!;
}

export async function getThirteenthMonthRun(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ThirteenthMonthRunRow | null> {
  const [row] = await tx
    .select()
    .from(thirteenthMonthRuns)
    .where(and(eq(thirteenthMonthRuns.id, id), eq(thirteenthMonthRuns.orgId, orgId)))
    .limit(1);
  return (row as ThirteenthMonthRunRow | undefined) ?? null;
}

export async function listThirteenthMonthRuns(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string } = {},
): Promise<ThirteenthMonthRunRow[]> {
  const rows = await tx
    .select()
    .from(thirteenthMonthRuns)
    .where(
      and(
        eq(thirteenthMonthRuns.orgId, orgId),
        filter.storeId ? eq(thirteenthMonthRuns.storeId, filter.storeId) : undefined,
      ),
    )
    .orderBy(sql`${thirteenthMonthRuns.year} desc`);
  return rows as ThirteenthMonthRunRow[];
}

/** ⚠️ Guarded in the WHERE, not read-then-write — two posts racing must not both succeed. */
export async function markThirteenthMonthRunPosted(
  tx: Tx,
  orgId: string,
  id: string,
  postedBy: string,
): Promise<boolean> {
  const rows = await tx
    .update(thirteenthMonthRuns)
    .set({ status: 'posted', postedAt: new Date(), postedBy })
    .where(
      and(
        eq(thirteenthMonthRuns.id, id),
        eq(thirteenthMonthRuns.orgId, orgId),
        eq(thirteenthMonthRuns.status, 'draft'),
      ),
    )
    .returning({ id: thirteenthMonthRuns.id });
  return rows.length > 0;
}

export async function markThirteenthMonthRunVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; reason: string },
): Promise<boolean> {
  const rows = await tx
    .update(thirteenthMonthRuns)
    .set({
      status: 'voided',
      voidedAt: new Date(),
      voidedBy: input.voidedBy,
      voidReason: input.reason,
    })
    .where(and(eq(thirteenthMonthRuns.id, id), eq(thirteenthMonthRuns.orgId, orgId), eq(thirteenthMonthRuns.status, 'posted')))
    .returning({ id: thirteenthMonthRuns.id });
  return rows.length > 0;
}

// -------------------------------------------------------------------------------------

export interface ThirteenthMonthPayoutRow {
  id: string;
  runId: string;
  employmentId: string;
  personId: string;
  personName: string | null;
  basicPayEarned: string;
  grossPay: string;
  advanceRecovered: string;
  netPay: string;
  journalEntryId: string | null;
}

export async function insertThirteenthMonthPayout(
  tx: Tx,
  input: Omit<ThirteenthMonthPayoutRow, 'id' | 'personName'> & { orgId: string },
): Promise<{ id: string }> {
  const { personName: _drop, ...rest } = { ...input, personName: undefined };
  const [row] = await tx
    .insert(thirteenthMonthPayouts)
    .values(rest as never)
    .returning({ id: thirteenthMonthPayouts.id });
  return row!;
}

export async function listThirteenthMonthPayouts(
  tx: Tx,
  runId: string,
): Promise<ThirteenthMonthPayoutRow[]> {
  const rows = await tx
    .select({
      id: thirteenthMonthPayouts.id,
      runId: thirteenthMonthPayouts.runId,
      employmentId: thirteenthMonthPayouts.employmentId,
      personId: thirteenthMonthPayouts.personId,
      personName: persons.displayName,
      basicPayEarned: thirteenthMonthPayouts.basicPayEarned,
      grossPay: thirteenthMonthPayouts.grossPay,
      advanceRecovered: thirteenthMonthPayouts.advanceRecovered,
      netPay: thirteenthMonthPayouts.netPay,
      journalEntryId: thirteenthMonthPayouts.journalEntryId,
    })
    .from(thirteenthMonthPayouts)
    .innerJoin(persons, eq(persons.id, thirteenthMonthPayouts.personId))
    .where(eq(thirteenthMonthPayouts.runId, runId));
  return rows as ThirteenthMonthPayoutRow[];
}

export async function setThirteenthMonthPayoutEntry(tx: Tx, id: string, entryId: string): Promise<void> {
  await tx.update(thirteenthMonthPayouts).set({ journalEntryId: entryId }).where(eq(thirteenthMonthPayouts.id, id));
}
