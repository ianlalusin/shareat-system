/**
 * Customers and price lists. T-129, ADR-008 §2, §3, §11.
 *
 * ## ⛔ A retail diner is NOT a customer
 *
 * > **ADR-008 §11:** *"A `customers` row exists because there is a BALANCE or a credit
 * > relationship. A diner who pays at the point of sale has neither."*
 *
 * ⚠️ The test is **not** org-vs-individual. An individual buying meat on terms belongs here; a
 * company paying cash at the counter does not. À la carte orders stay on the Website and the diner
 * behind them is a loyalty profile in another app.
 *
 * ## ⛔ No `outstanding_balance` column — DEF-075, the fifth time
 *
 * v1 keeps one on `ARCustomerPlain`, and another on `ApSupplierPlain`. Here the balance is summed
 * from `1210` by party, from day one, so there is never a column for T-131 to have to remove.
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
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/** ⚠️ Reporting and default pricing ONLY. ⛔ It must never gate a posting decision (ADR-008 §2). */
export const CUSTOMER_GROUPS = ['wholesale', 'franchise', 'internal', 'staff', 'other'] as const;
export type CustomerGroup = (typeof CUSTOMER_GROUPS)[number];

export const CUSTOMER_STATUSES = ['active', 'inactive'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** ⭐ Derived from the links, never stored. See `customers` below. */
export const CUSTOMER_TREATMENTS = ['internal', 'inter_entity', 'external'] as const;
export type CustomerTreatment = (typeof CUSTOMER_TREATMENTS)[number];

export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('price_lists_org_name_key').on(t.orgId, t.name),
    check('price_lists_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
  ],
);

export const priceListItems = pgTable(
  'price_list_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    priceListId: uuid('price_list_id')
      .notNull()
      // ⭐ CASCADE is deliberate here (bible §4.2 rule 3): a rate is genuinely part of its list, not
      // an independent record that could outlive it.
      .references(() => priceLists.id, { onDelete: 'cascade' }),

    /**
     * ⭐ **The FK this column was promised.** It read *"opaque text, not a FK — there is no item
     * master in v2 yet… ⛔ This becomes a foreign key the day an item master lands"* from T-129
     * until T-145 landed `items` on 2026-08-28. `itemName` went with it: the item's own name is
     * the name, and a second copy is a second thing to keep true.
     */
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),

    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    unit: text('unit'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /** ⛔ One rate per item per list. Two rows would make "what does this cost?" ambiguous, and the
     *  lookup would answer whichever the planner reached first. */
    uniqueIndex('price_list_items_list_item_key').on(t.priceListId, t.itemId),
    index('price_list_items_org_idx').on(t.orgId),
    check('price_list_items_rate_not_negative_check', sql`${t.rate} >= 0`),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    address: text('address'),
    contactNo: text('contact_no'),

    /**
     * ⭐ **Set when this "customer" is one of OUR OWN stores** — an internal transfer that
     * ELIMINATES rather than becoming revenue.
     *
     * ⚠️ v1 has this already, as `ARCustomerPlain.linkedStoreId`, which is why this is a
     * re-platform rather than an invention. What v1 cannot express is the other link.
     */
    counterpartyStoreId: uuid('counterparty_store_id').references(() => stores.id, {
      onDelete: 'restrict',
    }),

    /**
     * ⭐ **Set when this customer is ANOTHER org in the system** — a franchise. Real revenue and a
     * real receivable: money leaves one legal entity and enters another.
     *
     * ⛔ v1 has no equivalent, because v1 models a franchise as a branch (ADR-008 §7) — which is
     * exactly the conflation that produces revenue that does not exist, or hides revenue that does.
     */
    counterpartyOrgId: uuid('counterparty_org_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),

    priceListId: uuid('price_list_id').references(() => priceLists.id, { onDelete: 'restrict' }),
    /**
     * ⭐ T-132. How much this customer may owe us before a dispatch is refused.
     *
     * ⚠️ NULL means *"no limit set"* and is NOT the same as `0`, which would mean *"may not owe
     * us anything"*. Checked at exactly ONE gate — dispatch — with a manager override. Three of
     * the four systems studied answer the credit question differently; Dolibarr's limit field
     * that enforces nothing is the cautionary tale, and ERPNext's three separate check points
     * exist only because it has three documents to check.
     */
    creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }),

    /** ⚠️ Reporting and defaults ONLY. ⛔ Never an input to an accounting decision. */
    customerGroup: text('customer_group', { enum: CUSTOMER_GROUPS }).notNull().default('wholesale'),
    status: text('status', { enum: CUSTOMER_STATUSES }).notNull().default('active'),
    notes: text('notes'),

    /**
     * ⭐ **The reconciliation anchor, ported from v1** — *"admin stamps this when the customer is
     * verified at zero outstanding… everything before this date is considered settled."*
     *
     * ⚠️ **An attestation, not a balance.** It says a named person agreed this customer owed nothing
     * on a named date, and it does not change when the ledger does — the same shape as T-127's
     * drawings close, and the reason a later disagreement is visible rather than silent.
     */
    reconciledAsOf: date('reconciled_as_of'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    reconciledBy: uuid('reconciled_by').references(() => persons.id, { onDelete: 'restrict' }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('customers_org_idx').on(t.orgId),
    index('customers_counterparty_store_idx').on(t.counterpartyStoreId),
    index('customers_counterparty_org_idx').on(t.counterpartyOrgId),
    uniqueIndex('customers_org_name_key').on(t.orgId, t.name),

    check('customers_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('customers_status_check', sql`${t.status} in ('active','inactive')`),
    check(
      'customers_group_check',
      sql`${t.customerGroup} in ('wholesale','franchise','internal','staff','other')`,
    ),
    /**
     * ⛔ **AT MOST ONE counterparty link** — ADR-008 §2, and this CHECK is the whole design.
     *
     * ⚠️ Both set at once would make the treatment ambiguous, and the two answers are not close:
     * one eliminates the movement entirely, the other books real revenue. Whichever the code
     * checked first would win, and nothing on any screen would look wrong.
     */
    check(
      'customers_one_counterparty_check',
      sql`num_nonnulls(${t.counterpartyStoreId}, ${t.counterpartyOrgId}) <= 1`,
    ),
    /** ⚠️ An anchor is a three-part fact: a date, a moment, and a person. Any one alone is an
     *  assertion nobody can check. */
    check(
      'customers_reconciled_shape_check',
      sql`(${t.reconciledAsOf} is null and ${t.reconciledAt} is null and ${t.reconciledBy} is null)
          or (${t.reconciledAsOf} is not null and ${t.reconciledAt} is not null
              and ${t.reconciledBy} is not null)`,
    ),
  ],
);
