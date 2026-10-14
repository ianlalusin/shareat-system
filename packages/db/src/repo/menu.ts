/**
 * T-401 S2 - the only place SQL is written for the ERP menu and catalog master. docs/tasks/401-erp-menu-catalog-master.md.
 *
 * Plain reads and writes on the ten tables of migration 0196 (`packages/db/schema/menu.ts`). No rule lives here: the domain
 * (`packages/domain/src/menu`) authorizes, validates, audits and decides; the database's triggers refuse what must never
 * happen (back-dating, UPDATE of history, an offer with no depletion rule). Every function takes the caller's transaction
 * first, so the audit row and the write commit or roll back together.
 *
 * "In force at t" is written ONCE, in SQL (K2): `menu_offer_in_force` / `menu_option_offer_in_force`. `offersInForce` and
 * `optionOffersInForce` call those functions; nothing here re-states the rule.
 *
 * Money is `numeric(14,2)` and travels as a string (bible section 6).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  menuCategories,
  menuDepletionRules,
  menuItems,
  menuItemVariants,
  menuOffers,
  menuOptionGroupLinks,
  menuOptionGroups,
  menuOptionOffers,
  menuOptionValues,
  menuPackageRefills,
  menuItemRequests,
} from '../../schema/menu';
import type {
  MenuChannel,
  MenuDepletionMode,
  MenuItemType,
  MenuPricingMode,
  MenuRequestStatus,
  MenuSelectionMode,
  MenuStatus,
} from '../../schema/menu';
import type { Decimal } from '@shareat/core/money';
import type { Tx } from '../client';

export type MenuCategoryRow = typeof menuCategories.$inferSelect;
export type MenuItemRow = typeof menuItems.$inferSelect;
export type MenuVariantRow = typeof menuItemVariants.$inferSelect;
export type MenuOptionGroupRow = typeof menuOptionGroups.$inferSelect;
export type MenuOptionValueRow = typeof menuOptionValues.$inferSelect;
export type MenuOptionGroupLinkRow = typeof menuOptionGroupLinks.$inferSelect;
export type MenuPackageRefillRow = typeof menuPackageRefills.$inferSelect;
export type MenuDepletionRuleRow = typeof menuDepletionRules.$inferSelect;
export type MenuOfferRow = typeof menuOffers.$inferSelect;
export type MenuOptionOfferRow = typeof menuOptionOffers.$inferSelect;
export type MenuItemRequestRow = typeof menuItemRequests.$inferSelect;

/**
 * An instant that survives a JavaScript `Date` round trip. `now()` carries microseconds, a `Date` carries milliseconds, so a
 * "from now" row read back as a `Date` would sit up to 1 ms BEFORE the database's own value and compare as not yet in force.
 * Rounding UP to the millisecond keeps the row at or after `now()` (the back-dating guard accepts it) and makes the stored
 * value exactly representable. Used only when the caller gave no `effectiveFrom`.
 */
const NOW_MS = sql`date_trunc('milliseconds', now() + interval '999 microseconds')`;

/** The database's clock, for refusing a back-dated or already-in-effect row with a sentence instead of a trigger message. */
export async function dbNow(tx: Tx): Promise<Date> {
  const rows = (await tx.execute(sql`select now() as t`)) as unknown as { t: string | Date }[];
  return new Date(rows[0]!.t);
}

/** The same instant a "from now" history row is stored at (`NOW_MS`): `now()` rounded up to the millisecond. */
export async function nowCeilMs(tx: Tx): Promise<Date> {
  const rows = (await tx.execute(sql`select ${NOW_MS} as t`)) as unknown as { t: string | Date }[];
  return new Date(rows[0]!.t);
}

/** Takes the per-id menu advisory lock (the one the database guards take), so a pre-check and the insert it guards cannot race. */
export async function lockKey(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`select menu_lock_key(${id}::uuid)`);
}

export type HistoryKey =
  | { kind: 'offer'; storeId: string; variantId: string; channel: MenuChannel }
  | { kind: 'option'; storeId: string; optionValueId: string; channel: MenuChannel }
  | { kind: 'rule'; variantId: string };

