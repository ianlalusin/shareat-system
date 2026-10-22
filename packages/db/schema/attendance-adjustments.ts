/**
 * attendance_adjustments — the manager's decisions, as attributed INPUTS. T-158.
 * `docs/tasks/158-attendance-adjustments.md`.
 *
 * ## Why these are rows rather than columns on the day
 *
 * v1 writes the same decisions ONTO the session document — `payrollInMode`, `earlyOutApproved`, the
 * half-day override — beside the computed hours they modify, with a comment insisting they *"NEVER
 * touch rawClockIn / rawClockOut / computedHours."* A convention enforced by a paragraph.
 *
 * As rows, three things follow that v1 cannot do:
 *
 * | | |
 * |---|---|
 * | **Recompute is real** | T-157 re-derives a day from punches + config + adjustments. With the decision living inside the row being recomputed, it would have to survive its own overwrite |
 * | **Attribution is verifiable** | Every adjustment names the `sessions.id` it was made under. v1 takes the acting identity as a **client-supplied parameter** (landmine #17), so *"who approved this"* is currently a value the browser chose |
 * | **A reversal is a row, not an erasure** | Changing a decision supersedes it. *"Who decided what, when, and who changed it"* stays answerable — the question a payroll dispute actually asks |
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { employments } from './employment';
import { organizations } from './organizations';
import { persons } from './persons';
import { sessions } from './sessions';
import { stores } from './stores';

/**
 * The five decisions a manager can make about a day. Each maps to one v1 action.
 *
 * ⭐ `start_anchor` stores the chosen ANCHOR MINUTE, not v1's `'late' | 'next_in'` mode string.
 * v1 re-derives the minute from the mode at every read; storing the decided minute makes the
 * decision self-contained — and T-157's `resolveStartAnchor` already treats an exact allowed start
 * as authoritative, so a stored anchor lands on the `exact` branch by construction rather than
 * being second-guessed by the span.
 */
export const ADJUSTMENT_KINDS = [
  /** The Late / Next-in call — which allowed start the day is paid from. */
  'start_anchor',
  /** "I sent them home early; pay them to the scheduled end." */
  'early_out_approved',
  /** Force a half day on or off when the automatic rule is wrong. */
  'half_day_override',
  /** Signed off as correct. Locks the day for payroll. */
  'verify',
  /** Discarded — duplicate or erroneous. */
  'void',
  /**
   * ⭐ T-189e. How many of the day's PENDING overtime minutes a manager accepts.
   *
   * Ian's model: *"undertime is provisional OT — 5hr is set halfday, 9hr for wholeday, a 7 hour
   * duty is halfday plus provisional 2 hour OT to be approved by manager."*
   *
   * ⛔ Without this, `attendance_days.pendingOtMinutes` had no way to become payable, and T-189
   * paid it unapproved — the exact thing the pending status exists to prevent (DEF-109).
   */
  'overtime_approved',
] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** The two kinds that must say why. A void with no reason cannot be explained to whoever asks. */
export const REASON_REQUIRED_KINDS: readonly AdjustmentKind[] = ['void', 'half_day_override'];

export const attendanceAdjustments = pgTable(
  'attendance_adjustments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),

    /** Adjustments attach to the DAY, not to a punch — they are judgements about a day's shape. */
    shiftDay: date('shift_day').notNull(),

    kind: text('kind', { enum: ADJUSTMENT_KINDS }).notNull(),

    /** `start_anchor` only: minutes from the shift day's 05:00 start. */
    chosenAnchorMinute: integer('chosen_anchor_minute'),
    /** `early_out_approved` only: the minute the paid window ends at. */
    effectiveOutMinute: integer('effective_out_minute'),
    /** `half_day_override` only. */
    isHalfDay: text('is_half_day'),

    /** ⭐ `overtime_approved` only. ⚠️ Not the overtime WORKED — the day records that. This is what
     *  somebody agreed to PAY for, which may be less. ⛔ Zero is a real decision ("I approved none
     *  of it") and is not the same as never having decided. */
    approvedOtMinutes: integer('approved_ot_minutes'),

    reason: text('reason'),

    /**
     * ⛔ From `resolveActor`, **never a parameter** (§7.1). This is what makes every other control
     * in this file worth anything: without a verified session, "who approved this" is a value the
     * caller chose.
     */
    decidedBySessionId: uuid('decided_by_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    /** Denormalised from the session ON PURPOSE: it is who decided, and it must not move if the
     *  session is later revoked or expires. */
    decidedByPersonId: uuid('decided_by_person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    supersededByAdjustmentId: uuid('superseded_by_adjustment_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** ⛔ ONE live decision of each kind per day. A change supersedes; it never duplicates. */
    uniqueIndex('attendance_adjustments_live_unique')
      .on(t.employmentId, t.shiftDay, t.kind)
      .where(sql`${t.supersededByAdjustmentId} is null`),

    index('attendance_adjustments_employment_day_idx').on(t.employmentId, t.shiftDay),
    index('attendance_adjustments_store_day_idx').on(t.storeId, t.shiftDay),

    check('attendance_adjustments_kind_check', sql`${t.kind} in ('start_anchor','early_out_approved','half_day_override','verify','void')`),
    check(
      'attendance_adjustments_reason_required_check',
      sql`${t.kind} not in ('void','half_day_override') or ${t.reason} is not null`,
    ),
    /** Each kind's payload shape, held by the database rather than hoped for in a service. */
    check(
      'attendance_adjustments_payload_shape_check',
      sql`
        (${t.kind} = 'start_anchor' and ${t.chosenAnchorMinute} is not null
           and ${t.effectiveOutMinute} is null and ${t.isHalfDay} is null)
        or (${t.kind} = 'early_out_approved' and ${t.effectiveOutMinute} is not null
           and ${t.chosenAnchorMinute} is null and ${t.isHalfDay} is null)
        or (${t.kind} = 'half_day_override' and ${t.isHalfDay} in ('true','false')
           and ${t.chosenAnchorMinute} is null and ${t.effectiveOutMinute} is null)
        or (${t.kind} in ('verify','void') and ${t.chosenAnchorMinute} is null
           and ${t.effectiveOutMinute} is null and ${t.isHalfDay} is null)
      `,
    ),
    check('attendance_adjustments_no_self_supersede_check', sql`${t.supersededByAdjustmentId} is null or ${t.supersededByAdjustmentId} <> ${t.id}`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.decidedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'attendance_adjustments_decided_by_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'attendance_adjustments_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `employment_id` FK (RLS checks only this row's org_id); references `employments_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.employmentId],
      foreignColumns: [employments.orgId, employments.id],
      name: 'attendance_adjustments_employment_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `superseded_by_adjustment_id` FK (RLS checks only this row's org_id); references `attendance_adjustments_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.supersededByAdjustmentId],
      foreignColumns: [t.orgId, t.id],
      name: 'attendance_adjustments_superseded_by_adjustment_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: attendance_adjustments_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0213 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES attendance_adjustments (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);
