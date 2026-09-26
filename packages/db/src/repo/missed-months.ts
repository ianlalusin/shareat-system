/**
 * The only place SQL is written for missed-month adjustments. T-345.
 * docs/tasks/345-missed-month-depreciation-adjustment.md §3.1, §3.2.
 *
 * ⛔ This file only reads and inserts the LINK row. The catch-up entry itself is written through
 * `postEntry` (bible §4.3), never here — same discipline as `repo/fixed-assets.ts` and
 * `repo/prepaid.ts`, which read the ledger and never write it.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  missedMonthAdjustments,
  type MissedMonthSchedule,
} from '../../schema/missed-month-adjustments';

export interface MissedMonthLinkRow {
  id: string;
  journalEntryId: string;
}

/** The link row for (subject, belongsToPeriod), if one exists — regardless of whether its entry is
 *  still posted or has since been reversed (the caller reads the entry's own status to tell). */
export async function findLink(
  tx: Tx,
  orgId: string,
  schedule: MissedMonthSchedule,
  subjectId: string,
  belongsToPeriod: string,
): Promise<MissedMonthLinkRow | undefined> {
  const subjectColumn =
    schedule === 'depreciation' ? missedMonthAdjustments.fixedAssetId : missedMonthAdjustments.prepaidItemId;
  const [row] = await tx
    .select({ id: missedMonthAdjustments.id, journalEntryId: missedMonthAdjustments.journalEntryId })
    .from(missedMonthAdjustments)
    .where(
      and(
        eq(missedMonthAdjustments.orgId, orgId),
        eq(subjectColumn, subjectId),
        eq(missedMonthAdjustments.belongsToPeriod, belongsToPeriod),
      ),
    )
    .limit(1);
  return row;
}

export interface InsertLinkInput {
  orgId: string;
  schedule: MissedMonthSchedule;
  fixedAssetId: string | null;
  prepaidItemId: string | null;
  belongsToPeriod: string;
  journalEntryId: string;
  reason: string;
  bookedBy: string;
}

/** ⚠️ Can throw a raw Postgres 23505 (the link's own UNIQUE, on a concurrent booker) or the
 *  migration's guard trigger's P0001 — the caller (`bookMissedMonth`) is what turns either into the
 *  honest "already booked" refusal (R1.6); this function does not catch anything itself. */
export async function insertLink(tx: Tx, input: InsertLinkInput): Promise<{ id: string }> {
  const [row] = await tx.insert(missedMonthAdjustments).values(input).returning({ id: missedMonthAdjustments.id });
  return row!;
}