/**
 * Would a new row at `at` (omitted = "from now") break the history of its key? `same`: a row already sits at that exact instant;
 * `later`: a row is already scheduled after it (history is monotonic: it would never take effect). Call under `lockKey`.
 */
export async function historyClash(tx: Tx, key: HistoryKey, at?: Date): Promise<'same' | 'later' | null> {
  const x = at ? sql`${at.toISOString()}::timestamptz` : NOW_MS;
  const where =
    key.kind === 'offer'
      ? sql`from menu_offers where store_id = ${key.storeId} and variant_id = ${key.variantId} and channel = ${key.channel}`
      : key.kind === 'option'
        ? sql`from menu_option_offers where store_id = ${key.storeId} and option_value_id = ${key.optionValueId} and channel = ${key.channel}`
        : sql`from menu_depletion_rules where variant_id = ${key.variantId}`;
  const rows = (await tx.execute(
    sql`select count(*) filter (where effective_from = ${x})::int as same, count(*) filter (where effective_from > ${x})::int as later ${where}`,
  )) as unknown as { same: number; later: number }[];
  const r = rows[0]!;
  return r.same > 0 ? 'same' : r.later > 0 ? 'later' : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------------------------------
export async function getCategory(tx: Tx, orgId: string, id: string): Promise<MenuCategoryRow | undefined> {
  const [row] = await tx.select().from(menuCategories).where(and(eq(menuCategories.id, id), eq(menuCategories.orgId, orgId)));
  return row;
}

export async function findCategoryByName(tx: Tx, orgId: string, name: string): Promise<MenuCategoryRow | undefined> {
  const [row] = await tx
    .select()
    .from(menuCategories)
    .where(and(eq(menuCategories.orgId, orgId), sql`lower(${menuCategories.name}) = lower(${name})`));
  return row;
}

export async function insertCategory(
  tx: Tx,
  input: { orgId: string; name: string; parentId?: string | null; sortOrder?: number; createdBy: string },
): Promise<MenuCategoryRow> {
  const [row] = await tx.insert(menuCategories).values(input).returning();
  return row!;
}

export async function updateCategory(
  tx: Tx,
  id: string,
  patch: { name?: string; parentId?: string | null; sortOrder?: number; status?: MenuStatus },
): Promise<MenuCategoryRow> {
  const [row] = await tx
    .update(menuCategories)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(menuCategories.id, id))
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Items and variants
// ---------------------------------------------------------------------------------------------------------------------
/** `forUpdate` locks the row, so a check that reads its variants cannot interleave with another edit of the same item. */
export async function getItem(tx: Tx, orgId: string, id: string, forUpdate = false): Promise<MenuItemRow | undefined> {
  const q = tx.select().from(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.orgId, orgId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  return row;
}

export async function findItemByTypeAndName(
  tx: Tx,
  orgId: string,
  itemType: MenuItemType,
  name: string,
): Promise<MenuItemRow | undefined> {
  const [row] = await tx
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.orgId, orgId), eq(menuItems.itemType, itemType), sql`lower(${menuItems.name}) = lower(${name})`));
  return row;
}

export interface InsertItemInput {
  orgId: string;
  categoryId: string;
  name: string;
  description?: string | null;
  itemType: MenuItemType;
  soldALaCarte: boolean;
  soldInPackageSession: boolean;
  dinerOrderable: boolean;
  sortOrder?: number;
  createdBy: string;
}

export async function insertItem(tx: Tx, input: InsertItemInput): Promise<MenuItemRow> {
  const [row] = await tx.insert(menuItems).values(input).returning();
  return row!;
}

export interface ItemPatch {
  categoryId?: string;
  name?: string;
  description?: string | null;
  itemType?: MenuItemType;
  soldALaCarte?: boolean;
  soldInPackageSession?: boolean;
  dinerOrderable?: boolean;
  sortOrder?: number;
  status?: MenuStatus;
}

