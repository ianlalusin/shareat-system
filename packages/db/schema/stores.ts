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

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('stores_org_id_code_unique').on(t.orgId, t.code),
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
  ],
);
