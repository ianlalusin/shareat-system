/**
 * positions + employments + employment_positions — the staff master record.
 * docs/tasks/154-positions-and-employments.md, docs/plans/phase-4-attendance.md §2.
 *
 * ## Why this table did not exist until Phase 4
 *
 * `docs/CAPABILITY-GAPS.md:152` — *"Staff master record + position taxonomy · **4** — load-bearing
 * for 4 and 5; previously unowned."* Discovery 15 puts the risk plainly: attendance needs a person
 * to punch against and payroll needs a rate to pay, so if this is never scoped as its own
 * deliverable *"it gets built piecemeal inside P4/P5 without ever getting the 'one `person` table'
 * spine treatment"* — recreating the four-loosely-linked-identities mess v2 exists to retire.
 *
 * ⭐ **Half that spine already shipped.** `persons` + `person_identities` (T-101) answer *who someone
 * is*; `person_credentials` + `sessions` (T-138) answer *how they prove it*. This file answers the
 * third question — *do they hold a job here, doing what, and between which dates* — and it answers
 * it by pointing at `persons`, never by copying it.
 *
 * ## ⛔ What is deliberately NOT here, and it is most of v1's `StaffPlain`
 *
 * v1's staff record (`ERP-rebuild/src/types/index.ts:700-750`) carries `fullName`, `email`,
 * `contactNo`, `birthday`, `address` — **per store**. One person working two branches is two
 * records with two copies of their phone number and a manually-maintained `staffIdentities` link
 * between them. Those columns are the person's, they live on `persons`, and a second copy here
 * would be the same duplication wearing a new table name.
 *
 * Also absent, and each for its own reason:
 *   - `rate` / pay type       — Phase 5, and effective-dated when it lands. An employment is a fact
 *                               about a JOB; a rate is a fact about MONEY. Different cadence.
 *   - `linkedLocalUserId`, `linkedUserUid`, `staffIdentities`
 *                             — all three are `person_id`, a foreign key, already.
 *   - `isActive`              — DERIVED (`v_active_employments`). See below.
 *   - `isSlicer`              — derived from holding the Slicer position. A boolean that must agree
 *                               with an array is landmine #12 waiting to happen, and v1 has both.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { storedFiles } from './stored-files';
import { stores } from './stores';

/**
 * The canonical six, from v1's single source of truth (`ERP-rebuild/src/types/position.ts:72`).
 * A store may add its own beyond these; it may not edit or delete one of these.
 */
export const CANONICAL_POSITIONS = [
  'Cashier',
  'Cook',
  'Server',
  'Dishwasher',
  'Slicer',
  'Inventory Staff',
] as const;

/**
 * ⭐ The least-privileged canonical position, and the default when none is chosen.
 *
 * v1's reasoning, ported verbatim because it is better than most of what surrounds it
 * (`position.ts:58-64`): *"'Server' is not referenced by any nav group or server-side gate, so an
 * unspecified role lands on the floor-crew baseline instead of silently inheriting someone else's
 * permissions."* That is fail-closed thinking applied to a taxonomy.
 */
export const DEFAULT_POSITION = 'Server' as const;

/**
 * v1's seven employment statuses (`staff.actions.ts:28`), unchanged. The vocabulary is right; what
 * v1 lacks is any way to say WHEN someone left — see `employments.endedOn`.
 */
export const EMPLOYMENT_STATUSES = [
  'regular',
  'probationary',
  'contractual',
  'part-time',
  'resigned',
  'terminated',
  'inactive',
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/** The statuses that mean the person has actually left, and therefore REQUIRE an end date. */
export const ENDED_STATUSES = ['resigned', 'terminated'] as const;

// -------------------------------------------------------------------------------------
// The taxonomy. Canonical rows and store-defined extras in ONE table, told apart by
// store_id being null — because they are the same kind of thing with different authority,
// and two tables would mean every reader unions them back together.
// -------------------------------------------------------------------------------------

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /**
     * ⭐ NULL means CANONICAL — org-wide, seeded, not editable by a store. Non-null is that
     * store's own invention. A store genuinely does invent positions, and v1 supports it.
     */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    isCanonical: boolean('is_canonical').notNull().default(false),

    /** Retire a position without deleting it — historical employments still reference it. */
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('positions_org_id_idx').on(t.orgId),
    index('positions_store_id_idx').on(t.storeId),
    /**
     * ⭐ Canonical and store-scoped are the SAME FACT stated twice, so the database holds them to
     * it rather than trusting whoever writes the row. Without this, a store-scoped row flagged
     * canonical would be editable by nobody and deletable by nobody, for no stated reason.
     */
    check('positions_canonical_is_org_wide_check', sql`${t.isCanonical} = (${t.storeId} is null)`),
    // NOTE: uniqueness is case- and whitespace-insensitive and must treat NULL store_id as a
    // single group — `unique (org_id, coalesce(store_id, <nil uuid>), lower(trim(name)))`. That is
    // an expression index Drizzle's builder cannot express; it is hand-added in the migration,
    // exactly as `person_identities` already documents for its own identity-defining rule.
  ],
);

