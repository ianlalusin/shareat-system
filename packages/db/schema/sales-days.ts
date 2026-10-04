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
import { boolean, check, date, foreignKey, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { moneyAccounts } from './money-accounts';
import { posV1DayFeeds } from './pos-v1';

// -------------------------------------------------------------------------------------
// sales_channels — per-store configuration. v1's Store.salesChannels[], as rows.
// -------------------------------------------------------------------------------------

/**
 * ⭐ T-230 / bible §13 row 180. Whether a wastage recorded against this channel enters the charge
 * lifecycle. **The CHANNEL decides, not the person recording the loss** — `order_wastages.type_mode`
 * is derived from this column and is no longer something a caller may state.
 *
 * ⚠️ This is the ONE declaration of the set. `ORDER_WASTAGE_TYPE_MODES` in `order-wastage.ts` is
 * derived from it rather than restated, so the policy and the record it produces cannot drift.
 */
export const SALES_CHANNEL_WASTAGE_MODES = ['tracked', 'instant'] as const;
export type SalesChannelWastageMode = (typeof SALES_CHANNEL_WASTAGE_MODES)[number];

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
    /**
     * ⭐ T-150. Where this channel's payout lands. Per-channel CONFIG, not a constant: Grab and
     * Foodpanda do not have to bank into the same account, and hard-coding one would be wrong the
     * first time they differ.
     */
    /** ⚠️ The FK is declared here as well as in migration `0057`, which already created it. The
     *  schema file is where a table is DEFINED (bible §8), and a constraint that exists only in
     *  the migration is a constraint the definition does not know about — exactly the drift
     *  `db:generate` would one day "fix" by dropping it (DEF-073). */
    destinationMoneyAccountId: uuid('destination_money_account_id').references(() => moneyAccounts.id, {
      onDelete: 'restrict',
    }),
    /**
     * ⭐ T-150 §7. Withholding tax is booked to `6800 Taxes and licences` — an EXPENSE, not an
     * asset. RR 2-98 §2.58.3(B): a creditable withholding tax may be claimed only when the income
     * payment has been declared as part of gross income with the 2307 attached. Bible §13 row 75
     * records that reported sales are not all sales and this ledger is never a filing basis, so
     * the credit cannot be realised — and an asset is a resource from which future benefit is
     * expected. There is none.
     *
     * ⛔ No `1270` creditable-withholding asset is seeded: an account that exists invites someone
     * to use it, and an unrealisable asset is worse than no account. This flag decides which
     * account the leg hits if that posture ever changes.
     */
    taxTreatment: text('tax_treatment', { enum: ['expense', 'creditable'] as const }).notNull().default('expense'),
    /**
     * ⭐ T-230, bible §13 row 180 — tracked-vs-instant is a per-channel POLICY, not a per-record
     * choice. `tracked` gets a Wastage Monitor, a 48-hour dispute window and the 15-day
     * auto-charge backstop; `instant` books the disposition in the same call.
     *
     * ⚠️ **NOT NULL with a default, unlike `is_remitted_daily` immediately above — and the
     * difference is the point.** There is no safe value for remittance behaviour, so that column
     * refuses to have one. There IS a safe value here: `tracked` keeps every control, `instant`
     * removes them, and a default that silently disables a control would be the wrong default.
     */
    wastageTypeMode: text('wastage_type_mode', { enum: SALES_CHANNEL_WASTAGE_MODES })
      .notNull()
      .default('tracked'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // NOTE: uniqueness is `(org_id, store_id, lower(trim(name)))` — case- and whitespace-
    // INSENSITIVE, bible §4.4 rule 3, DEF-205. That is an expression index Drizzle's builder
    // cannot express; it is hand-added in migration 0133, exactly as `positions`
    // (`employment.ts:126-134`) already documents for its own identity rule.
    // ⛔ Do NOT restore a `uniqueIndex(...)` line here. The builder can only express the
    // case-SENSITIVE version, and `db:generate` would then "fix" the drift by dropping the
    // correct index and recreating the broken one (DEF-073's shape).
    // ⚠️ It spans ACTIVE AND INACTIVE rows on purpose: `findChannelByName` resolves with `limit 1`
    // and no ordering, so two rows sharing a name — one retired, one live — would make which
    // receivable a wastage posts against a matter of which row Postgres happened to return.
    index('sales_channels_org_id_store_id_idx').on(t.orgId, t.storeId),
    // A non-remitted channel MUST name where its receivable goes. DEF-059 is what happens when a
    // channel's wiring is allowed to be absent: the money is silently lost rather than refused.
    check(
      'sales_channels_non_remitted_needs_receivable_check',
      sql`${t.isRemittedDaily} = true or ${t.receivableAccountCode} is not null`,
    ),
    check(
      'sales_channels_wastage_type_mode_check',
      sql`${t.wastageTypeMode} in ('tracked', 'instant')`,
    ),
    // T-357 / DEF-490, migration 0171 — the single-column FK above accepts a cross-org account
    // (RLS checks only this row's own org_id; the FK check runs as the table owner). MATCH SIMPLE
    // (Drizzle's default, unwritten): a NULL destination skips this FK entirely, so "no account
    // chosen yet" is still representable. References `money_accounts_org_id_id_unique`
    // (`schema/money-accounts.ts` — hand-added in migration 0171).
    foreignKey({
      columns: [t.orgId, t.destinationMoneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'sales_channels_destination_money_account_id_same_org_fk',
    }).onDelete('restrict'),
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

    /** T-375 S1 (migration 0183, R1): where the figures came from. `legacy_typed` is today's typed path (a store
     *  not yet linked to POS); `pos_v1_day_feed` is a day DERIVED from a stored POS response. Kept by 0184. */
    source: text('source', { enum: ['legacy_typed', 'pos_v1_day_feed'] as const }).notNull().default('legacy_typed'),
    /** The `sales` feed the day was derived from; non-null iff `source = 'pos_v1_day_feed'`. */
    posV1DayFeedId: uuid('pos_v1_day_feed_id').references(() => posV1DayFeeds.id, { onDelete: 'restrict' }),
    /** T-375 (W11): POS refunds of the day, contra-revenue 4950 - never comps. Feed days only. */
    refunds: numeric('refunds', { precision: 14, scale: 2 }).notNull().default('0'),

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
    /** ⚠️ Senior and PWD are broken out because the statutes require it, not for reporting taste
     *  (discovery 24 §4). Sales to SC/PWD are VAT-exempt and the burden of proof is on the seller.
     *  ⚠️ **TWO regulations, not one** (bible row 164): RR 5-2017 is PWD-only; the senior half is
     *  RR 7-2010, with an OSCA ID rather than a PWD ID.
     *  ⛔ **A per-transaction record is also mandatory and these daily totals cannot satisfy it.**
     *  It lives in `statutory_discount_records` (T-137), which is a PARALLEL record and posts
     *  nothing — these columns remain the only route to 4900 (bible rows 75, 132).
     *  ⛔ **And it is not being kept today, in software or on paper** — Ian, 2026-08-29: the
     *  customer presents an ID and the cashier picks a configured discount, so nothing records the
     *  holder's name, ID number or invoice. That is a live exposure, not a backlog item. */
    seniorDiscount: numeric('senior_discount', { precision: 14, scale: 2 }).notNull().default('0'),
    pwdDiscount: numeric('pwd_discount', { precision: 14, scale: 2 }).notNull().default('0'),
    otherDiscount: numeric('other_discount', { precision: 14, scale: 2 }).notNull().default('0'),
    /** -> 4950 Sales returns and voids, NEVER 4900 and never a marketing expense. Ian confirmed
     *  directly: comps are revenue foregone, not a cost incurred (bible row 74). */
    comps: numeric('comps', { precision: 14, scale: 2 }).notNull().default('0'),

    // ── Charges. ⛔ Two kinds, OPPOSITE in the books ──────────────────────────────────
    /** ⛔ -> 2160, a LIABILITY. RA 11360 sends 100% of service charge to rank-and-file employees
     *  at least twice a month, so the business collects it as an agent and keeps none of it.
     *  Booking it as income would overstate profit and hide a payable (bible row 134). */
    serviceCharge: numeric('service_charge', { precision: 14, scale: 2 }).notNull().default('0'),
    /** -> 4500, INCOME. Leftover, packaging and similar — Ian: "all in one account, separated
     *  from service charge." The business keeps these, which is the whole difference. */
    otherCharges: numeric('other_charges', { precision: 14, scale: 2 }).notNull().default('0'),

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
    /** ⭐ ONE LIVE report per store per business date — and this is what makes the create-block
     *  (bible row 126) meaningful. Without it, "an older day is unverified" is ambiguous.
     *  T-369 S7 (Ian Q1): a VOIDED day no longer counts, so its date can be entered again (by a manager,
     *  `createSalesDay`); a date may hold any number of voided days. Partial since migration 0177. */
    uniqueIndex('sales_days_org_id_store_id_business_date_unique')
      .on(t.orgId, t.storeId, t.businessDate)
      .where(sql`${t.status} <> 'voided'`),
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
      and ${t.comps} >= 0 and ${t.serviceCharge} >= 0 and ${t.otherCharges} >= 0
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
    // T-375 S1 (migration 0183, R6): the shapes of a feed-sourced day.
    check('sales_days_source_check', sql`${t.source} in ('legacy_typed', 'pos_v1_day_feed')`),
    check('sales_days_source_feed_id_check', sql`(${t.source} = 'pos_v1_day_feed') = (${t.posV1DayFeedId} is not null)`),
    check('sales_days_feed_source_pos_sourced_check', sql`${t.source} <> 'pos_v1_day_feed' or ${t.posSourced}`),
    check('sales_days_refunds_only_on_feed_days_check', sql`${t.source} = 'pos_v1_day_feed' or ${t.refunds} = 0`),
    check('sales_days_refunds_non_negative_check', sql`${t.refunds} >= 0`),
    check('sales_days_refunds_finite_check', sql`${t.refunds} > '-Infinity'::numeric and ${t.refunds} < 'Infinity'::numeric`),
    index('sales_days_pos_v1_day_feed_id_idx').on(t.posV1DayFeedId),
    check('sales_days_total_sales_finite_check', sql`${t.totalSales} > '-Infinity'::numeric and ${t.totalSales} < 'Infinity'::numeric`),
    check('sales_days_unli_sales_finite_check', sql`${t.unliSales} > '-Infinity'::numeric and ${t.unliSales} < 'Infinity'::numeric`),
    check('sales_days_ala_carte_sales_finite_check', sql`${t.alaCarteSales} > '-Infinity'::numeric and ${t.alaCarteSales} < 'Infinity'::numeric`),
    check('sales_days_senior_discount_finite_check', sql`${t.seniorDiscount} > '-Infinity'::numeric and ${t.seniorDiscount} < 'Infinity'::numeric`),
    check('sales_days_pwd_discount_finite_check', sql`${t.pwdDiscount} > '-Infinity'::numeric and ${t.pwdDiscount} < 'Infinity'::numeric`),
    check('sales_days_other_discount_finite_check', sql`${t.otherDiscount} > '-Infinity'::numeric and ${t.otherDiscount} < 'Infinity'::numeric`),
    check('sales_days_comps_finite_check', sql`${t.comps} > '-Infinity'::numeric and ${t.comps} < 'Infinity'::numeric`),
    check('sales_days_service_charge_finite_check', sql`${t.serviceCharge} > '-Infinity'::numeric and ${t.serviceCharge} < 'Infinity'::numeric`),
    check('sales_days_other_charges_finite_check', sql`${t.otherCharges} > '-Infinity'::numeric and ${t.otherCharges} < 'Infinity'::numeric`),
    check('sales_days_cash_collected_finite_check', sql`${t.cashCollected} > '-Infinity'::numeric and ${t.cashCollected} < 'Infinity'::numeric`),
    check('sales_days_online_collected_finite_check', sql`${t.onlineCollected} > '-Infinity'::numeric and ${t.onlineCollected} < 'Infinity'::numeric`),
    check('sales_days_credit_sales_finite_check', sql`${t.creditSales} > '-Infinity'::numeric and ${t.creditSales} < 'Infinity'::numeric`),
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
    check('sales_day_channels_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
  ],
);


/**
 * ⭐ WHERE THE MONEY LANDED — one row per money account the day's online tender went into.
 * DEF-068, ADR-010, bible row 148.
 *
 * ## ⚠️ This is NOT `sales_day_channels`, and confusing the two is the whole point of this comment
 *
 * They are orthogonal axes and a day needs both:
 *
 * | | Answers | Used for |
 * |---|---|---|
 * | `sales_day_channels` | Where the sale came FROM — Walk-in, Foodpanda | Revenue and receivables |
 * | **this table** | Where the money WENT — GCash-cashier, BDO-office | **Custody** |
 *
 * A Foodpanda sale can settle into any wallet, so neither answers the other's question.
 *
 * ## Why it exists
 *
 * v2 recorded ONE `online_collected` figure and posted it to `1140` undifferentiated, which made
 * ADR-010's headline question — *"how much online money is in the cashier's hands versus the
 * office's"* — unanswerable on the side that matters most, since collections are the largest
 * inflow. v1 never had this problem: its sale builder takes `onlineBreakdown` as
 * `Record<accountId, amount>` and posts a leg per account.
 *
 * ⭐ **The data was never missing.** Ian: *"the cashier POS has this — it defines which mode of
 * payment is used by customer."* POS captures it at the till; T-123 did not carry it across.
 */
export const salesDayTenders = pgTable(
  'sales_day_tenders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    salesDayId: uuid('sales_day_id')
      .notNull()
      .references(() => salesDays.id, { onDelete: 'cascade' }),
    /** ⚠️ `restrict`, not `cascade` — a wallet that has received money can never be deleted, only
     *  retired. Deleting it would orphan the day's tender exactly as v1's hard-deletes orphan
     *  journal legs (DEF-065). */
    moneyAccountId: uuid('money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
  },
  (t) => [
    uniqueIndex('sales_day_tenders_sales_day_id_money_account_id_unique').on(
      t.salesDayId,
      t.moneyAccountId,
    ),
    index('sales_day_tenders_money_account_id_idx').on(t.moneyAccountId),
    /** ⛔ Strictly positive, unlike a channel row. A channel may legitimately be zero — the
     *  reporter confirming "no Foodpanda sales today" is information. A tender row of zero says
     *  money went into a wallet and the amount was nothing, which is not a fact about anything;
     *  the row simply should not exist. */
    check('sales_day_tenders_amount_positive_check', sql`${t.amount} > 0`),
    check('sales_day_tenders_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
  ],
);
