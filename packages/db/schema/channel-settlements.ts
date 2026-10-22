/**
 * Channel settlement — clearing the receivable Foodpanda and Grab raise. T-150.
 * Spec: `docs/tasks/150-channel-settlement.md` (written by a peer session, 2026-08-28).
 *
 * ⭐ **Why this exists.** T-123 raises `1220 Channel receivable` on every verified delivery-platform
 * day, and nothing has ever cleared it — the balance only grows. This is **74% of v1's AR
 * collection volume** with no home, and Phase 2's exit gate (*"subledgers tie to control
 * accounts"*) cannot pass while `1220` only grows.
 *
 * ## The two accounts do different jobs, and collapsing them loses an alarm
 *
 * | Account | Says |
 * |---|---|
 * | `1220` Channel receivable, `party = channel` | *"Foodpanda owes us ₱X, and it is 12 days old."* |
 * | `1221`/`1222` clearing, **zero at rest** | *"Something did not finish."* |
 *
 * ⛔ **The trap, restated because it cost ₱198,148.29 once:** these fees are booked **here, once**.
 * A module that posts this settlement *and* lets someone raise a separate expense document for the
 * same platform fee has rebuilt the confirmed v1 defect (`POSTING-PATTERNS.md:411`).
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { loans } from './loans';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { salesChannels, salesDays } from './sales-days';
import { storedFiles } from './stored-files';
import { stores } from './stores';

export const CHANNEL_SETTLEMENT_STATUSES = ['draft', 'posted', 'voided'] as const;
export type ChannelSettlementStatus = (typeof CHANNEL_SETTLEMENT_STATUSES)[number];

export const channelSettlements = pgTable(
  'channel_settlements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => salesChannels.id, { onDelete: 'restrict' }),
    salesDayId: uuid('sales_day_id')
      .notNull()
      .references(() => salesDays.id, { onDelete: 'restrict' }),
    businessDate: date('business_date').notNull(),
    /** What the sales day said the channel sold. */
    grossAmount: numeric('gross_amount', { precision: 14, scale: 2 }).notNull(),
    /** What the receivable actually carried, and therefore what this clears. */
    outstandingCleared: numeric('outstanding_cleared', { precision: 14, scale: 2 }).notNull(),

    /**
     * ⭐ **Typed columns, not rows** — deliberately the opposite of `sales_day_channels`. That
     * table uses rows because channels are open-ended per-store configuration; deduction kinds are
     * a **closed set of six**, and a seventh needs an *account decision* before it needs a column.
     * Making a new kind a migration rather than a data row is the point: the decision cannot be
     * smuggled in as data.
     *
     * ⚠️ **None is constrained non-negative.** A negative deduction is a real credit — a
     * promo-heavy day genuinely returns money — and v1 shipped a bug by assuming otherwise.
     */
    commission: numeric('commission', { precision: 14, scale: 2 }).notNull().default('0'),
    marketing: numeric('marketing', { precision: 14, scale: 2 }).notNull().default('0'),
    platformFee: numeric('platform_fee', { precision: 14, scale: 2 }).notNull().default('0'),
    vatOnFees: numeric('vat_on_fees', { precision: 14, scale: 2 }).notNull().default('0'),
    withholdingTax: numeric('withholding_tax', { precision: 14, scale: 2 }).notNull().default('0'),
    penalty: numeric('penalty', { precision: 14, scale: 2 }).notNull().default('0'),

    /** Staff over-reported the day: the shortfall is swept to `6420` so the receivable clears exactly. */
    variance: numeric('variance', { precision: 14, scale: 2 }).notNull().default('0'),
    /** Staff under-reported: the excess posts to `7100` rather than editing an immutable sales day. */
    settlementGain: numeric('settlement_gain', { precision: 14, scale: 2 }).notNull().default('0'),

    loanDeduction: numeric('loan_deduction', { precision: 14, scale: 2 }).notNull().default('0'),
    loanId: uuid('loan_id').references(() => loans.id, { onDelete: 'restrict' }),
    /** Set when the loan belongs to ANOTHER store — the `1250`/`2150` reciprocal case. */
    loanOwnerStoreId: uuid('loan_owner_store_id').references(() => stores.id, { onDelete: 'restrict' }),

    netDeposited: numeric('net_deposited', { precision: 14, scale: 2 }).notNull(),
    destinationMoneyAccountId: uuid('destination_money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),

    reference: text('reference'),
    settledOn: date('settled_on').notNull(),
    /**
     * ⭐ The 2307 the platform issues. Captured even though the tax is expensed, because it is the
     * one document that cannot be obtained retroactively if the posture ever changes.
     */
    withholdingCertificateFileId: uuid('withholding_certificate_file_id').references(() => storedFiles.id, {
      onDelete: 'restrict',
    }),

    status: text('status', { enum: CHANNEL_SETTLEMENT_STATUSES }).notNull().default('draft'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    postedBy: uuid('posted_by').references(() => persons.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * ⭐ **The identity, held by the DATABASE** because it is one row and therefore checkable here
     * rather than in a service somebody can forget to call. What the channel owed us, plus
     * anything we under-reported, equals every deduction they made plus what they actually banked.
     */
    check(
      'channel_settlements_identity_check',
      sql`abs((${t.outstandingCleared} + ${t.settlementGain}) - (${t.commission} + ${t.marketing} + ${t.platformFee} + ${t.vatOnFees} + ${t.withholdingTax} + ${t.penalty} + ${t.variance} + ${t.loanDeduction} + ${t.netDeposited})) < 0.005`,
    ),
    check('channel_settlements_net_non_negative_check', sql`${t.netDeposited} >= 0`),
    check(
      'channel_settlements_variance_shape_check',
      sql`${t.variance} >= 0 AND ${t.settlementGain} >= 0 AND (${t.variance} = 0 OR ${t.settlementGain} = 0)`,
    ),
    check(
      'channel_settlements_posted_shape_check',
      sql`${t.status} <> 'posted' or (${t.postedBy} is not null and ${t.postedAt} is not null and ${t.journalEntryId} is not null)`,
    ),
    check(
      'channel_settlements_void_shape_check',
      sql`${t.status} <> 'voided' or (${t.voidedBy} is not null and ${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
    check(
      'channel_settlements_loan_shape_check',
      sql`(${t.loanDeduction} = 0 and ${t.loanId} is null) or (${t.loanDeduction} <> 0 and ${t.loanId} is not null)`,
    ),
    /** ⭐ One POSTED settlement per channel-day. A voided one must not block the corrected re-post. */
    uniqueIndex('channel_settlements_channel_day_key')
      .on(t.channelId, t.businessDate)
      .where(sql`${t.status} = 'posted'`),
    index('channel_settlements_org_store_date_idx').on(t.orgId, t.storeId, t.businessDate),
    index('channel_settlements_sales_day_idx').on(t.salesDayId),
    check('channel_settlements_gross_amount_finite_check', sql`${t.grossAmount} > '-Infinity'::numeric and ${t.grossAmount} < 'Infinity'::numeric`),
    check('channel_settlements_outstanding_cleared_finite_check', sql`${t.outstandingCleared} > '-Infinity'::numeric and ${t.outstandingCleared} < 'Infinity'::numeric`),
    check('channel_settlements_commission_finite_check', sql`${t.commission} > '-Infinity'::numeric and ${t.commission} < 'Infinity'::numeric`),
    check('channel_settlements_marketing_finite_check', sql`${t.marketing} > '-Infinity'::numeric and ${t.marketing} < 'Infinity'::numeric`),
    check('channel_settlements_platform_fee_finite_check', sql`${t.platformFee} > '-Infinity'::numeric and ${t.platformFee} < 'Infinity'::numeric`),
    check('channel_settlements_vat_on_fees_finite_check', sql`${t.vatOnFees} > '-Infinity'::numeric and ${t.vatOnFees} < 'Infinity'::numeric`),
    check('channel_settlements_withholding_tax_finite_check', sql`${t.withholdingTax} > '-Infinity'::numeric and ${t.withholdingTax} < 'Infinity'::numeric`),
    check('channel_settlements_penalty_finite_check', sql`${t.penalty} > '-Infinity'::numeric and ${t.penalty} < 'Infinity'::numeric`),
    check('channel_settlements_variance_finite_check', sql`${t.variance} > '-Infinity'::numeric and ${t.variance} < 'Infinity'::numeric`),
    check('channel_settlements_settlement_gain_finite_check', sql`${t.settlementGain} > '-Infinity'::numeric and ${t.settlementGain} < 'Infinity'::numeric`),
    check('channel_settlements_loan_deduction_finite_check', sql`${t.loanDeduction} > '-Infinity'::numeric and ${t.loanDeduction} < 'Infinity'::numeric`),
    check('channel_settlements_net_deposited_finite_check', sql`${t.netDeposited} > '-Infinity'::numeric and ${t.netDeposited} < 'Infinity'::numeric`),
    // T-357 / DEF-490, migration 0171 — the single-column FK above accepts a cross-org account
    // (RLS checks only this row's own org_id; the FK check runs as the table owner). References
    // `money_accounts_org_id_id_unique` (`schema/money-accounts.ts` — hand-added in migration
    // 0171).
    foreignKey({
      columns: [t.orgId, t.destinationMoneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'channel_settlements_destination_money_account_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'channel_settlements_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.loanOwnerStoreId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'channel_settlements_loan_owner_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.postedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'channel_settlements_posted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'channel_settlements_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'channel_settlements_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `channel_id` FK (RLS checks only this row's org_id); references `sales_channels_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.channelId],
      foreignColumns: [salesChannels.orgId, salesChannels.id],
      name: 'channel_settlements_channel_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'channel_settlements_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `loan_id` FK (RLS checks only this row's org_id); references `loans_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.loanId],
      foreignColumns: [loans.orgId, loans.id],
      name: 'channel_settlements_loan_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `sales_day_id` FK (RLS checks only this row's org_id); references `sales_days_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.salesDayId],
      foreignColumns: [salesDays.orgId, salesDays.id],
      name: 'channel_settlements_sales_day_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `withholding_certificate_file_id` FK (RLS checks only this row's org_id); references `stored_files_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.withholdingCertificateFileId],
      foreignColumns: [storedFiles.orgId, storedFiles.id],
      name: 'channel_settlements_withholding_certificate_file_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: channel_settlements_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0213 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES channel_settlements (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);
