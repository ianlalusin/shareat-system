/**
 * Cash requests — a float handed to a person, and what comes back. T-144, bible row 159.
 *
 * ## ⭐ Not an imprest fund
 *
 * An imprest fund holds a fixed standing balance and is replenished. This holds **zero** between
 * requests: released, spent, returned, and whatever is missing accounted for — the four postings
 * net to nothing when the request closes (T-136 §5b).
 *
 * ## ⚠️ The REQUEST posts nothing
 *
 * Asking for money is not a financial event (bible §16.10); only the **release** is. A system that
 * posted on request would show a float in someone's hands before anyone handed it over.
 *
 * ## ⛔ What v1 stores and this does not
 *
 * `remainingAmount` and `varianceAmount` — both subtractions of things the ledger already knows.
 * Here the float's position is derived: released − spent − returned − short.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/**
 * `requested` → `approved` | `rejected` → `released` → `liquidated` | `cancelled`
 *
 * ⚠️ **`liquidated` is reached by ARITHMETIC**, when the float's ledger position hits zero. The
 * column records the state; the ledger decides it — the same rule loans use for `paid_off`.
 */
export const CASH_REQUEST_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'released',
  'liquidated',
  'cancelled',
] as const;
export type CashRequestStatus = (typeof CASH_REQUEST_STATUSES)[number];

export const cashRequests = pgTable(
  'cash_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** ⭐ Who will hold the float. The whole document exists to answer "who has the money". */
    requestedFor: uuid('requested_for')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    purpose: text('purpose').notNull(),
    requestedAmount: numeric('requested_amount', { precision: 14, scale: 2 }).notNull(),
    requestedOn: date('requested_on').notNull(),

    status: text('status', { enum: CASH_REQUEST_STATUSES }).notNull().default('requested'),

    approvedAmount: numeric('approved_amount', { precision: 14, scale: 2 }),
    approvedBy: uuid('approved_by').references(() => persons.id, { onDelete: 'restrict' }),
    decidedOn: date('decided_on'),
    /** Why it was refused. ⚠️ Required to reject — a refusal with no reason is unanswerable. */
    rejectReason: text('reject_reason'),

    /** Where the money came from. ⚠️ Named, not inferred — "the till" is not an account. */
    releasedFromMoneyAccountId: uuid('released_from_money_account_id').references(
      () => moneyAccounts.id,
      { onDelete: 'restrict' },
    ),
    releasedOn: date('released_on'),
    releasedBy: uuid('released_by').references(() => persons.id, { onDelete: 'restrict' }),

    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('cash_requests_org_store_idx').on(t.orgId, t.storeId),
    index('cash_requests_org_status_idx').on(t.orgId, t.status),
    index('cash_requests_holder_idx').on(t.requestedFor),

    check('cash_requests_amount_positive_check', sql`${t.requestedAmount} > 0`),
    check('cash_requests_purpose_not_blank_check', sql`length(trim(${t.purpose})) > 0`),
    check(
      'cash_requests_status_check',
      sql`${t.status} in ('requested','approved','rejected','released','liquidated','cancelled')`,
    ),
    /** ⛔ A refusal needs a reason, and an approval needs an amount and an approver. Neither can be
     *  half-recorded — "approved, but nobody says for how much" is not a state. */
    check(
      'cash_requests_decision_shape_check',
      sql`(${t.status} in ('requested', 'cancelled'))
          or (${t.status} = 'rejected' and ${t.rejectReason} is not null and ${t.approvedBy} is not null)
          or (${t.status} in ('approved','released','liquidated')
              and ${t.approvedAmount} is not null and ${t.approvedBy} is not null)`,
    ),
    /** ⚠️ Released means the money left a NAMED account on a KNOWN date. */
    check(
      'cash_requests_release_shape_check',
      sql`${t.status} not in ('released', 'liquidated')
          or (${t.releasedFromMoneyAccountId} is not null and ${t.releasedOn} is not null)`,
    ),
    check('cash_requests_approved_positive_check', sql`${t.approvedAmount} is null or ${t.approvedAmount} > 0`),
    check('cash_requests_requested_amount_finite_check', sql`${t.requestedAmount} > '-Infinity'::numeric and ${t.requestedAmount} < 'Infinity'::numeric`),
    check('cash_requests_approved_amount_finite_check', sql`${t.approvedAmount} > '-Infinity'::numeric and ${t.approvedAmount} < 'Infinity'::numeric`),
    // T-357 / DEF-490, migration 0171 — the single-column FK above accepts a cross-org account
    // (RLS checks only this row's own org_id; the FK check runs as the table owner). MATCH SIMPLE
    // (Drizzle's default, unwritten): a NULL release account skips this FK entirely — "not yet
    // released" stays representable. References `money_accounts_org_id_id_unique`
    // (`schema/money-accounts.ts` — hand-added in migration 0171).
    foreignKey({
      columns: [t.orgId, t.releasedFromMoneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'cash_requests_released_from_money_account_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.approvedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'cash_requests_approved_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'cash_requests_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.releasedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'cash_requests_released_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.requestedFor],
      foreignColumns: [persons.orgId, persons.id],
      name: 'cash_requests_requested_for_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'cash_requests_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
