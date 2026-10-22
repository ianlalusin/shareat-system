/**
 * Owners — the people whose capital the business runs on. T-127.
 *
 * ## ⛔ There are NO balances on this table, and that is the whole point
 *
 * v1 keeps three (`types/index.ts:2958-2968`): `totalCapital`, `totalDrawings`, and `netEquity` —
 * the last commented `// totalCapital - totalDrawings`, a **stored copy of a subtraction**. A third
 * copy lives in `EquityLedgerEntry.balanceBefore` / `balanceAfter`. That is the same shape v1's
 * loans had (bible row 158), found independently, and DEF-044 is what a maintained register costs
 * when nothing recomputes it. DEF-072.
 *
 * Here the position is summed from `3100` and `3200` by party. `net = contributed − drawn` is
 * arithmetic on the ledger, not a second definition of it — which is why the two cannot disagree.
 *
 * ## ⚠️ What this table DOES hold: identity and policy
 *
 * Who they are, what share they claim, and what they are allowed to withdraw. All of it is input to
 * the ledger's questions, never an answer to one.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const OWNER_STATUSES = ['active', 'inactive'] as const;
export type OwnerStatus = (typeof OWNER_STATUSES)[number];

/**
 * ⚠️ `monthly` measures the CALENDAR MONTH OF THE DRAWING'S OWN DATE, not of today. Measuring
 * against today would let a back-dated drawing slip a closed month's cap.
 *
 * ⛔ DEF-071: v1 accepts both values, writes both, **displays both back as a live constraint** — and
 * only ever checks `=== 'total'`. A monthly cap is shown to the owner and enforced by nothing, which
 * is worse than no cap: a displayed limit is a control people believe in and stop watching.
 */
export const DRAWING_LIMIT_PERIODS = ['monthly', 'total'] as const;
export type DrawingLimitPeriod = (typeof DRAWING_LIMIT_PERIODS)[number];

/** See `owners.personalExpenseTreatment`. */
export const PERSONAL_EXPENSE_TREATMENTS = ['repayable', 'drawing'] as const;
export type PersonalExpenseTreatment = (typeof PERSONAL_EXPENSE_TREATMENTS)[number];

export const owners = pgTable(
  'owners',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⚠️ Per STORE, as v1 has it — a partner in one store is not automatically a partner in
     *  another, and the money movements are per-store too (rows 152–153). */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /**
     * ⭐ An owner is a PERSON, not a new kind of identity. v1 carries a free-text `name` plus its own
     * `ownerId`, so the same human owning two stores is two unrelated records that nothing can join.
     */
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    /** Free text, as v1 has it: "Managing Partner", "Silent Partner". */
    role: text('role'),

    /**
     * ⚠️ **Advisory, and NOT validated to sum to 100 across a store.** A store mid-restructure sits
     * legitimately at 90% or 110% for a while, and a constraint that blocks recording reality is
     * worse than a figure that is only indicative. The screens must say so — see T-127 §6.
     */
    ownershipPercentage: numeric('ownership_percentage', { precision: 6, scale: 3 }),

    /** ⛔ Both or neither — see the CHECK below. */
    drawingLimit: numeric('drawing_limit', { precision: 14, scale: 2 }),
    drawingLimitPeriod: text('drawing_limit_period', { enum: DRAWING_LIMIT_PERIODS }),

    /**
     * ⭐ **Is a personal expense by this owner expected back?** It is the ONE decision made at the
     * expense, and it is the line the tax treatment turns on: a payment made with no expectation of
     * repayment is a distribution however it is labelled.
     *
     * > **Ian, 2026-08-27:** *"personal expense must be parked at owner's drawing, not automatically
     * > posted against it"*, then — after evaluating a three-route cascade — *"go to your 2route
     * > version."*
     *
     * | | |
     * |---|---|
     * | `repayable` | DR `1260` Due from owners. ⭐ **A receivable.** How it CLEARS is a separate act: cash, payroll recovery, or written off to `3200` |
     * | `drawing` | DR `3200` Owner's drawings. Equity goes down now, and nothing is coming back |
     *
     * ⛔ **The rejected design was a three-way cascade** — float, else salary advance, else drawing.
     * Its order was right and its timing was not: *"if not paid"* has no date, so nothing can decide
     * at approval that the owner will not pay. Declaring a receivable uncollectible is an act with a
     * date and an author, not a fallback — so it became a SETTLEMENT of `1260`, not a route.
     */
    personalExpenseTreatment: text('personal_expense_treatment', {
      enum: PERSONAL_EXPENSE_TREATMENTS,
    })
      .notNull()
      .default('repayable'),

    status: text('status', { enum: OWNER_STATUSES }).notNull().default('active'),
    notes: text('notes'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('owners_org_store_idx').on(t.orgId, t.storeId),
    index('owners_person_idx').on(t.personId),
    /** ⚠️ One owner record per person per store. Two rows for the same human in the same store would
     *  split their capital across two parties and make the position quietly wrong. */
    uniqueIndex('owners_store_person_key').on(t.storeId, t.personId),

    check('owners_status_check', sql`${t.status} in ('active','inactive')`),
    check(
      'owners_personal_expense_treatment_check',
      sql`${t.personalExpenseTreatment} in ('repayable','drawing')`,
    ),
    check(
      'owners_drawing_limit_period_check',
      sql`${t.drawingLimitPeriod} is null or ${t.drawingLimitPeriod} in ('monthly','total')`,
    ),
    /**
     * ⛔ **Half a rule is not a rule.** A limit with no period cannot be measured, and a period with
     * no limit measures nothing. DEF-071 is what the second half looks like in production: a value
     * present, displayed, and unenforceable.
     */
    check(
      'owners_drawing_limit_shape_check',
      sql`(${t.drawingLimit} is null and ${t.drawingLimitPeriod} is null)
          or (${t.drawingLimit} is not null and ${t.drawingLimitPeriod} is not null)`,
    ),
    check('owners_drawing_limit_positive_check', sql`${t.drawingLimit} is null or ${t.drawingLimit} > 0`),
    check(
      'owners_ownership_percentage_range_check',
      sql`${t.ownershipPercentage} is null
          or (${t.ownershipPercentage} > 0 and ${t.ownershipPercentage} <= 100)`,
    ),
    check('owners_ownership_percentage_finite_check', sql`${t.ownershipPercentage} > '-Infinity'::numeric and ${t.ownershipPercentage} < 'Infinity'::numeric`),
    check('owners_drawing_limit_finite_check', sql`${t.drawingLimit} > '-Infinity'::numeric and ${t.drawingLimit} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'owners_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'owners_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'owners_store_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: owners_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0212 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES owners (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);
