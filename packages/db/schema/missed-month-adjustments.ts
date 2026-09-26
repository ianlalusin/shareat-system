/**
 * missed_month_adjustments — T-345. docs/tasks/345-missed-month-depreciation-adjustment.md §3.1.
 *
 * The target-period record bible row 103 asks for, scoped to scheduled charges: a link between a
 * catch-up journal entry (dated in an open month, memo `[prior period]`) and the missed month P it
 * counts as booked for. Existence of a row is the whole signal — `findings/index.ts`'s §3.3 filter
 * and the asset/prepaid "posted periods" readers all key off the entry's OWN idempotency key
 * (`asset:{id}:depreciation:{P}` / `prepaid:{id}:amortisation:{P}`), so this table exists only to
 * answer "which month did this catch-up entry count as" for a human reading the register — the
 * accounting effect never depends on this table existing.
 *
 * ⛔ **The amount is NOT enforced here.** The schedule (`packages/domain/src/fixed-assets/schedule.ts`,
 * `prepaidSchedule`) is pure TypeScript by design (bible §15.11's "the database enforces the rules"
 * is about balance/period/immutability, not a business schedule) — `bookMissedMonth` derives the
 * amount and the domain tests pin it (A1, A6). This is the one gap in "the DB enforces the rules"
 * for this feature, stated here rather than left implicit.
 *
 * NOTE: three triggers hand-added in migration 0161 (drizzle cannot express any of them):
 *   1. `missed_month_adjustments_guard`, BEFORE INSERT — the linked entry is posted, same org,
 *      `source_type = schedule`, `source_id = the subject`; its idempotency key names this exact
 *      (subject, belongs_to_period); it is dated in a LATER month than `belongs_to_period`; no
 *      `open` fiscal period covers `belongs_to_period`'s calendar month; the entry has exactly two
 *      lines, on the pattern's accounts (6700/1590 or 6750/1400); `belongs_to_period` is not before
 *      the org's earliest fiscal period (Amendment R3.1 — an org with none refuses outright). See
 *      the migration for the body.
 *   2. `missed_month_adjustments_no_update`, BEFORE UPDATE — refuses every UPDATE unconditionally
 *      (rows are immutable once written).
 *   3. `missed_month_adjustments_no_direct_delete`, BEFORE DELETE — refuses a direct DELETE
 *      (`pg_trigger_depth() = 1`) but allows the cascade from deleting the journal entry it links
 *      to (`pg_trigger_depth() > 1`). ⚠️ **That is NOT the 2027 cutover purge** — a POSTED entry can
 *      never be deleted at all (migration 0005's own posted-immutability trigger refuses it
 *      unconditionally), and the purge itself TRUNCATEs, which fires no row trigger. It is the one
 *      row-level delete a journal entry here CAN undergo: a REVERSED catch-up entry being deleted
 *      cascades to this row via the FK, and that cascade must not read as a "direct" DELETE.
 */
import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { fixedAssets } from './fixed-assets';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { prepaidItems } from './prepaid';

/** Equal to `journal_entries.source_type`'s two scheduled-charge values (spec §3.1). */
export const MISSED_MONTH_SCHEDULES = ['depreciation', 'amortisation'] as const;
export type MissedMonthSchedule = (typeof MISSED_MONTH_SCHEDULES)[number];

export const missedMonthAdjustments = pgTable(
  'missed_month_adjustments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    schedule: text('schedule', { enum: MISSED_MONTH_SCHEDULES }).notNull(),
    /** Exactly one of these two is set — enforced by `missed_month_adjustments_subject_shape_check`
     *  below, matching `schedule`. */
    fixedAssetId: uuid('fixed_asset_id').references(() => fixedAssets.id, { onDelete: 'restrict' }),
    prepaidItemId: uuid('prepaid_item_id').references(() => prepaidItems.id, { onDelete: 'restrict' }),
    /** `YYYY-MM` — the month this adjustment counts as booked for. */
    belongsToPeriod: text('belongs_to_period').notNull(),
    /** ON DELETE CASCADE — `period_overrides`' own lineage off `journal_entries`: the property
     *  that makes "a link with no entry" structurally unrepresentable. This table is ALSO
     *  classified `purge` for the 2027 cutover, but that purge TRUNCATEs (no row-level DELETE, so
     *  this FK never fires for it) — see the guard trigger's own NOTE above for what the CASCADE
     *  actually serves. */
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .unique()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    bookedBy: uuid('booked_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One per subject per month. NULLs are distinct in a unique index, so each covers only its own
    // kind — an asset row and a prepaid row can share a `belongs_to_period` freely.
    uniqueIndex('missed_month_adjustments_org_asset_period_unique').on(t.orgId, t.fixedAssetId, t.belongsToPeriod),
    uniqueIndex('missed_month_adjustments_org_prepaid_period_unique').on(t.orgId, t.prepaidItemId, t.belongsToPeriod),

    check('missed_month_adjustments_schedule_check', sql`${t.schedule} in ('depreciation', 'amortisation')`),
    check(
      'missed_month_adjustments_subject_shape_check',
      sql`(${t.schedule} = 'depreciation') = (${t.fixedAssetId} is not null) and (${t.schedule} = 'amortisation') = (${t.prepaidItemId} is not null)`,
    ),
    check('missed_month_adjustments_belongs_to_period_check', sql`${t.belongsToPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('missed_month_adjustments_reason_not_blank_check', sql`btrim(${t.reason}) <> ''`),
  ],
);