export async function updateItem(tx: Tx, id: string, patch: ItemPatch): Promise<MenuItemRow> {
  const [row] = await tx
    .update(menuItems)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(menuItems.id, id))
    .returning();
  return row!;
}

export async function getVariant(tx: Tx, orgId: string, id: string): Promise<MenuVariantRow | undefined> {
  const [row] = await tx.select().from(menuItemVariants).where(and(eq(menuItemVariants.id, id), eq(menuItemVariants.orgId, orgId)));
  return row;
}

export async function variantsOfItem(tx: Tx, orgId: string, menuItemId: string): Promise<MenuVariantRow[]> {
  return tx
    .select()
    .from(menuItemVariants)
    .where(and(eq(menuItemVariants.menuItemId, menuItemId), eq(menuItemVariants.orgId, orgId)))
    .orderBy(asc(menuItemVariants.sortOrder), asc(menuItemVariants.createdAt));
}

export async function insertVariant(
  tx: Tx,
  input: { orgId: string; menuItemId: string; label: string | null; isDefault: boolean; sortOrder?: number; createdBy: string },
): Promise<MenuVariantRow> {
  const [row] = await tx.insert(menuItemVariants).values(input).returning();
  return row!;
}

export async function updateVariant(
  tx: Tx,
  id: string,
  patch: { label?: string | null; sortOrder?: number; status?: MenuStatus },
): Promise<MenuVariantRow> {
  const [row] = await tx
    .update(menuItemVariants)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(menuItemVariants.id, id))
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Option groups, values, links
// ---------------------------------------------------------------------------------------------------------------------
export async function getOptionGroup(tx: Tx, orgId: string, id: string): Promise<MenuOptionGroupRow | undefined> {
  const [row] = await tx.select().from(menuOptionGroups).where(and(eq(menuOptionGroups.id, id), eq(menuOptionGroups.orgId, orgId)));
  return row;
}

export async function insertOptionGroup(
  tx: Tx,
  input: {
    orgId: string;
    name: string;
    selectionMode: MenuSelectionMode;
    minSelections: number;
    maxSelections: number;
    createdBy: string;
  },
): Promise<MenuOptionGroupRow> {
  const [row] = await tx.insert(menuOptionGroups).values(input).returning();
  return row!;
}

export async function updateOptionGroup(
  tx: Tx,
  id: string,
  patch: { name?: string; selectionMode?: MenuSelectionMode; minSelections?: number; maxSelections?: number; status?: MenuStatus },
): Promise<MenuOptionGroupRow> {
  const [row] = await tx
    .update(menuOptionGroups)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(menuOptionGroups.id, id))
    .returning();
  return row!;
}

export async function getOptionValue(tx: Tx, orgId: string, id: string): Promise<MenuOptionValueRow | undefined> {
  const [row] = await tx.select().from(menuOptionValues).where(and(eq(menuOptionValues.id, id), eq(menuOptionValues.orgId, orgId)));
  return row;
}

export async function insertOptionValue(
  tx: Tx,
  input: { orgId: string; optionGroupId: string; name: string; sortOrder?: number; createdBy: string },
): Promise<MenuOptionValueRow> {
  const [row] = await tx.insert(menuOptionValues).values(input).returning();
  return row!;
}

export async function updateOptionValue(
  tx: Tx,
  id: string,
  patch: { name?: string; sortOrder?: number; status?: MenuStatus },
): Promise<MenuOptionValueRow> {
  const [row] = await tx
    .update(menuOptionValues)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(menuOptionValues.id, id))
    .returning();
  return row!;
}

export async function getLink(tx: Tx, orgId: string, id: string): Promise<MenuOptionGroupLinkRow | undefined> {
  const [row] = await tx
    .select()
    .from(menuOptionGroupLinks)
    .where(and(eq(menuOptionGroupLinks.id, id), eq(menuOptionGroupLinks.orgId, orgId)));
  return row;
}

export async function insertLink(
  tx: Tx,
  input: { orgId: string; optionGroupId: string; menuItemId: string | null; variantId: string | null; sortOrder?: number; createdBy: string },
): Promise<MenuOptionGroupLinkRow> {
  const [row] = await tx.insert(menuOptionGroupLinks).values(input).returning();
  return row!;
}

