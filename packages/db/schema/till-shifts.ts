/**
 * Till custody — the shift, and what was physically counted. T-186.
 * `docs/tasks/186-till-custody-shift.md`.
 *
 * ## ⭐ What this table exists to make TRUE
 *
 * `remittance_variances` (T-143) already rests on a sentence that was **false until this shipped**:
 *
 * > *"Once the till is counted daily and signed, a batch shortage **cannot** be a counting error —
 * > the counts already reconciled."*
 *
 * There was nowhere to record a count, so every batch shortage was ambiguous between a loss and a
 * miscount. This is the record that disambiguates it — and the record that lets a shortage **name a
 * person**, which v1 cannot do: `CashRemitShiftPlain.cashierName` is a *nullable free-text string*.
 *
 * ## ⛔ The grain is TILL × HANDOVER, and it is NOT `attendance_days`
 *
 * `attendance_days` is unique on `(employmentId, shiftDay)` — one row per person per 05:00 day. A
 * cashier who works the morning, hands over, and returns in the evening produces **ONE** attendance
 * row and **TWO** custody periods. Keying cash on that row makes the second handover
 * unrepresentable, and a handover that cannot be recorded is exactly the shortage attributed to
 * nobody.
 *
 * ⭐ So `attendanceDayId` is a **reference and nothing more**. This table stores no clock times of
 * its own beyond the custody acts themselves: two tables asserting when the evening cashier took
 * over will drift, and the first symptom is a variance charged to the wrong person.
 *
 * ## ⚠️ Three variances look identical and mean opposite things
 *
 * | Compares | Means | Who answers |
 * |---|---|---|
 * | `tillFloatOffTarget` — **books' float position** vs target | the float was spent down and not put back, correctly posted | ⛔ nobody; the office replenishes |
 * | **this table** — **count** vs ledger | cash that should be in the pocket is not | ⭐ the cashier |
 * | `remittance_variances` — **batch** vs owed | a loss after the counts reconciled | whoever held the pool |
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { attendanceDays } from './attendance-days';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/** ⚠️ `voided` exists because a shift opened by mistake must not be deleted — its counts are
 *  evidence somebody signed for, and evidence is superseded, never erased. */
export const TILL_SHIFT_STATUSES = ['open', 'closed', 'voided'] as const;
export type TillShiftStatus = (typeof TILL_SHIFT_STATUSES)[number];

/** The two moments a till is counted. v1 called them `opening` and `closing`; the count is the
 *  same act either way, which is why they are one table and not two. */
export const COUNT_MOMENTS = ['open', 'close'] as const;
export type CountMoment = (typeof COUNT_MOMENTS)[number];

// -------------------------------------------------------------------------------------

export const tillCustodyShifts = pgTable(
  'till_custody_shifts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** ⭐ The trading date, which is the same key `remittance_allocations` settles against (bible
     *  row 157). Not a timestamp: a shift that runs past midnight still belongs to its trading day. */
    businessDate: date('business_date').notNull(),
    /** 1 = morning, 2 = evening. Ian: *"most is 2 shifts, 1 morning 1 evening, same till."* */
    shiftNo: integer('shift_no').notNull(),

    status: text('status', { enum: TILL_SHIFT_STATUSES }).notNull().default('open'),

    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    /** ⛔ NOT NULL, and that is the entire point of the table. v1's equivalent is
     *  `cashierName: z.string().optional().nullable()` — which is why v1 cannot charge a shortage
     *  to anyone without a human guessing. */
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => persons.id, { onDelete: 'restrict' }),

    /** ⭐ The handover chain — v1's `opening.prevShiftId`, kept because it is the only thing that
     *  says whose custody the cash left. */
    prevShiftId: uuid('prev_shift_id').references((): AnyPgColumn => tillCustodyShifts.id, {
      onDelete: 'restrict',
    }),

    /** ⚠️ A REFERENCE, never a restatement. See the header — this column must never grow a sibling
     *  `shift_started_at` that attendance also knows. */
    attendanceDayId: uuid('attendance_day_id').references(() => attendanceDays.id, {
      onDelete: 'restrict',
    }),

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('till_custody_shifts_store_date_no_unique').on(t.storeId, t.businessDate, t.shiftNo),
    index('till_custody_shifts_org_status_idx').on(t.orgId, t.status),
    index('till_custody_shifts_store_date_idx').on(t.storeId, t.businessDate),

    /** ⛔ **At most one OPEN shift per store.** Two open shifts on one till means two people each
     *  believe they hold the same cash — and the second count would be taken against a balance the
     *  first is still moving. In the database, not only in code: this is the invariant that makes
     *  "who was holding it" answerable at all. */
    uniqueIndex('till_custody_shifts_one_open_per_store')
      .on(t.storeId)
      .where(sql`${t.status} = 'open'`),

    /** ⛔ One shift hands over to at most one successor. A branching chain would let the same cash
     *  be inherited twice, by two people, both of whom could then be charged for it. */
    uniqueIndex('till_custody_shifts_prev_unique').on(t.prevShiftId),

    check('till_custody_shifts_shift_no_check', sql`${t.shiftNo} >= 1`),
    check(
      'till_custody_shifts_status_check',
      sql`${t.status} in ('open', 'closed', 'voided')`,
    ),
    /** A shift is closed exactly when it has both a closing time and a closer. Half a close is how
     *  a shift ends up counted but unattributed. */
    check(
      'till_custody_shifts_close_shape_check',
      sql`(${t.status} = 'open') = (${t.closedAt} is null and ${t.closedBy} is null)`,
    ),
    /** ⛔ A shift cannot hand over to itself. Cheap, and it makes an infinite walk impossible. */
    check('till_custody_shifts_prev_not_self_check', sql`${t.prevShiftId} is distinct from ${t.id}`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.closedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'till_custody_shifts_closed_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.openedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'till_custody_shifts_opened_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'till_custody_shifts_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `attendance_day_id` FK (RLS checks only this row's org_id); references `attendance_days_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.attendanceDayId],
      foreignColumns: [attendanceDays.orgId, attendanceDays.id],
      name: 'till_custody_shifts_attendance_day_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `prev_shift_id` FK (RLS checks only this row's org_id); references `till_custody_shifts_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.prevShiftId],
      foreignColumns: [t.orgId, t.id],
      name: 'till_custody_shifts_prev_shift_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: till_custody_shifts_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0212 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES till_custody_shifts (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);