// -------------------------------------------------------------------------------------
// The job itself.
// -------------------------------------------------------------------------------------

export const employments = pgTable(
  'employments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** ⭐ The whole point of the table. Everything about the human lives on `persons`. */
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    /**
     * `SE-001`, per store, formatted exactly as v1's `formatStaffCode` (`staff.actions.ts:32`).
     * ⚠️ Allocated by `max + 1 ... for update` inside the creating transaction, NOT a Postgres
     * sequence: a sequence is global and gappy, and this number goes on a badge and a payslip. A
     * gap confuses a manager in a way a brief row lock does not.
     */
    staffCode: text('staff_code').notNull(),

    employmentStatus: text('employment_status', { enum: EMPLOYMENT_STATUSES }).notNull(),

    startedOn: date('started_on').notNull(),
    /**
     * ⭐ v1 has `resigned`/`terminated` as statuses and NO end date anywhere, so *"when did they
     * leave"* is currently unanswerable — which is also why a departed staffer can sit on a frozen
     * memo roster forever. The CHECK below makes the two agree by construction.
     */
    endedOn: date('ended_on'),

    notes: text('notes'),
    /** T-141 brokered upload. Never a data URL — v1 stores signatures that way and it does not scale. */
    photoFileId: uuid('photo_file_id').references(() => storedFiles.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('employments_org_id_idx').on(t.orgId),
    index('employments_store_id_idx').on(t.storeId),
    index('employments_person_id_idx').on(t.personId),

    /**
     * ⛔ At most ONE OPEN employment per person per store. Two open employments at one store is
     * the shape that lets a punch land on the wrong one, silently, and payroll pay it twice.
     * A re-hire is a new row after the previous one has an end date.
     */
    uniqueIndex('employments_open_person_store_unique')
      .on(t.personId, t.storeId)
      .where(sql`${t.endedOn} is null`),

    check('employments_status_check', sql`${t.employmentStatus} in ('regular','probationary','contractual','part-time','resigned','terminated','inactive')`),
    check('employments_dates_ordered_check', sql`${t.endedOn} is null or ${t.endedOn} >= ${t.startedOn}`),
    /**
     * ⭐ A terminated employment with no end date, and an end date with a live status, are BOTH
     * unrepresentable. Stated as an equality rather than two implications so neither direction can
     * be forgotten.
     */
    check(
      'employments_ended_status_pair_check',
      sql`(${t.employmentStatus} in ('resigned','terminated')) = (${t.endedOn} is not null)`,
    ),
    // NOTE: `unique (store_id, lower(staff_code))` is an expression index, hand-added in the migration.
  ],
);

// -------------------------------------------------------------------------------------
// Which work this person does. Many rows, exactly one primary.
// -------------------------------------------------------------------------------------

/**
 * ⭐ v1 carries `position` AND `positions[]`, with `position` documented as *"mirrors positions[0]"*
 * — two fields holding one fact, kept in step by hand. That is landmine #12 (*"Two switches governed
 * one behaviour; only one was enforced"*). Here the primary is a FLAGGED ROW, and the flag is
 * unique by partial index, so the two cannot disagree.
 *
 * v1's own rule survives intact (`index.ts:712-714`): *"Source of truth for permissions/assignment
 * (union of all). A staff can do the work of any listed position."* A cashier who cooks on Sundays
 * is one person with two rows, not two records.
 */
export const employmentPositions = pgTable(
  'employment_positions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** CASCADE is deliberate and matches `person_identities`: a position assignment is genuinely
     *  PART OF the employment, not an independent record (bible §4.2 rule 3). */
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'cascade' }),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'restrict' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('employment_positions_employment_position_unique').on(t.employmentId, t.positionId),
    index('employment_positions_position_id_idx').on(t.positionId),
    /** Exactly one primary — the same partial-unique-index pattern `person_roles` already uses
     *  for "at most one active role per (person, org)". */
    uniqueIndex('employment_positions_one_primary_unique')
      .on(t.employmentId)
      .where(sql`${t.isPrimary}`),
  ],
);