export async function deleteLink(tx: Tx, id: string): Promise<void> {
  await tx.delete(menuOptionGroupLinks).where(eq(menuOptionGroupLinks.id, id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Package refills
// ---------------------------------------------------------------------------------------------------------------------
export async function refillItemIdsOfPackage(tx: Tx, orgId: string, packageVariantId: string): Promise<string[]> {
  const rows = await tx
    .select({ refillItemId: menuPackageRefills.refillItemId })
    .from(menuPackageRefills)
    .where(and(eq(menuPackageRefills.packageVariantId, packageVariantId), eq(menuPackageRefills.orgId, orgId)))
    .orderBy(asc(menuPackageRefills.refillItemId));
  return rows.map((r) => r.refillItemId);
}

export async function insertPackageRefills(
  tx: Tx,
  input: { orgId: string; packageVariantId: string; refillItemIds: string[]; createdBy: string },
): Promise<void> {
  if (input.refillItemIds.length === 0) return;
  await tx.insert(menuPackageRefills).values(
    input.refillItemIds.map((refillItemId) => ({
      orgId: input.orgId,
      packageVariantId: input.packageVariantId,
      refillItemId,
      createdBy: input.createdBy,
    })),
  );
}

export async function deletePackageRefills(tx: Tx, packageVariantId: string, refillItemIds: string[]): Promise<void> {
  if (refillItemIds.length === 0) return;
  await tx
    .delete(menuPackageRefills)
    .where(and(eq(menuPackageRefills.packageVariantId, packageVariantId), inArray(menuPackageRefills.refillItemId, refillItemIds)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Depletion rules (history: insert, and delete of a scheduled one only)
// ---------------------------------------------------------------------------------------------------------------------
export interface InsertRuleInput {
  orgId: string;
  variantId: string;
  /** Omitted = "from now" (rounded up to the millisecond, see NOW_MS). */
  effectiveFrom?: Date;
  mode: MenuDepletionMode;
  itemId: string | null;
  recipeId: string | null;
  /** `numeric(14,6)` as text, or null. */
  quantityPerSale: Decimal<'14,6'> | null;
  createdBy: string;
}

export async function insertRule(tx: Tx, input: InsertRuleInput): Promise<MenuDepletionRuleRow> {
  const [row] = await tx
    .insert(menuDepletionRules)
    .values({
      orgId: input.orgId,
      variantId: input.variantId,
      effectiveFrom: input.effectiveFrom ?? NOW_MS,
      mode: input.mode,
      itemId: input.itemId,
      recipeId: input.recipeId,
      quantityPerSale: input.quantityPerSale,
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

export async function getRule(tx: Tx, orgId: string, id: string): Promise<MenuDepletionRuleRow | undefined> {
  const [row] = await tx.select().from(menuDepletionRules).where(and(eq(menuDepletionRules.id, id), eq(menuDepletionRules.orgId, orgId)));
  return row;
}

export async function deleteRule(tx: Tx, id: string): Promise<void> {
  await tx.delete(menuDepletionRules).where(eq(menuDepletionRules.id, id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Offers and option offers (history: insert, and delete of a scheduled one only)
// ---------------------------------------------------------------------------------------------------------------------
export interface InsertOfferInput {
  orgId: string;
  storeId: string;
  variantId: string;
  channel: MenuChannel;
  /** Omitted = "from now" (rounded up to the millisecond, see NOW_MS). */
  effectiveFrom?: Date;
  /** `numeric(14,2)` as text; null on a withdrawn row or a refill. */
  amount: Decimal<'14,2'> | null;
  bundleHeads: number | null;
  extraHeadAmount: Decimal<'14,2'> | null;
  withdrawn: boolean;
  /** R15: `fixed` (default) or an online rule; a rule row carries `markupPercent` / `fixedMarkupAmount` and no amount. */
  pricingMode?: MenuPricingMode;
  /** `numeric(8,4)` as text, signed, above -100. */
  markupPercent?: Decimal<'8,4'> | null;
  /** `numeric(14,2)` as text, signed. */
  fixedMarkupAmount?: Decimal<'14,2'> | null;
  createdBy: string;
}

export async function insertOffer(tx: Tx, input: InsertOfferInput): Promise<MenuOfferRow> {
  const [row] = await tx
    .insert(menuOffers)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      variantId: input.variantId,
      channel: input.channel,
      effectiveFrom: input.effectiveFrom ?? NOW_MS,
      amount: input.amount,
      bundleHeads: input.bundleHeads,
      extraHeadAmount: input.extraHeadAmount,
      withdrawn: input.withdrawn,
      pricingMode: input.pricingMode,
      markupPercent: input.markupPercent,
      fixedMarkupAmount: input.fixedMarkupAmount,
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

export async function getOffer(tx: Tx, orgId: string, id: string): Promise<MenuOfferRow | undefined> {
  const [row] = await tx.select().from(menuOffers).where(and(eq(menuOffers.id, id), eq(menuOffers.orgId, orgId)));
  return row;
}

export async function deleteOffer(tx: Tx, id: string): Promise<void> {
  await tx.delete(menuOffers).where(eq(menuOffers.id, id));
}

export interface InsertOptionOfferInput {
  orgId: string;
  storeId: string;
  optionValueId: string;
  channel: MenuChannel;
  effectiveFrom?: Date;
  /** Signed `numeric(14,2)` as text; null only on a withdrawn row. */
  priceDelta: Decimal<'14,2'> | null;
  withdrawn: boolean;
  createdBy: string;
}

export async function insertOptionOffer(tx: Tx, input: InsertOptionOfferInput): Promise<MenuOptionOfferRow> {
  const [row] = await tx
    .insert(menuOptionOffers)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      optionValueId: input.optionValueId,
      channel: input.channel,
      effectiveFrom: input.effectiveFrom ?? NOW_MS,
      priceDelta: input.priceDelta,
      withdrawn: input.withdrawn,
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

export async function getOptionOffer(tx: Tx, orgId: string, id: string): Promise<MenuOptionOfferRow | undefined> {
  const [row] = await tx.select().from(menuOptionOffers).where(and(eq(menuOptionOffers.id, id), eq(menuOptionOffers.orgId, orgId)));
  return row;
}

export async function deleteOptionOffer(tx: Tx, id: string): Promise<void> {
  await tx.delete(menuOptionOffers).where(eq(menuOptionOffers.id, id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads: what is offered, and the history
// ---------------------------------------------------------------------------------------------------------------------
/** A price row as stored, in the shape `resolveOfferPrice` reads. Money is 2-decimal text, the percent 4-decimal text. */
export interface OfferPriceFields {
  readonly withdrawn: boolean;
  readonly pricingMode: MenuPricingMode;
  /** Unit price, per-head price, or bundle price; null on a refill, a withdrawn row, or a rule row. */
  readonly amount: string | null;
  readonly bundleHeads: number | null;
  readonly extraHeadAmount: string | null;
  readonly markupPercent: string | null;
  readonly fixedMarkupAmount: string | null;
}

/**
 * The row in force for one variant and channel, withdrawn rows INCLUDED (`withdrawn` says so). An ONLINE row carries `basis`: the
 * STORE-channel row in force at the SAME `at` (null when the store has none), which a rule is computed from (R15).
 */
export interface OfferInForce extends OfferPriceFields {
  readonly id: string;
  readonly variantId: string;
  readonly channel: MenuChannel;
  readonly effectiveFrom: Date;
  readonly basis: OfferPriceFields | null;
}

export interface OptionOfferInForce {
  readonly id: string;
  readonly optionValueId: string;
  readonly channel: MenuChannel;
  /** Signed 2-decimal text. */
  readonly priceDelta: string;
  readonly effectiveFrom: Date;
}

type Raw = Record<string, unknown>;

const priceFields = (r: Raw, p: string): OfferPriceFields => ({
  withdrawn: Boolean(r[`${p}withdrawn`]),
  pricingMode: r[`${p}pricing_mode`] as MenuPricingMode,
  amount: r[`${p}amount`] == null ? null : String(r[`${p}amount`]),
  bundleHeads: r[`${p}bundle_heads`] == null ? null : Number(r[`${p}bundle_heads`]),
  extraHeadAmount: r[`${p}extra_head_amount`] == null ? null : String(r[`${p}extra_head_amount`]),
  markupPercent: r[`${p}markup_percent`] == null ? null : String(r[`${p}markup_percent`]),
  fixedMarkupAmount: r[`${p}fixed_markup_amount`] == null ? null : String(r[`${p}fixed_markup_amount`]),
});

/**
 * The newest row at or before `at` for each variant and channel of a store (via `menu_offer_in_force`), withdrawals included;
 * a variant with no row at all is absent. An online row comes with its store basis from the same function at the same `at`.
 * Whether a row means "offered", and at what price, is `resolveOfferPrice`'s decision in the domain.
 */
export async function offersInForce(tx: Tx, storeId: string, at: Date): Promise<OfferInForce[]> {
  const when = at.toISOString();
  const rows = (await tx.execute(sql`
    select f.id, f.variant_id, f.channel, f.effective_from, f.withdrawn, f.pricing_mode, f.amount::text as amount, f.bundle_heads,
           f.extra_head_amount::text as extra_head_amount, f.markup_percent::text as markup_percent,
           f.fixed_markup_amount::text as fixed_markup_amount,
           b.id as b_id, b.withdrawn as b_withdrawn, b.pricing_mode as b_pricing_mode, b.amount::text as b_amount,
           b.bundle_heads as b_bundle_heads, b.extra_head_amount::text as b_extra_head_amount,
           b.markup_percent::text as b_markup_percent, b.fixed_markup_amount::text as b_fixed_markup_amount
      from (select distinct variant_id, channel from menu_offers where store_id = ${storeId} and effective_from <= ${when}::timestamptz) k
     cross join lateral menu_offer_in_force(${storeId}, k.variant_id, k.channel, ${when}::timestamptz) f
      left join lateral menu_offer_in_force(${storeId}, k.variant_id, 'store', ${when}::timestamptz) b on k.channel = 'online'
     order by f.variant_id, f.channel
  `)) as unknown as Raw[];
  return rows.map((r) => ({
    id: String(r.id),
    variantId: String(r.variant_id),
    channel: r.channel as MenuChannel,
    effectiveFrom: new Date(r.effective_from as string),
    ...priceFields(r, ''),
    basis: r.b_id == null ? null : priceFields(r, 'b_'),
  }));
}

/** Same rule for option-value deltas, per channel: no row in force, or a withdrawn one, means not offered there. */
export async function optionOffersInForce(tx: Tx, storeId: string, at: Date): Promise<OptionOfferInForce[]> {
  const rows = (await tx.execute(sql`
    select f.id, f.option_value_id, f.channel, f.price_delta::text as price_delta, f.effective_from
      from (select distinct option_value_id, channel from menu_option_offers where store_id = ${storeId} and effective_from <= ${at.toISOString()}::timestamptz) k
     cross join lateral menu_option_offer_in_force(${storeId}, k.option_value_id, k.channel, ${at.toISOString()}::timestamptz) f
     where not f.withdrawn
     order by f.option_value_id, f.channel
  `)) as unknown as Raw[];
  return rows.map((r) => ({
    id: String(r.id),
    optionValueId: String(r.option_value_id),
    channel: r.channel as MenuChannel,
    priceDelta: String(r.price_delta),
    effectiveFrom: new Date(r.effective_from as string),
  }));
}

/** Every offer row for one variant at one store (both channels, withdrawals and scheduled changes included), newest first. */
export async function offerHistory(tx: Tx, storeId: string, variantId: string): Promise<MenuOfferRow[]> {
  return tx
    .select()
    .from(menuOffers)
    .where(and(eq(menuOffers.storeId, storeId), eq(menuOffers.variantId, variantId)))
    .orderBy(desc(menuOffers.effectiveFrom), asc(menuOffers.channel));
}

// ---------------------------------------------------------------------------------------------------------------------
// Item requests (R14): a manager asks for an item; a super admin resolves it once
// ---------------------------------------------------------------------------------------------------------------------
export async function getRequest(tx: Tx, orgId: string, id: string, forUpdate = false): Promise<MenuItemRequestRow | undefined> {
  const q = tx.select().from(menuItemRequests).where(and(eq(menuItemRequests.id, id), eq(menuItemRequests.orgId, orgId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  return row;
}

export async function insertRequest(
  tx: Tx,
  input: { orgId: string; storeId: string; requestedBy: string; name: string; itemType: MenuItemType; categoryId: string | null; note: string | null },
): Promise<MenuItemRequestRow> {
  const [row] = await tx
    .insert(menuItemRequests)
    .values({ ...input, createdBy: input.requestedBy })
    .returning();
  return row!;
}

/** The one status move a request makes (open -> approved | duplicate | rejected | withdrawn); the trigger refuses a second. */
export async function resolveRequest(
  tx: Tx,
  id: string,
  patch: { status: Exclude<MenuRequestStatus, 'open'>; resolvedBy: string; resolvedItemId?: string | null; resolutionNote?: string | null },
): Promise<MenuItemRequestRow> {
  const [row] = await tx
    .update(menuItemRequests)
    .set({
      status: patch.status,
      resolvedBy: patch.resolvedBy,
      resolvedItemId: patch.resolvedItemId ?? null,
      resolutionNote: patch.resolutionNote ?? null,
      resolvedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(menuItemRequests.id, id))
    .returning();
  return row!;
}

export interface SimilarMenuItem {
  readonly id: string;
  readonly name: string;
  readonly itemType: MenuItemType;
  /** 1 for a normalised exact-name match, else the pg_trgm similarity (at least 0.4). */
  readonly similarity: number;
}

/**
 * The duplicate check (R14c), deterministic: a normalised exact name (case and whitespace) first, then `pg_trgm` similarity at
 * or above 0.4. Active and retired items both count (a retired one is still the thing being asked for). Best match first.
 */
export async function similarMenuItems(tx: Tx, orgId: string, name: string, limit = 5): Promise<SimilarMenuItem[]> {
  const rows = (await tx.execute(sql`
    select id, name, item_type,
           case when regexp_replace(lower(trim(name)), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(trim(${name}::text)), '[[:space:]]+', ' ', 'g')
                then 1.0 else similarity(lower(name), lower(${name}::text)) end as score
      from menu_items
     where org_id = ${orgId}
       and (regexp_replace(lower(trim(name)), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(trim(${name}::text)), '[[:space:]]+', ' ', 'g')
            or similarity(lower(name), lower(${name}::text)) >= 0.4)
     order by score desc, name
     limit ${limit}
  `)) as unknown as Raw[];
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), itemType: r.item_type as MenuItemType, similarity: Number(r.score) }));
}

export interface SimilarOpenRequest {
  readonly id: string;
  readonly name: string;
  readonly itemType: MenuItemType;
}

/**
 * Open (not yet decided) item requests whose name looks like `name`: the same normalised-exact-or-trigram test as
 * `similarMenuItems`, so a second manager does not file what a first already asked for.
 */
export async function similarOpenRequests(tx: Tx, orgId: string, name: string, limit = 5): Promise<SimilarOpenRequest[]> {
  const rows = (await tx.execute(sql`
    select id, name, item_type,
           case when regexp_replace(lower(trim(name)), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(trim(${name}::text)), '[[:space:]]+', ' ', 'g')
                then 1.0 else similarity(lower(name), lower(${name}::text)) end as score
      from menu_item_requests
     where org_id = ${orgId} and status = 'open'
       and (regexp_replace(lower(trim(name)), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(trim(${name}::text)), '[[:space:]]+', ' ', 'g')
            or similarity(lower(name), lower(${name}::text)) >= 0.4)
     order by score desc, name
     limit ${limit}
  `)) as unknown as Raw[];
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), itemType: r.item_type as MenuItemType }));
}
