/**
 * The monthly drawings close — one owner, one month, agreed and shut. T-127.
 *
 * > **Ian, 2026-08-27:** *"for drawing can we make monthly close for that too, so all drawings
 * > within the cut-off period is reconciled and recorded properly and acknowledge adjustment if any
 * > visible and enforced."*
 *
 * ## ⭐ Why this table stores an amount when nothing else in v2 does
 *
 * "Derived, never maintained" is this project's most-repeated rule, and `acknowledged_amount` looks
 * like a violation of it. It is not, and the difference matters:
 *
 * | | |
 * |---|---|
 * | A **maintained balance** | claims to be the current truth, and drifts from the ledger silently. DEF-044, DEF-072 |
 * | An **attestation** | says *"on this date, this person agreed the figure was X."* It is a historical fact, and it does not change when the ledger does |
 *
 * ⭐ **The stored figure exists precisely SO THAT divergence is visible.** The ledger stays
 * authoritative; this records what somebody signed off. If the two disagree later, that gap is the
 * finding — which is exactly Ian's *"acknowledge adjustment if any, visible and enforced"*. A close
 * that stored nothing could not detect anything.
 *
 * ## ⛔ What "enforced" means here
 *
 * Closing a month **locks it for that owner**: a drawing dated into a closed month is refused, not
 * silently accepted. ⚠️ Without that, a cut-off is a report rather than a control — someone
 * back-dates a withdrawal into an agreed month and the agreed figure quietly stops being true.
 *
 * ⚠️ Deliberately per OWNER, not per store. Two partners reconcile on different days, and blocking
 * one because the other has not signed off would make the control something people route around.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { owners } from './owners';
import { persons } from './persons';
import { stores } from './stores';

export const owner_drawing_closes = pgTable(
  'owner_drawing_closes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),

    /** ⚠️ Always the FIRST of the month — a CHECK enforces it, so a month has exactly one identity
     *  and two closes cannot describe the same period under different dates. */
    periodMonth: date('period_month').notNull(),

    /**
     * ⭐ What the ledger said at the moment of closing, and what the closer agreed to. Compare it
     * against the live sum to detect anything that moved afterwards — see this file's header.
     */
    acknowledgedAmount: numeric('acknowledged_amount', { precision: 14, scale: 2 }).notNull(),

    /**
     * ⚠️ The difference the closer had to explain, if any, and the entry that RECORDED it.
     *
     * ⛔ An adjustment is never a note. If the agreed figure differs from the ledger, the gap is
     * posted — `adjustment_entry_id` is that posting — because *"visible and enforced"* means the
     * books move, not that someone typed a sentence about them.
     */
    adjustmentAmount: numeric('adjustment_amount', { precision: 14, scale: 2 }),
    adjustmentReason: text('adjustment_reason'),
    adjustmentEntryId: uuid('adjustment_entry_id'),

    closedOn: date('closed_on').notNull(),
    closedBy: uuid('closed_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('owner_drawing_closes_org_store_idx').on(t.orgId, t.storeId),
    /** ⛔ One close per owner per month. A second would make "is this month closed?" ambiguous, and
     *  the lock depends on that question having one answer. */
    uniqueIndex('owner_drawing_closes_owner_month_key').on(t.ownerId, t.periodMonth),

    check(
      'owner_drawing_closes_period_is_month_start_check',
      sql`date_trunc('month', ${t.periodMonth}) = ${t.periodMonth}`,
    ),
    check(
      'owner_drawing_closes_acknowledged_not_negative_check',
      sql`${t.acknowledgedAmount} >= 0`,
    ),
    /** ⛔ An adjustment is a three-part fact: an amount, a reason, and the entry that posted it.
     *  Any one of them alone is an assertion nobody can check. */
    check(
      'owner_drawing_closes_adjustment_shape_check',
      sql`(${t.adjustmentAmount} is null and ${t.adjustmentReason} is null and ${t.adjustmentEntryId} is null)
          or (${t.adjustmentAmount} is not null and ${t.adjustmentAmount} <> 0
              and ${t.adjustmentReason} is not null and length(trim(${t.adjustmentReason})) > 0
              and ${t.adjustmentEntryId} is not null)`,
    ),
  ],
);
