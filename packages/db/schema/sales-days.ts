/**
 * sales_days + sales_day_channels — the ERP's record of a day's selling, per store.
 * docs/tasks/123-sales-day.md.
 *
 * ## Scope: this is REVENUE RECOGNITION only (T-123 §3, split A)
 *
 * v1's `SalesDayPlain` fuses three documents with three different natural cadences: revenue
 * recognition, the till's daily accountability (`less`/`plus`), and the remittance. **That fusion
 * is exactly why a remittance cannot span days** (bible row 128), which Ian has asked for.
 *
 * So this table is **A only**. The till position and the remittance are T-136 — per cashier per
 * shift, and pooled, respectively. ⛔ **Do not add `actualRemittanceCash`, `remittanceRefNo` or a
 * `partially_remitted` status here**; that is precisely the shape that blocks pooling.
 *
 * ## Verification is what POSTS (bible row 126)
 *
 * An unverified day has no journal entry, so it contributes no revenue anywhere. v1 instead
 * summed `salesDays.totalSales` — the mirror document WAS the revenue — which forced the
 * verified-only rule into three separate readers with a note saying *"keep them in sync if you add
 * a 4th."* **Here the ledger is the revenue and there is nothing to keep in sync** (bible row 118).
 *
 * ## ⚠️ Why none of v1's figure names survive
 *
 * Reading `ERP-rebuild/src/lib/financial/sales-report/derive-totals.ts` — the DERIVATION, not the
 * type — showed that four of v1's figure names mean something other than what they say. Two of
 * them mean *different* things depending on which system or which document wrote the row.
 *
 * **All four are documented and banned in `docs/GLOSSARY.md`, which is the one place they are
 * explained.** They cannot appear here — `tests/unit/glossary-trap-names.test.ts` fails the build
 * on any v2 source file that names one, comments included, and that absoluteness is the point: a
 * guard with an "unless you are explaining it" exception is a guard someone will argue their way
 * past. **Read the glossary; the columns below are named for what they hold.**
 *
 * ## Two splits, and they are NOT the same split
 *
 *   1. **The posting split** — unli (4100) vs à la carte (4150). Decides which revenue account.
 *   2. **The remittance split** — which CHANNEL the money came through, and therefore whether it
 *      reaches the till at all. Foodpanda settles to a bank; cash does not.
 *
 * v1 conflates them, which is how its non-remitted-total field ended up holding a copy of the
 * day's own total (docs/GLOSSARY.md). Here they
 * are independent: (1) is two columns, (2) is `sales_day_channels` rows joined to the channel's
 * own `is_remitted_daily`. **The remitted/non-remitted totals are DERIVED, never stored** — so
 * they cannot drift from the channel configuration that defines them.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

// -------------------------------------------------------------------------------------
// sales_channels — per-store configuration. v1's Store.salesChannels[], as rows.
// -------------------------------------------------------------------------------------

export const salesChannels = pgTable(
  'sales_channels',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * ⭐ Ian's remittable flag (v1: `SalesChannel.isRemittedDaily`). **The single most
     * load-bearing field here**: it decides whether this channel's money reaches the cashier's
     * till and therefore whether it is part of expected remittance at all. Cash sales are
     * remitted; Foodpanda settles to a bank days later and never touches the drawer.
     *
     * NOT NULL with no default — a channel whose remittance behaviour nobody stated is a channel
     * whose money nobody can account for.
     */
    isRemittedDaily: boolean('is_remitted_daily').notNull(),
    /**
     * Where a non-remitted channel's receivable lands. Required when `is_remitted_daily` is
     * false (a platform owes us money until it settles), meaningless when true.
     */
    receivableAccountCode: text('receivable_account_code'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sales_channels_org_id_store_id_name_unique').on(t.orgId, t.storeId, t.name),
    index('sales_channels_org_id_store_id_idx').on(t.orgId, t.storeId),
    // A non-remitted channel MUST name where its receivable goes. DEF-059 is what happens when a
    // channel's wiring is allowed to be absent: the money is silently lost rather than refused.
    check(
      'sales_channels_non_remitted_needs_receivable_check',
      sql`${t.isRemittedDaily} = true or ${t.receivableAccountCode} is not null`,
    ),
  ],
);

