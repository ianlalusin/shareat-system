/**
 * fixed_assets + asset_policy + asset_category_lives. docs/tasks/124-fixed-assets-and-depreciation.md.
 *
 * ## ⛔ What is NOT here, and that is the whole point
 *
 * **No `accumulated_depreciation`. No `book_value`. No `monthly_depreciation`.**
 *
 * v1 stores all three on the asset and increments them alongside the journal entry
 * (`depreciation.actions.ts:160`), which is two sources of truth for one number — and **DEF-044
 * proves they diverge**: when v1's depreciation stopped silently for two months, every asset's
 * stored figure disagreed with the ledger by two months' worth, and the register still looked
 * fine because nothing compared them.
 *
 * Here all three are **derived from the ledger**: accumulated is the sum of that asset's
 * depreciation postings, book value is `cost − accumulated`, and the periodic charge is computed
 * from cost, salvage and life. **Nothing is incremented, so nothing can drift**, and a missed run
 * shows up as a smaller number rather than as a lie.
 *
 * ## ⭐ Per-asset traceability without a party
 *
 * v1 carries per-asset detail in legacy per-entity accounts (`asset__{id}`, `contra_asset__{id}`).
 * v2's party dimension cannot express that — `journal_lines.party_type` is
 * `supplier|customer|employee|store|channel` and **there is no `asset`**.
 *
 * It does not need one. **Depreciation posts ONE ENTRY PER ASSET PER PERIOD**, with
 * `source_type = 'depreciation'` and `source_id = the asset` — so *"which asset is this ₱4,000
 * for?"* is answered by the entry itself, exactly as an expense's entry names its expense. Adding
 * an `asset` party type would have been a schema change bought nothing.
 *
 * ## The accounts, which already exist
 *
 *   1510 Property and equipment · **1590 Accumulated depreciation (contra-asset, credit-normal)**
 *   6700 Depreciation · 7400 Loss on disposal of assets
 *
 * ⚠️ 1590 is a CONTRA-ASSET, not a reduction of 1510. Cost stays visible at cost for the asset's
 * whole life and the contra account carries what has been consumed — netting them would destroy
 * the first figure an auditor asks for.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { expenses } from './expenses';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/** v1's categories, ported unchanged — they are the vocabulary the business already uses, and
 *  T-134's December walk-round will be organised by them. */
export const ASSET_CATEGORIES = [
  'building',
  'machinery',
  'equipment',
  'furniture_and_fixture',
  'appliances',
  'vehicles',
  'smallwares',
] as const;

// -------------------------------------------------------------------------------------
// Policy — read, never defaulted silently
// -------------------------------------------------------------------------------------

/**
 * One row per org. **The capitalisation threshold and the salvage default.**
 *
 * ⭐ **Its absence must STOP a posting, not fall back.** v1 gets this exactly right and says why:
 * *"Could not read the capitalization policy, so this CAPEX purchase was not recorded — posting it
 * now would capitalize the asset on default terms instead of yours"*, because the silent fallback
 * *"understates depreciation by ~60% on everything capitalized."* Somebody computed the cost of
 * the wrong answer and then refused to let it happen. **Ported deliberately** (bible row 139).
 */
export const assetPolicy = pgTable(
  'asset_policy',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⭐ ₱10,000 (Ian, 2026-08-26 — bible row 139), doubling v1's ₱5,000. Nothing prescribes a
     *  threshold; it is a materiality decision, and here it also sets how many rows a person
     *  must physically stand in front of during the December walk-round (T-134 B2). */
    capitalizationThreshold: numeric('capitalization_threshold', { precision: 14, scale: 2 }).notNull(),
    /** Zero by default — conservative, since it depreciates the full cost and never overstates
     *  the asset. Overridden per asset where a resale value is genuinely known. */
    defaultSalvageValue: numeric('default_salvage_value', { precision: 14, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('asset_policy_org_id_unique').on(t.orgId),
    check('asset_policy_threshold_positive_check', sql`${t.capitalizationThreshold} > 0`),
    check('asset_policy_salvage_non_negative_check', sql`${t.defaultSalvageValue} >= 0`),
  ],
);

/**
 * Useful life per category (bible row 139).
 *
 * ⭐ **The question a life answers is "how long until we would realistically REPLACE it?"** — never
 * "how long could it last", which is a manufacturer's brochure. Three drivers: physical wear (a
 * commercial kitchen is brutal in a way an office is not), obsolescence, and — the one most
 * businesses forget — **aesthetic life: a dining room is refreshed long before its chairs break.**
 *
 * Proposed: building 20 · machinery 10 · equipment 7 · furniture 5 · appliances 5 · vehicles 5 ·
 * smallwares 3. ⚠️ **Awaiting the accountant's confirmation once**, then left alone: an estimate
 * that keeps moving is one nobody trusts.
 */
export const assetCategoryLives = pgTable(
  'asset_category_lives',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    category: text('category', { enum: ASSET_CATEGORIES }).notNull(),
    usefulLifeYears: integer('useful_life_years').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('asset_category_lives_org_id_category_unique').on(t.orgId, t.category),
    check('asset_category_lives_positive_check', sql`${t.usefulLifeYears} > 0`),
  ],
);

// -------------------------------------------------------------------------------------
// The register
// -------------------------------------------------------------------------------------

