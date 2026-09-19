/**
 * Prepaid items — an expense already paid for but not yet used up.
 * docs/tasks/125-prepaid-and-amortisation.md.
 *
 * A year of insurance, a mayor's permit, six months of rent in advance. It sits on the balance
 * sheet at `1400` and is released into the P&L a month at a time.
 *
 * ## ⭐ The shape is T-124's. The accounting is NOT.
 *
 * Read T-125 §10 before reusing anything from fixed assets. The differences are deliberate:
 *
 * | | Fixed asset | Prepaid |
 * |---|---|---|
 * | Account | `1510` at cost PLUS contra `1590` | ⭐ **`1400` alone, decremented directly** |
 * | Salvage | Yes | ⛔ None — runs to zero |
 * | Interval | monthly / quarterly / semi-annual / annual | ⛔ **Monthly only** |
 * | Term | `useful_life_months` — an ESTIMATE of replacement | `coverage_months` — a CONTRACT |
 *
 * v1 states the account difference outright (`amortization.builder.ts:12-14`): *"This differs from
 * depreciation (which uses a contra_asset account and preserves gross cost) — prepaid-expense
 * accounting directly reduces the current-asset balance, matching US GAAP / IFRS practice."*
 * ⛔ **Do not add a contra account for symmetry.** The asymmetry is the correct treatment.
 *
 * ## ⛔ What is deliberately ABSENT
 *
 * No `amortised_to_date`, no `remaining`, no `monthly_amortisation`. v1 has all three, hand-
 * incremented at every write site and — its own type admits — kept in sync *"by convention"*.
 * They drifted so thoroughly that v1 ended up with **two independent code paths computing "total
 * remaining prepaid" that never read from each other**. Here the figures are derived from the
 * ledger, exactly as T-124 derives accumulated depreciation. This is DEF-044's lesson applied a
 * second time, and it is cheaper here than it was there.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { expenses } from './expenses';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/** v1's six, ported unchanged — they are the categories the business actually prepays for
 *  (`ERP-rebuild/src/types/index.ts:263-269`). */
export const PREPAID_CATEGORIES = [
  'insurance',
  'permits_and_licenses',
  'rent_prepaid',
  'software_and_subscriptions',
  'maintenance_contracts',
  'other_prepaid',
] as const;
export type PrepaidCategory = (typeof PREPAID_CATEGORIES)[number];

/**
 * `active` → amortising. `fully_amortised` → the schedule finished. `written_off` → terminated
 * early, whatever was left recognised (and any refund taken separately).
 *
 * ⚠️ No `voided`. v1 has one, and voiding an item there cascade-reverses EVERY posted leg
 * including the original purchase — which is why a single bad month can only be fixed by
 * re-creating the item and re-running every prior period. v2 reverses a single period instead
 * (§7.8), so the all-or-nothing state has nothing left to do.
 */
export const PREPAID_STATUSES = ['active', 'fully_amortised', 'written_off'] as const;
export type PrepaidStatus = (typeof PREPAID_STATUSES)[number];

export const prepaidItems = pgTable(
  'prepaid_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    category: text('category', { enum: PREPAID_CATEGORIES }).notNull(),

    /** ⭐ The CONTRACT's term, not an estimate. A 12-month policy covers 12 months — which is why
     *  there is no interval column: charging it quarterly would recognise cost for months not yet
     *  covered, the error prepaid accounting exists to prevent. */
    coverageStartDate: date('coverage_start_date').notNull(),
    coverageMonths: integer('coverage_months').notNull(),

    totalCost: numeric('total_cost', { precision: 14, scale: 2 }).notNull(),

    status: text('status', { enum: PREPAID_STATUSES }).notNull().default('active'),

    /** ⭐ True when the coverage term was GUESSED from the category default rather than read off
     *  the document (T-125 §11). The amount and date come from the invoice; the term does not,
     *  and a wrong term is wrong in every period it posts, for years. Cleared only by a human
     *  confirming or correcting it. */
    needsReview: boolean('needs_review').notNull().default(false),

    /** Back-link to the expense that paid for it, when it was created from one. */
    sourceExpenseId: uuid('source_expense_id').references(() => expenses.id, {
      onDelete: 'restrict',
    }),

    writtenOffOn: date('written_off_on'),
    writeOffReason: text('write_off_reason'),
    writtenOffBy: uuid('written_off_by').references(() => persons.id, { onDelete: 'restrict' }),

    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('prepaid_items_org_store_idx').on(t.orgId, t.storeId),
    index('prepaid_items_org_status_idx').on(t.orgId, t.status),
    index('prepaid_items_needs_review_idx').on(t.needsReview),
    index('prepaid_items_source_expense_idx').on(t.sourceExpenseId),

    check('prepaid_items_cost_positive_check', sql`${t.totalCost} > 0`),
    /** 1–120 months, matching v1's own bound. A term outside that is a typo, not a contract. */
    check(
      'prepaid_items_coverage_months_check',
      sql`${t.coverageMonths} >= 1 and ${t.coverageMonths} <= 120`,
    ),
    check(
      'prepaid_items_status_check',
      sql`${t.status} in ('active', 'fully_amortised', 'written_off')`,
    ),
    /** ⭐ The write-off fields are all-or-nothing, the same shape T-124's disposal pair uses: a
     *  half-populated termination cannot exist, and `written_off` cannot be quietly used as
     *  "active but somebody typed a date". */
    check(
      'prepaid_items_write_off_shape_check',
      sql`(${t.status} = 'written_off') = (${t.writtenOffOn} is not null and ${t.writeOffReason} is not null)`,
    ),
    check(
      'prepaid_items_write_off_after_start_check',
      sql`${t.writtenOffOn} is null or ${t.writtenOffOn} >= ${t.coverageStartDate}`,
    ),
    check('prepaid_items_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('prepaid_items_total_cost_finite_check', sql`${t.totalCost} > '-Infinity'::numeric and ${t.totalCost} < 'Infinity'::numeric`),
  ],
);
