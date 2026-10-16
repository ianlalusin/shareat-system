/**
 * The only place SQL is written for separations. T-192.
 *
 * ⭐ ONE insert, not insert-draft-then-update-posted. `pay_runs`/`payslips` split identifying data
 * from computed data across two tables because a run pays MANY employments; a separation is
 * already one row per employment, so there is nothing a second phase would add — `postSeparation`
 * commits the whole row atomically, the same way `postPayRun` commits a whole run's worth of
 * payslips inside one transaction.
 */
import { and, desc, eq, notExists, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { employments } from '../../schema/employment';
import { persons } from '../../schema/persons';
import { separations, type SeparationCause, type SeparationStatus } from '../../schema/separations';
import type { Money } from '@shareat/core/money';

export interface SeparationRow {
  id: string;
  orgId: string;
  storeId: string;
  employmentId: string;
  personId: string;
  personName: string | null;
  separationDate: string;
  cause: SeparationCause;
  thirteenthMonthBasicPayEarned: string;
  thirteenthMonthGross: string;
  separationPayAmount: string;
  advanceRecovered: string;
  netPay: string;
  clearanceConfirmedAt: Date | null;
  clearanceConfirmedBy: string | null;
  clearanceNotes: string | null;
  status: SeparationStatus;
  moneyAccountId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  journalEntryId: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertPostedSeparation(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    employmentId: string;
    personId: string;
    separationDate: string;
    cause: SeparationCause;
    moneyAccountId: string;
    clearanceConfirmedBy: string;
    clearanceNotes: string | null;
    notes: string | null;
    createdBy: string;
    /** Each NOT NULL DEFAULT 0 — omit to take the column default (R13). */
    thirteenthMonthBasicPayEarned?: Money;
    thirteenthMonthGross?: Money;
    separationPayAmount?: Money;
    advanceRecovered?: Money;
    netPay?: Money;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(separations)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      employmentId: input.employmentId,
      personId: input.personId,
      separationDate: input.separationDate,
      cause: input.cause,
      thirteenthMonthBasicPayEarned: input.thirteenthMonthBasicPayEarned,
      thirteenthMonthGross: input.thirteenthMonthGross,
      separationPayAmount: input.separationPayAmount,
      advanceRecovered: input.advanceRecovered,
      netPay: input.netPay,
      moneyAccountId: input.moneyAccountId,
      clearanceConfirmedBy: input.clearanceConfirmedBy,
      clearanceNotes: input.clearanceNotes,
      notes: input.notes,
      createdBy: input.createdBy,
      status: 'posted',
      postedAt: new Date(),
      postedBy: input.createdBy,
      clearanceConfirmedAt: new Date(),
    })
    .returning({ id: separations.id });
  return row!;
}

/** ⚠️ The MOST RECENT row, not just any row — an employment can carry a voided attempt followed
 *  by a posted correction (the unique index is `WHERE status = 'posted'`, so both can coexist),
 *  and it is the latest one that answers "is this employment currently separated." */
export async function getSeparationByEmployment(
  tx: Tx,
  orgId: string,
  employmentId: string,
): Promise<SeparationRow | null> {
  const [row] = await tx
    .select()
    .from(separations)
    .where(and(eq(separations.orgId, orgId), eq(separations.employmentId, employmentId)))
    .orderBy(desc(separations.createdAt))
    .limit(1);
  return (row as unknown as SeparationRow | undefined) ?? null; // `as unknown`: apps/pos typechecks this file without noUncheckedIndexedAccess (T-424)
}

export async function getSeparation(tx: Tx, orgId: string, id: string): Promise<SeparationRow | null> {
  const [row] = await tx
    .select()
    .from(separations)
    .where(and(eq(separations.id, id), eq(separations.orgId, orgId)))
    .limit(1);
  return (row as unknown as SeparationRow | undefined) ?? null; // `as unknown`: apps/pos typechecks this file without noUncheckedIndexedAccess (T-424)
}

export async function listSeparations(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string } = {},
): Promise<SeparationRow[]> {
  const rows = await tx
    .select({
      id: separations.id,
      orgId: separations.orgId,
      storeId: separations.storeId,
      employmentId: separations.employmentId,
      personId: separations.personId,
      personName: persons.displayName,
      separationDate: separations.separationDate,
      cause: separations.cause,
      thirteenthMonthBasicPayEarned: separations.thirteenthMonthBasicPayEarned,
      thirteenthMonthGross: separations.thirteenthMonthGross,
      separationPayAmount: separations.separationPayAmount,
      advanceRecovered: separations.advanceRecovered,
      netPay: separations.netPay,
      clearanceConfirmedAt: separations.clearanceConfirmedAt,
      clearanceConfirmedBy: separations.clearanceConfirmedBy,
      clearanceNotes: separations.clearanceNotes,
      status: separations.status,
      moneyAccountId: separations.moneyAccountId,
      postedAt: separations.postedAt,
      postedBy: separations.postedBy,
      voidedAt: separations.voidedAt,
      voidReason: separations.voidReason,
      journalEntryId: separations.journalEntryId,
      notes: separations.notes,
      createdBy: separations.createdBy,
      createdAt: separations.createdAt,
    })
    .from(separations)
    .innerJoin(persons, eq(persons.id, separations.personId))
    .where(
      and(eq(separations.orgId, orgId), filter.storeId ? eq(separations.storeId, filter.storeId) : undefined),
    );
  return rows as SeparationRow[];
}

/** Ended employments (`resigned` or `terminated`) at a store with no POSTED `separations` row
 *  yet — the worklist `/payroll/separations` renders. ⚠️ `notExists`, not a LEFT JOIN + `isNull`:
 *  a voided-then-not-yet-reposted employment can carry a row without being "currently separated",
 *  and a LEFT JOIN cannot express that once more than one historical row is possible per
 *  employment (see `separations_employment_posted_unique`). */
export async function endedEmploymentsWithoutSeparation(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<{ employmentId: string; personId: string; personName: string; endedOn: string | null; employmentStatus: string }[]> {
  const rows = await tx
    .select({
      employmentId: employments.id,
      personId: employments.personId,
      personName: persons.displayName,
      endedOn: employments.endedOn,
      employmentStatus: employments.employmentStatus,
    })
    .from(employments)
    .innerJoin(persons, eq(persons.id, employments.personId))
    .where(
      and(
        eq(employments.orgId, orgId),
        eq(employments.storeId, storeId),
        sql`${employments.employmentStatus} in ('resigned', 'terminated')`,
        notExists(
          tx
            .select({ id: separations.id })
            .from(separations)
            .where(and(eq(separations.employmentId, employments.id), eq(separations.status, 'posted'))),
        ),
      ),
    );
  return rows;
}

export async function setSeparationEntry(tx: Tx, id: string, entryId: string): Promise<void> {
  await tx.update(separations).set({ journalEntryId: entryId }).where(eq(separations.id, id));
}

export async function markSeparationVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; reason: string },
): Promise<boolean> {
  const rows = await tx
    .update(separations)
    .set({
      status: 'voided',
      voidedAt: new Date(),
      voidedBy: input.voidedBy,
      voidReason: input.reason,
    })
    .where(and(eq(separations.id, id), eq(separations.orgId, orgId), eq(separations.status, 'posted')))
    .returning({ id: separations.id });
  return rows.length > 0;
}