// -------------------------------------------------------------------------------------
// sales_days — one per store per business date.
// -------------------------------------------------------------------------------------

export const salesDays = pgTable(
  'sales_days',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** The day being reported. The journal entry dates on THIS, never on now() (bible row 126):
     *  a 31 December sale confirmed on 2 January is December revenue. */
    businessDate: date('business_date').notNull(),

    status: text('status', { enum: ['open', 'submitted', 'verified', 'voided'] })
      .notNull()
      .default('open'),

    /** ⭐ Provenance on the figure itself — ported from v1, and worth keeping. A day pulled
     *  from POS and a day typed in by hand are not equally trustworthy, and a reader that cannot
     *  tell them apart will treat them as if they were. */
    posSourced: boolean('pos_sourced').notNull().default(false),
    posSourcedAt: timestamp('pos_sourced_at', { withTimezone: true }),

    // ── Revenue: the POSTING split (which account), not the channel split ──────────────
    totalSales: numeric('total_sales', { precision: 14, scale: 2 }).notNull(),
    /** -> 4100 Food sales — unlimited. Renamed from a v1 field whose name means the opposite
     *  of how it reads (docs/GLOSSARY.md). */
    unliSales: numeric('unli_sales', { precision: 14, scale: 2 }).notNull(),
    /** -> 4150 Food sales — à la carte. Absorbs dine-in à la carte, take-out AND delivery alike,
     *  because POS has no take-out flag at all. In v1 this is a RESIDUAL wearing a measurement's
     *  name (docs/GLOSSARY.md) — here it is stated, not inferred. */
    alaCarteSales: numeric('ala_carte_sales', { precision: 14, scale: 2 }).notNull(),

    // ── Contra-revenue. Two accounts, NOT interchangeable ─────────────────────────────
    /** ⚠️ Senior and PWD are broken out because RR 5-2017 requires it, not for reporting taste
     *  (discovery 24 §4). Sales to SC/PWD are VAT-exempt and the burden of proof is on the seller.
     *  ⛔ A per-transaction PWD LOGBOOK is also mandatory and is NOT satisfied by these daily
     *  totals — only POS holds transaction detail. Open, and flagged to Ian. */
    seniorDiscount: numeric('senior_discount', { precision: 14, scale: 2 }).notNull().default('0'),
    pwdDiscount: numeric('pwd_discount', { precision: 14, scale: 2 }).notNull().default('0'),
    otherDiscount: numeric('other_discount', { precision: 14, scale: 2 }).notNull().default('0'),
    /** -> 4950 Sales returns and voids, NEVER 4900 and never a marketing expense. Ian confirmed
     *  directly: comps are revenue foregone, not a cost incurred (bible row 74). */
    comps: numeric('comps', { precision: 14, scale: 2 }).notNull().default('0'),

    // ── The tender side: where the money went ─────────────────────────────────────────
    /** -> 1110 Cash on hand — cashier. Selling cash always enters the till first, so the
     *  cashier/office owner split (bible row 127) does not arise here; it arises on the
     *  REMITTANCE that moves it afterwards (T-136). */
    cashCollected: numeric('cash_collected', { precision: 14, scale: 2 }).notNull().default('0'),
    /** -> 1140 E-wallet / online channels. ⚠️ Card tenders run through here too: v1 has a
     *  separate card-tender field that nothing ever populates (docs/GLOSSARY.md), so it is not
     *  modelled rather than carried forward empty. */
    onlineCollected: numeric('online_collected', { precision: 14, scale: 2 }).notNull().default('0'),
    /** -> 1210 Accounts receivable. **Not cash** — a sale on account. */
    creditSales: numeric('credit_sales', { precision: 14, scale: 2 }).notNull().default('0'),

    // Set by verify() — the posting step. Never set any other way.
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    submittedBy: uuid('submitted_by').references(() => persons.id, { onDelete: 'restrict' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** ⚠️ Kept distinct from `submittedBy` deliberately: *"the person who submits should not be
     *  the one who verifies"* (CAPABILITY-MATRIX.md). Storing both is what makes it auditable —
     *  v1's four-role `signoff` block shows the business already knows this. */
    verifiedBy: uuid('verified_by').references(() => persons.id, { onDelete: 'restrict' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /** ⭐ ONE report per store per business date — and this is what makes the create-block
     *  (bible row 126) meaningful. Without it, "an older day is unverified" is ambiguous. */
    uniqueIndex('sales_days_org_id_store_id_business_date_unique').on(t.orgId, t.storeId, t.businessDate),
    index('sales_days_org_id_business_date_idx').on(t.orgId, t.businessDate),
    /** The create-block's own query: the oldest unverified day for this store before a date. */
    index('sales_days_org_id_store_id_status_business_date_idx').on(t.orgId, t.storeId, t.status, t.businessDate),
    index('sales_days_status_idx').on(t.status),

    check('sales_days_status_check', sql`${t.status} in ('open', 'submitted', 'verified', 'voided')`),
    /** Every figure is a magnitude. ⚠️ v1 floors its derived cash at zero, which HIDES a negative —
     *  and a negative there is a real signal that the tender figures disagree. Here a negative
     *  cannot be stored at all, so the disagreement surfaces at write time instead. */
    check('sales_days_non_negative_check', sql`
      ${t.totalSales} >= 0 and ${t.unliSales} >= 0 and ${t.alaCarteSales} >= 0
      and ${t.seniorDiscount} >= 0 and ${t.pwdDiscount} >= 0 and ${t.otherDiscount} >= 0
      and ${t.comps} >= 0
      and ${t.cashCollected} >= 0 and ${t.onlineCollected} >= 0 and ${t.creditSales} >= 0
    `),
    /** ⭐ The revenue side of the balance identity: the posting split must exhaust the total.
     *  The TENDER side cannot be checked here — non-remitted channel receivables live in
     *  `sales_day_channels`, so that half is enforced in the service layer, over both tables. */
    check('sales_days_revenue_identity_check', sql`
      ${t.unliSales} + ${t.alaCarteSales} = ${t.totalSales}
    `),
    /** Provenance is a pair or neither. */
    check('sales_days_pos_sourced_check', sql`
      (${t.posSourced} = false and ${t.posSourcedAt} is null)
      or (${t.posSourced} = true and ${t.posSourcedAt} is not null)
    `),
  ],
);

// -------------------------------------------------------------------------------------
// sales_day_channels — the channel split, as ROWS. v1's salesChannelBreakdown map.
// -------------------------------------------------------------------------------------

/**
 * ⭐ **Rows, not a `Record<string, number>`** — so a channel can be joined to its configuration
 * and the remitted / non-remitted totals are **derived rather than stored**. That is what removes
 * v1's stored "non-remitted total" entirely — a copy that, on a day document, silently became a
 * duplicate of the day's own total (docs/GLOSSARY.md).
 *
 * ⚠️ **`noSales` is not decoration.** Its v1 equivalent exists to *"let a reviewer tell
 * 'confirmed no sales' apart from 'forgot to fill this in'"* — the same distinction the cutover
 * wizard draws for a counted zero (T-134 B3). **An absent row and a zero row must not mean the
 * same thing**, so a confirmed-zero is a row with `noSales = true`.
 */
export const salesDayChannels = pgTable(
  'sales_day_channels',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    salesDayId: uuid('sales_day_id')
      .notNull()
      .references(() => salesDays.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => salesChannels.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
    /** True = the reporter explicitly confirmed no sales on this channel. */
    noSales: boolean('no_sales').notNull().default(false),
  },
  (t) => [
    uniqueIndex('sales_day_channels_sales_day_id_channel_id_unique').on(t.salesDayId, t.channelId),
    index('sales_day_channels_channel_id_idx').on(t.channelId),
    check('sales_day_channels_amount_non_negative_check', sql`${t.amount} >= 0`),
    /** A "confirmed no sales" row carrying money is a contradiction. */
    check('sales_day_channels_no_sales_is_zero_check', sql`${t.noSales} = false or ${t.amount} = 0`),
  ],
);
