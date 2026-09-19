/**
 * stores — the single source of branch identity for all four front-ends (ERP, POS,
 * CUSTOMER, Website). docs/tasks/101-core-schema.md Contract §3.
 *
 * The Website alone has three independently-synced branch sources today (DEF-010); this
 * table retires that duplication for everything built on top of it.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';

/**
 * How often a store physically carries its cash to the office. T-152, bible row 129.
 *
 * ⚠️ **This is the TRANSFER cadence, never the COUNT cadence.** The till is counted and handed
 * over **daily, always** — that is the custody control, and it is what makes a variance
 * attributable to one shift and one person. This setting governs only how often somebody walks the
 * money to the office, which is logistics (T-136 §1).
 */
export const REMITTANCE_CADENCES = ['daily', 'every_3_days', 'weekly', 'monthly'] as const;
export type RemittanceCadence = (typeof REMITTANCE_CADENCES)[number];

/**
 * T-160. `single_room` — a branch or kiosk: one room, which is both the default and the usage
 * source. `multi_room` — a commissary, with a Receiving/room split worth managing.
 */
export const STOCK_MODELS = ['single_room', 'multi_room'] as const;
export type StockModel = (typeof STOCK_MODELS)[number];

/** How many days of accumulation each cadence is allowed before it is overdue. */
export const CADENCE_DAYS: Record<RemittanceCadence, number> = {
  daily: 1,
  every_3_days: 3,
  weekly: 7,
  monthly: 30,
};

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Per-store and explicit. Business-day boundaries derive from THIS column
    // (src/lib/datetime.ts) — never a global constant.
    timezone: text('timezone').notNull().default('Asia/Manila'),
    isActive: boolean('is_active').notNull().default(true),

    /**
     * ⭐ **How this store organises stock — T-160, and it is an INVARIANT rather than a
     * preference.** A `single_room` store (a branch, a kiosk) may hold exactly ONE non-Receiving
     * active room, enforced by a trigger; a `multi_room` store (a commissary) is unconstrained.
     *
     * ⚠️ v1 has no such column and pays for it: `branch-stock-reconcile.actions.ts` exists purely
     * to REPAIR branches that drifted into several rooms — floor the negative balances, move
     * everything into a canonical room, delete the strays. **Made structural here, that tool has
     * nothing left to repair.**
     *
     * NOT NULL with a default, so "unset" cannot exist — and the default is the STRICTER of the
     * two, because a store that quietly became multi-room is exactly the drift being prevented.
     */
    stockModel: text('stock_model', { enum: STOCK_MODELS }).notNull().default('single_room'),

    /**
     * ⚠️ **NOT NULL with a default, so "unset" cannot exist.** Row 129: *"a store with none
     * configured must not silently mean 'never'. Default to daily, the safe end, and what every
     * store does today."* An unset cadence is the same defect class as an unmapped expense
     * category — it fails quietly, in the direction that looks fine.
     */
    remittanceCadence: text('remittance_cadence', { enum: REMITTANCE_CADENCES })
      .notNull()
      .default('daily'),

    /**
     * The pooled un-remitted balance that forces a remittance regardless of where the cycle is.
     *
     * ⭐ **Nullable ONLY while the cadence is `daily`** — see the check below. Daily remittance is
     * its own bound, so a ceiling adds nothing there; the moment a store pools, the number that
     * bounds the pile becomes compulsory.
     */
    unremittedCeiling: numeric('unremitted_ceiling', { precision: 14, scale: 2 }),

    /**
     * ⭐ T-178. The store's default responsible party for a TRACKED order wastage with no named
     * staffer — "a tracked wastage always has a chargeable owner from the moment it exists...
     * so a manager re-tags the real person later rather than starting from nothing" (T-178 §3).
     * Nullable: an unassigned Monitor is not a failure — it is the last rung of the backstop's
     * own fallback order (allocated split -> Monitor 100% -> store absorbs net-zero).
     */
    wastageMonitorPersonId: uuid('wastage_monitor_person_id').references(() => persons.id, { onDelete: 'restrict' }),

    /**
     * ⭐ T-229 slice 4 / DEF-208 — what this branch carries against the ORGANISATION's single TIN
     * (`organizations.tin`). ⚠️ The TIN itself is deliberately NOT duplicated here the way v1 had
     * it: one number copied onto seven store rows is seven places for it to be wrong, and discovery
     * 23 §1 already recorded that failure for `taxType` duplicated across ERP and POS.
     */
    tinBranchCode: text('tin_branch_code'),
    /** The trading address that prints on a document. */
    address: text('address'),
    /** ⚠️ ONE number. v1 carried four (`email`, `phone`, `contactNo`, `telephone`) — a form that
     *  grew, not a requirement (discovery 28 §5.5). */
    contactNumber: text('contact_number'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('stores_org_id_code_unique').on(t.orgId, t.code),
    /** ⭐ T-229 slice 4 R1 — digits only; the domain strips dashes and spaces first. Same reasoning
     *  as `organizations_tin_format_check`, and deliberately no rule tying it to the org's TIN. */
    check('stores_tin_branch_code_format_check', sql`${t.tinBranchCode} is null or ${t.tinBranchCode} ~ '^[0-9]{3,5}$'`),
    check(
      'stores_remittance_cadence_check',
      sql`${t.remittanceCadence} in ('daily', 'every_3_days', 'weekly', 'monthly')`,
    ),
    /**
     * ⭐ **The one that matters.** Row 129's failure is the COMBINATION — a long cadence with an
     * unbounded amount — so the database refuses to hold it. You cannot opt into pooling without
     * naming the number that bounds it, and no service-layer copy of this rule exists to drift
     * from it (bible §6.3: the database enforces the rules).
     */
    check(
      'stores_pooling_requires_ceiling_check',
      sql`${t.remittanceCadence} = 'daily' or ${t.unremittedCeiling} is not null`,
    ),
    check(
      'stores_unremitted_ceiling_positive_check',
      sql`${t.unremittedCeiling} is null or ${t.unremittedCeiling} > 0`,
    ),
    check('stores_unremitted_ceiling_finite_check', sql`${t.unremittedCeiling} > '-Infinity'::numeric and ${t.unremittedCeiling} < 'Infinity'::numeric`),
  ],
);
