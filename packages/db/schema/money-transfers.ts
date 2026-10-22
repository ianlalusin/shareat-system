/**
 * Money transfers — moving money between the places it sits. T-139, bible row 150.
 *
 * > **Ian, 2026-08-26:** *"Each account can move money in any direction — cashier cash to cashier
 * > online, office to office, office to cashier, cashier to office, depending on transaction."*
 *
 * The 4th most-used entry in v1 (`POSTING-PATTERNS.md` §Transfer, **926 legs**). Two balance-sheet
 * legs, plus a third to an expense account when a fee applies.
 *
 * ## ⭐ Why a table exists at all, when "derive it from the journal" is usually the answer here
 *
 * A **cash** leg posts to `1110`/`1120`/`1130` with **no party** — the GL code IS the location —
 * so *which named account* moved is not recoverable from a cash-to-cash entry's legs. It survives
 * today only because the service refuses a second cash location per custodian per store, and that
 * is a constraint that could reasonably be relaxed later. The reference number, the note, and who
 * moved it are not in the ledger either.
 *
 * So this stores **the case** — what a person asserted — and every **figure** is still read from
 * the ledger. Bible row 147's rule, applied again.
 *
 * ## ⛔ There is no `fee` column
 *
 * The fee is `amount_out − amount_in`. Storing it would be a second source of truth for a figure
 * that already has one, and the two would eventually disagree — which is the entire lesson of
 * DEF-044 and of v1's prepaid register.
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const MONEY_TRANSFER_STATUSES = ['posted', 'voided'] as const;
export type MoneyTransferStatus = (typeof MONEY_TRANSFER_STATUSES)[number];

export const moneyTransfers = pgTable(
  'money_transfers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⚠️ Both ends are at THIS store. Cross-store money movement is an inter-entity transaction
     *  that must eliminate on consolidation — a different problem, and a different task. */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    fromMoneyAccountId: uuid('from_money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),
    toMoneyAccountId: uuid('to_money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),

    /**
     * ⭐ **Both figures are stated; the fee is derived** (T-139 §3).
     *
     * v1 takes one `amount` and charges the source `amount + fee`; this project's own posting doc
     * narrates the same three legs the other way round. The legs are identical either way — but
     * the same number typed in the same box would produce two different transfers, and **both
     * readings are real here**: a bank wire adds its fee to the source (send ₱10,000, debited
     * ₱10,050), a GCash cash-out deducts it from the target (cash out ₱10,000, receive ₱9,950).
     *
     * Asking for both removes the convention entirely. Each is a figure a person reads off the
     * statement they are reconciling against, which is what makes a transfer checkable at all.
     */
    amountOut: numeric('amount_out', { precision: 14, scale: 2 }).notNull(),
    amountIn: numeric('amount_in', { precision: 14, scale: 2 }).notNull(),
    /** Where the fee lands when there is one. `6870` Bank charges by default. Null when the
     *  transfer cost nothing, which is most of them. */
    feeAccountCode: text('fee_account_code'),

    transferDate: date('transfer_date').notNull(),
    /** The bank/wallet reference, when the source gives one — the thing you match against a
     *  statement line. */
    reference: text('reference'),
    notes: text('notes'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    status: text('status', { enum: MONEY_TRANSFER_STATUSES }).notNull().default('posted'),
    voidedOn: date('voided_on'),
    voidReason: text('void_reason'),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('money_transfers_org_store_date_idx').on(t.orgId, t.storeId, t.transferDate),
    index('money_transfers_from_idx').on(t.fromMoneyAccountId),
    index('money_transfers_to_idx').on(t.toMoneyAccountId),
    uniqueIndex('money_transfers_journal_entry_unique').on(t.journalEntryId),

    check('money_transfers_amount_out_positive_check', sql`${t.amountOut} > 0`),
    check('money_transfers_amount_in_positive_check', sql`${t.amountIn} > 0`),
    /** ⛔ Money arriving that never left is not a transfer — it is income, and it must not be
     *  enterable here. Equality is the ordinary case: no fee. */
    check('money_transfers_fee_not_negative_check', sql`${t.amountIn} <= ${t.amountOut}`),
    /** A fee with nowhere to land would silently vanish from the P&L while the entry still
     *  balanced — the exact trap POSTING-PATTERNS §Transfer warns about. */
    check(
      'money_transfers_fee_needs_account_check',
      sql`(${t.amountIn} = ${t.amountOut}) or (${t.feeAccountCode} is not null)`,
    ),
    check('money_transfers_distinct_accounts_check', sql`${t.fromMoneyAccountId} <> ${t.toMoneyAccountId}`),
    check('money_transfers_status_check', sql`${t.status} in ('posted', 'voided')`),
    /** All-or-nothing, the shape every other termination in this schema uses. */
    check(
      'money_transfers_void_shape_check',
      sql`(${t.status} = 'voided') = (${t.voidedOn} is not null and ${t.voidReason} is not null)`,
    ),
    check('money_transfers_amount_out_finite_check', sql`${t.amountOut} > '-Infinity'::numeric and ${t.amountOut} < 'Infinity'::numeric`),
    check('money_transfers_amount_in_finite_check', sql`${t.amountIn} > '-Infinity'::numeric and ${t.amountIn} < 'Infinity'::numeric`),
    // T-357 / DEF-490, migration 0171 — the single-column FKs above accept a cross-org account
    // (RLS checks only this row's own org_id; the FK check runs as the table owner). References
    // `money_accounts_org_id_id_unique` (`schema/money-accounts.ts` — hand-added in migration
    // 0171).
    foreignKey({
      columns: [t.orgId, t.fromMoneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'money_transfers_from_money_account_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.toMoneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'money_transfers_to_money_account_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'money_transfers_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'money_transfers_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'money_transfers_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'money_transfers_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