export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    category: text('category', { enum: ASSET_CATEGORIES }).notNull(),

    /** When it was acquired — depreciation starts from here, not from when the row was created.
     *  ⚠️ Nullable ONLY for the `pending_valuation` shell state below; a CHECK forbids it
     *  otherwise. */
    acquiredOn: date('acquired_on'),
    cost: numeric('cost', { precision: 14, scale: 2 }),
    salvageValue: numeric('salvage_value', { precision: 14, scale: 2 }).default('0'),
    /** Copied from the category default AT CAPITALISATION, not looked up at depreciation time.
     *  ⚠️ Deliberate: changing the org's default life must not silently rewrite the schedule of
     *  every asset already on the books. A life is a decision made once, about one asset. */
    usefulLifeYears: integer('useful_life_years').notNull(),

    /** ⭐ One method, and it is not laziness: **changing the depreciation method requires BIR
     *  approval** (discovery 25). A dropdown offering declining-balance would let someone create
     *  a filing obligation with a click. The column exists to make the assumption explicit. */
    method: text('method', { enum: ['straight_line'] }).notNull().default('straight_line'),
    interval: text('interval', { enum: ['monthly', 'quarterly', 'annually'] }).notNull().default('monthly'),

    /**
     * ⭐ **`pending_valuation` is the CUTOVER SHELL STATE, made explicit rather than left as a
     * NULL nobody notices.**
     *
     * ADR-007 classifies this table `keep_shell`: on 1 January the row survives — *a fridge does
     * not stop being a fridge* — but its cost is cleared and re-entered from the December
     * walk-round (T-134 B2). **Discovered while classifying: `cost` was NOT NULL, so the shell the
     * ADR describes could not physically exist.**
     *
     * The alternatives were making cost nullable with nothing guarding it (a live asset could
     * silently have no cost) or contradicting the ADR. **This is better than both**: the shell is
     * a named state, CHECKs keep the two shapes apart, depreciation skips anything not `active`,
     * and ⭐ **T-134's "what is still missing" list becomes a plain query** — every asset in
     * `pending_valuation` is exactly a row someone still has to value.
     */
    status: text('status', { enum: ['active', 'disposed', 'pending_valuation'] })
      .notNull()
      .default('active'),

    /**
     * ⭐ **v1's best idea in this module, ported exactly.** Set when an over-threshold CAPEX
     * expense auto-capitalises on default terms. **It depreciates immediately** — so the books are
     * never wrong by omission — **and stays visibly flagged until a human confirms the terms.**
     * It refuses the false choice between blocking the expense and silently guessing.
     */
    needsReview: boolean('needs_review').notNull().default(false),
    /** Back-link to the CAPEX expense that capitalised this (T-122's seam). */
    sourceExpenseId: uuid('source_expense_id').references(() => expenses.id, { onDelete: 'restrict' }),

    // ── Disposal ────────────────────────────────────────────────────────────────────
    disposedOn: date('disposed_on'),
    disposalReason: text('disposal_reason'),
    /** ⚠️ The LOSS is not stored — it is the remaining book value at disposal, and book value is
     *  derived. Storing it would be the same mistake as storing accumulated depreciation. */
    disposedBy: uuid('disposed_by').references(() => persons.id, { onDelete: 'restrict' }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('fixed_assets_org_id_store_id_idx').on(t.orgId, t.storeId),
    index('fixed_assets_org_id_status_idx').on(t.orgId, t.status),
    index('fixed_assets_category_idx').on(t.category),
    index('fixed_assets_needs_review_idx').on(t.needsReview),
    index('fixed_assets_source_expense_id_idx').on(t.sourceExpenseId),

    check('fixed_assets_cost_positive_check', sql`${t.cost} is null or ${t.cost} > 0`),
    check('fixed_assets_salvage_non_negative_check', sql`${t.salvageValue} is null or ${t.salvageValue} >= 0`),
    /** ⚠️ Salvage cannot reach cost, or the asset depreciates by zero or a negative amount and
     *  every figure downstream is nonsense. */
    check(
      'fixed_assets_salvage_below_cost_check',
      sql`${t.salvageValue} is null or ${t.cost} is null or ${t.salvageValue} < ${t.cost}`,
    ),
    check('fixed_assets_useful_life_positive_check', sql`${t.usefulLifeYears} > 0`),
    check('fixed_assets_status_check', sql`${t.status} in ('active', 'disposed', 'pending_valuation')`),
    /**
     * ⭐ **The two shapes, kept apart by the database rather than by intent.** A valued asset MUST
     * have cost and acquisition date; a shell MUST NOT — so a half-populated row cannot exist, and
     * `pending_valuation` cannot be quietly used as "active but we did not fill it in".
     */
    check(
      'fixed_assets_valuation_shape_check',
      sql`
        (${t.status} = 'pending_valuation' and ${t.cost} is null and ${t.acquiredOn} is null)
        or (${t.status} <> 'pending_valuation' and ${t.cost} is not null and ${t.acquiredOn} is not null)
      `,
    ),
    /** Disposal is all-or-nothing: a date with no reason cannot be explained to whoever asks,
     *  and a reason with no date has not happened. Same shape as the session end-pair. */
    check(
      'fixed_assets_disposal_pair_check',
      sql`
        (${t.status} = 'active' and ${t.disposedOn} is null and ${t.disposalReason} is null)
        or (${t.status} = 'disposed' and ${t.disposedOn} is not null and ${t.disposalReason} is not null)
      `,
    ),
    /** An asset cannot be disposed of before it was acquired. */
    check('fixed_assets_disposal_after_acquisition_check', sql`${t.disposedOn} is null or ${t.disposedOn} >= ${t.acquiredOn}`),
  ],
);