/**
 * What was physically counted, per money account, per moment.
 *
 * ⭐ **Lines, not two fixed cash columns.** Since T-316 the float is a target on the cashier's
 * cash drawer (`1110`), so a store counts one cash line there; a store that ever grows a second
 * drawer (or a wallet) gets a second money account — not a schema change.
 */
export const tillCountLines = pgTable(
  'till_count_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => tillCustodyShifts.id, { onDelete: 'restrict' }),
    moment: text('moment', { enum: COUNT_MOMENTS }).notNull(),
    moneyAccountId: uuid('money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),

    /** What was in the pocket. ⛔ Never negative — you cannot physically count less than nothing. */
    counted: numeric('counted', { precision: 14, scale: 2 }).notNull(),

    /**
     * What the ledger said at the moment of counting.
     *
     * ⚠️ **STORED, and it is the one deliberate exception to this system's derive-don't-store rule.**
     * `balanceOf` takes no `asOf`, and even with one, entries can be **backdated** — an expense
     * keyed tomorrow with today's date would change what "expected at 22:00 today" evaluates to,
     * *after the count was taken and signed*. A count is an observation of a moment, not a standing
     * question, and re-deriving it later would silently rewrite a variance somebody was charged for.
     *
     * ⭐ Same reasoning as `attendance_days.attendance_config_id`: a payslip must never disagree
     * with what was actually recorded, even if today's config has since changed.
     */
    expected: numeric('expected', { precision: 14, scale: 2 }).notNull(),

    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
    countedBy: uuid('counted_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    notes: text('notes'),
  },
  (t) => [
    /** One count of one account at one moment. A second row would silently replace the signed
     *  figure with a different one and leave no trace that it changed. */
    uniqueIndex('till_count_lines_shift_moment_account_unique').on(
      t.shiftId,
      t.moment,
      t.moneyAccountId,
    ),
    index('till_count_lines_shift_idx').on(t.shiftId),
    check('till_count_lines_moment_check', sql`${t.moment} in ('open', 'close')`),
    check('till_count_lines_counted_nonnegative_check', sql`${t.counted} >= 0`),
    check('till_count_lines_counted_finite_check', sql`${t.counted} > '-Infinity'::numeric and ${t.counted} < 'Infinity'::numeric`),
    check('till_count_lines_expected_finite_check', sql`${t.expected} > '-Infinity'::numeric and ${t.expected} < 'Infinity'::numeric`),
  ],
);

/**
 * ⚠️ **There is no `variance` column, on purpose.** It is `counted - expected`, computed on read.
 * A third stored number is a third thing that can disagree with the two it came from — and this
 * particular disagreement would be between "what we charged the cashier" and "what we counted".
 */
