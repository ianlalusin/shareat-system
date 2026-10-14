/**
 * Shared helpers for the /menu screens (T-401 S4). docs/tasks/401-erp-menu-catalog-master.md section 5.
 *
 * Two kinds of thing live here:
 *  - FORM helpers the server actions share: blank-means-not-sent text, whole numbers, UUID shape, the Manila reading of a
 *    `datetime-local` box, and `menuErrorMessage` (a database refusal that has no constraint name, said as a sentence).
 *  - READ helpers the pages share. They are plain reads inside the caller's `withOrgPrincipal`; every write goes through the
 *    domain (`@shareat/domain`, packages/domain/src/menu), which authorizes, validates and audits.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { accessRepo, menuRepo, refuse, schema, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { businessDayRange, parseBusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { errorMessage } from '@/lib/constraint-messages';

export { withOrgPrincipal } from '../expenses/lib';

// -------------------------------------------------------------------------------------------------------------------
// Form helpers
// -------------------------------------------------------------------------------------------------------------------
/** The field's text, trimmed; '' when absent. */
export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** The field's text, or undefined when it is absent or blank. A blank box means "not sent" (an empty price is not 0). */
export function opt(fd: FormData, key: string): string | undefined {
  const v = str(fd, key);
  return v === '' ? undefined : v;
}

/** A whole number from a box; undefined when blank. Anything else is a sentence. */
export function wholeNumber(fd: FormData, key: string, label: string): number | undefined {
  const v = opt(fd, key);
  if (v === undefined) return undefined;
  if (!/^-?\d{1,9}$/.test(v)) throw refuse(`menu form: ${key} is not a whole number.`, `${label} must be a whole number.`);
  return Number(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID.test(v);

/** A required id from a hidden field or a select: a sentence when it is missing or not an id. */
export function requireId(fd: FormData, key: string, sentence: string): string {
  const v = str(fd, key);
  if (!isUuid(v)) throw refuse(`menu form: ${key} is missing or not an id.`, sentence);
  return v;
}

/**
 * A `datetime-local` value (`YYYY-MM-DDTHH:mm`, seconds optional) read as ASIA/MANILA wall-clock and returned as the instant it is.
 * Blank or absent is "from now": undefined, and the action never sends the client clock (the database's `now()` decides).
 * 00:00 on 1 Dec 2030 in Manila is 2030-11-30T16:00:00Z. Never stored as a business date.
 */
export function manilaInstant(raw: string | undefined): Date | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const bad = () => refuse(`menu form: unreadable date and time ${JSON.stringify(raw)}.`, 'Enter the date and time like 2030-12-01 00:00 (Manila time), or leave it empty for right now.');
  // The clock ranges live in the pattern (00-23, 00-59), so no relational test on a number read from text is needed.
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(raw.trim());
  if (!m) throw bad();
  const hh = Number(m[2]);
  const mi = Number(m[3]);
  const ss = m[4] === undefined ? 0 : Number(m[4]);
  let day;
  try {
    day = parseBusinessDate(m[1] as string);
  } catch {
    throw bad();
  }
  return new Date(businessDayRange(day).start.getTime() + ((hh * 60 + mi) * 60 + ss) * 1000);
}

/**
 * Raw database refusals that carry NO constraint name (a hand-raised trigger message), said as sentences. The domain refuses
 * most of these first with its own sentence; these are the database's last word, so a race or an unforeseen path still reads
 * as a sentence and never as "The database refused that change". Anything not listed goes to the shared `errorMessage`.
 */
const TRIGGER_SENTENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/category cannot be retired: it still holds active items/i, 'This category still holds active items. Move them to another category or retire them first, then retire the category.'],
  [/needs a depletion rule in force/i, 'This item has no stock rule yet, so it cannot be priced. Set what a sale uses up (a stock item, a recipe, or nothing) on the item page first, then set the price.'],
  [/live fixed offer for a .* item needs an amount/i, 'Enter the price.'],
  [/refill offer carries no amount/i, 'A refill is a free serving a package entitles. It has no price.'],
  [/bundle pricing is only for a package/i, 'Bundle pricing is only for a package.'],
  [/cannot be retired while an offer/i, 'Withdraw its price at every store first, then retire it.'],
  [/item_type is fixed/i, "An item's type cannot change once it has a price or is used as a refill."],
  [/an active item keeps exactly one active default variant/i, 'An active item keeps exactly one active default variant.'],
  [/would be left with no depletion rule in force/i, 'A live price still relies on that rule. Withdraw the price first.'],
];

function rawTexts(err: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur instanceof Error; i += 1) {
    out.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

export function menuErrorMessage(err: unknown): string {
  const own = (err as { userMessage?: unknown } | null)?.userMessage;
  if (typeof own !== 'string') {
    const texts = rawTexts(err);
    for (const [pattern, sentence] of TRIGGER_SENTENCES) if (texts.some((t) => pattern.test(t))) return sentence;
  }
  if (typeof own === 'string' || looksLikeDatabaseError(err)) return errorMessage(err);
  // An unexpected plain Error: its text is for the log, never for the screen.
  logger.error({ err }, 'menu: unexpected error sanitised for the screen');
  return 'Something went wrong and nothing was saved. Try again; if it keeps happening, tell an administrator.';
}

function looksLikeDatabaseError(err: unknown): boolean {
  for (let cur: unknown = err, i = 0; i < 4 && cur && typeof cur === 'object'; i += 1, cur = (cur as { cause?: unknown }).cause) {
    const o = cur as { code?: unknown; constraint_name?: unknown; message?: unknown };
    if (typeof o.code === 'string' || typeof o.constraint_name === 'string') return true;
    if (typeof o.message === 'string' && /constraint "|relation "|SQLSTATE/.test(o.message)) return true;
  }
  return false;
}

/**
 * The value "Send request anyway" carries: it names the exact (case- and spacing-normalised) name that was checked, so a
 * confirmation shown for one look-alike can never wave a different name through. `1` is never accepted.
 */
export function confirmTokenFor(name: string): string {
  const normal = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(`menu-request-confirm|${normal}`).digest('hex').slice(0, 24);
}

// -------------------------------------------------------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------------------------------------------------------
export interface StoreChoice {
  id: string;
  name: string;
}

/** The stores this person is scoped to (person_store_scope), by name. A manager sees only their own; the picker never lists another. */
export async function storesInScope(tx: Tx, actor: Actor): Promise<StoreChoice[]> {
  const ids = await accessRepo.storeIdsForPerson(tx, actor.personId);
  if (ids.length === 0) return [];
  return tx
    .select({ id: schema.stores.id, name: schema.stores.name })
    .from(schema.stores)
    .where(and(eq(schema.stores.orgId, actor.orgId), inArray(schema.stores.id, ids)))
    .orderBy(asc(schema.stores.name), asc(schema.stores.id));
}

export interface CategoryRow {
  id: string;
  name: string;
  sortOrder: number;
  status: 'active' | 'retired';
}

/** Every category, in the order they were arranged (sort order, then the order they were made). */
export async function listCategories(tx: Tx, orgId: string): Promise<CategoryRow[]> {
  return tx
    .select({ id: schema.menuCategories.id, name: schema.menuCategories.name, sortOrder: schema.menuCategories.sortOrder, status: schema.menuCategories.status })
    .from(schema.menuCategories)
    .where(eq(schema.menuCategories.orgId, orgId))
    .orderBy(asc(schema.menuCategories.sortOrder), asc(schema.menuCategories.createdAt), asc(schema.menuCategories.id));
}

export interface OverviewItem {
  id: string;
  categoryId: string;
  name: string;
  itemType: 'a_la_carte' | 'package' | 'refill';
  status: 'active' | 'retired';
  /** Some active variant has no depletion rule at all. */
  missingRule: boolean;
  /** Some active variant has a price row in force that is not a withdrawal, on either channel, at the chosen store. null = no store chosen. */
  offeredAtStore: boolean | null;
}

export async function listOverviewItems(tx: Tx, orgId: string, storeId: string | null): Promise<OverviewItem[]> {
  const items = await tx
    .select()
    .from(schema.menuItems)
    .where(eq(schema.menuItems.orgId, orgId))
    .orderBy(asc(schema.menuItems.sortOrder), asc(schema.menuItems.name), asc(schema.menuItems.id));
  const variants = await tx
    .select({ id: schema.menuItemVariants.id, menuItemId: schema.menuItemVariants.menuItemId })
    .from(schema.menuItemVariants)
    .where(and(eq(schema.menuItemVariants.orgId, orgId), eq(schema.menuItemVariants.status, 'active')));
  const withRule = new Set(
    (await tx.selectDistinct({ variantId: schema.menuDepletionRules.variantId }).from(schema.menuDepletionRules).where(eq(schema.menuDepletionRules.orgId, orgId))).map((r) => r.variantId),
  );
  let offered: Set<string> | null = null;
  if (storeId) {
    const rows = await menuRepo.offersInForce(tx, storeId, await menuRepo.dbNow(tx));
    offered = new Set(rows.filter((r) => !r.withdrawn).map((r) => r.variantId));
  }
  const byItem = new Map<string, string[]>();
  for (const v of variants) byItem.set(v.menuItemId, [...(byItem.get(v.menuItemId) ?? []), v.id]);
  return items.map((i) => {
    const vs = byItem.get(i.id) ?? [];
    return {
      id: i.id,
      categoryId: i.categoryId,
      name: i.name,
      itemType: i.itemType,
      status: i.status,
      missingRule: vs.some((v) => !withRule.has(v)),
      offeredAtStore: offered ? vs.some((v) => (offered as Set<string>).has(v)) : null,
    };
  });
}

/** Whole-organisation item names for pickers (a request marked as a duplicate of one). */
export async function listActiveItemNames(tx: Tx, orgId: string): Promise<{ id: string; name: string; itemType: string }[]> {
  return tx
    .select({ id: schema.menuItems.id, name: schema.menuItems.name, itemType: schema.menuItems.itemType })
    .from(schema.menuItems)
    .where(and(eq(schema.menuItems.orgId, orgId), eq(schema.menuItems.status, 'active')))
    .orderBy(asc(schema.menuItems.name), asc(schema.menuItems.id));
}

export async function listActiveStockItems(tx: Tx, orgId: string): Promise<{ id: string; code: string; name: string; baseUnit: string }[]> {
  return tx
    .select({ id: schema.items.id, code: schema.items.code, name: schema.items.name, baseUnit: schema.items.baseUnit })
    .from(schema.items)
    .where(and(eq(schema.items.orgId, orgId), eq(schema.items.status, 'active')))
    .orderBy(asc(schema.items.name), asc(schema.items.id));
}

export async function listActiveRecipes(tx: Tx, orgId: string): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: schema.productionRecipes.id, name: schema.productionRecipes.name })
    .from(schema.productionRecipes)
    .where(and(eq(schema.productionRecipes.orgId, orgId), eq(schema.productionRecipes.status, 'active')))
    .orderBy(asc(schema.productionRecipes.name), asc(schema.productionRecipes.id));
}

export type OptionValueView = { id: string; name: string; sortOrder: number; status: 'active' | 'retired' };
export type OptionGroupView = {
  linkId: string;
  /** null = attached to the item; otherwise the variant it is attached to. */
  variantId: string | null;
  group: { id: string; name: string; selectionMode: 'single' | 'multi'; minSelections: number; maxSelections: number; status: 'active' | 'retired' };
  values: OptionValueView[];
};

export interface OfferHistoryRow {
  storeId: string;
  variantId: string;
  channel: 'store' | 'online';
  effectiveFrom: Date;
  amount: string | null;
  bundleHeads: number | null;
  extraHeadAmount: string | null;
  withdrawn: boolean;
  pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
  markupPercent: string | null;
  fixedMarkupAmount: string | null;
  state: 'in_force' | 'scheduled' | 'replaced';
}

export interface ItemPageData {
  now: Date;
  item: typeof schema.menuItems.$inferSelect;
  category: CategoryRow | undefined;
  categories: CategoryRow[];
  variants: (typeof schema.menuItemVariants.$inferSelect)[];
  optionGroups: OptionGroupView[];
  allGroups: { id: string; name: string }[];
  /** For a package: the refill items every package variant may serve, and which are ticked per variant. */
  refillChoices: { id: string; name: string }[];
  refillsByVariant: Map<string, Set<string>>;
  rules: {
    id: string;
    variantId: string;
    effectiveFrom: Date;
    mode: 'direct' | 'recipe' | 'no_stock';
    stockItemName: string | null;
    recipeName: string | null;
    quantityPerSale: string | null;
    inForce: boolean;
  }[];
  stores: StoreChoice[];
  offers: OfferHistoryRow[];
}

/** Everything /menu/items/[id] draws, or null when the id is not one of this organisation's items. */
export async function loadItemPage(tx: Tx, actor: Actor, itemId: string): Promise<ItemPageData | null> {
  const orgId = actor.orgId;
  if (!isUuid(itemId)) return null;
  const item = await menuRepo.getItem(tx, orgId, itemId);
  if (!item) return null;
  const now = await menuRepo.dbNow(tx);
  const categories = await listCategories(tx, orgId);
  const variants = await menuRepo.variantsOfItem(tx, orgId, item.id);
  const variantIds = variants.map((v) => v.id);

  const linkRows = await tx
    .select({ link: schema.menuOptionGroupLinks, group: schema.menuOptionGroups })
    .from(schema.menuOptionGroupLinks)
    .innerJoin(schema.menuOptionGroups, eq(schema.menuOptionGroups.id, schema.menuOptionGroupLinks.optionGroupId))
    .where(and(eq(schema.menuOptionGroupLinks.orgId, orgId), eq(schema.menuOptionGroupLinks.menuItemId, item.id)))
    .orderBy(asc(schema.menuOptionGroupLinks.sortOrder), asc(schema.menuOptionGroupLinks.createdAt));
  const variantLinkRows =
    variantIds.length === 0
      ? []
      : await tx
          .select({ link: schema.menuOptionGroupLinks, group: schema.menuOptionGroups })
          .from(schema.menuOptionGroupLinks)
          .innerJoin(schema.menuOptionGroups, eq(schema.menuOptionGroups.id, schema.menuOptionGroupLinks.optionGroupId))
          .where(and(eq(schema.menuOptionGroupLinks.orgId, orgId), inArray(schema.menuOptionGroupLinks.variantId, variantIds)))
          .orderBy(asc(schema.menuOptionGroupLinks.sortOrder), asc(schema.menuOptionGroupLinks.createdAt));
  const allLinks = [...linkRows, ...variantLinkRows];
  const groupIds = [...new Set(allLinks.map((l) => l.group.id))];
  const values =
    groupIds.length === 0
      ? []
      : await tx
          .select()
          .from(schema.menuOptionValues)
          .where(and(eq(schema.menuOptionValues.orgId, orgId), inArray(schema.menuOptionValues.optionGroupId, groupIds)))
          .orderBy(asc(schema.menuOptionValues.sortOrder), asc(schema.menuOptionValues.name), asc(schema.menuOptionValues.id));
  const optionGroups: OptionGroupView[] = allLinks.map((l) => ({
    linkId: l.link.id,
    variantId: l.link.variantId,
    group: {
      id: l.group.id,
      name: l.group.name,
      selectionMode: l.group.selectionMode,
      minSelections: l.group.minSelections,
      maxSelections: l.group.maxSelections,
      status: l.group.status,
    },
    values: values
      .filter((v) => v.optionGroupId === l.group.id)
      .map((v) => ({ id: v.id, name: v.name, sortOrder: v.sortOrder, status: v.status })),
  }));
  const allGroups = await tx
    .select({ id: schema.menuOptionGroups.id, name: schema.menuOptionGroups.name })
    .from(schema.menuOptionGroups)
    .where(and(eq(schema.menuOptionGroups.orgId, orgId), eq(schema.menuOptionGroups.status, 'active')))
    .orderBy(asc(schema.menuOptionGroups.name), asc(schema.menuOptionGroups.id));

  const refillsByVariant = new Map<string, Set<string>>();
  let refillChoices: { id: string; name: string }[] = [];
  if (item.itemType === 'package') {
    refillChoices = await tx
      .select({ id: schema.menuItems.id, name: schema.menuItems.name })
      .from(schema.menuItems)
      .where(and(eq(schema.menuItems.orgId, orgId), eq(schema.menuItems.itemType, 'refill'), eq(schema.menuItems.status, 'active')))
      .orderBy(asc(schema.menuItems.name), asc(schema.menuItems.id));
    if (variantIds.length > 0) {
      const rows = await tx
        .select({ packageVariantId: schema.menuPackageRefills.packageVariantId, refillItemId: schema.menuPackageRefills.refillItemId })
        .from(schema.menuPackageRefills)
        .where(and(eq(schema.menuPackageRefills.orgId, orgId), eq(schema.menuPackageRefills.status, 'active'), inArray(schema.menuPackageRefills.packageVariantId, variantIds)));
      for (const r of rows) refillsByVariant.set(r.packageVariantId, new Set([...(refillsByVariant.get(r.packageVariantId) ?? []), r.refillItemId]));
    }
  }

  const ruleRows =
    variantIds.length === 0
      ? []
      : await tx
          .select({
            id: schema.menuDepletionRules.id,
            variantId: schema.menuDepletionRules.variantId,
            effectiveFrom: schema.menuDepletionRules.effectiveFrom,
            mode: schema.menuDepletionRules.mode,
            quantityPerSale: schema.menuDepletionRules.quantityPerSale,
            stockItemName: schema.items.name,
            recipeName: schema.productionRecipes.name,
          })
          .from(schema.menuDepletionRules)
          .leftJoin(schema.items, eq(schema.items.id, schema.menuDepletionRules.itemId))
          .leftJoin(schema.productionRecipes, eq(schema.productionRecipes.id, schema.menuDepletionRules.recipeId))
          .where(and(eq(schema.menuDepletionRules.orgId, orgId), inArray(schema.menuDepletionRules.variantId, variantIds)))
          .orderBy(desc(schema.menuDepletionRules.effectiveFrom), desc(schema.menuDepletionRules.id));
  const inForceRule = new Map<string, string>();
  for (const r of ruleRows) if (r.effectiveFrom <= now && !inForceRule.has(r.variantId)) inForceRule.set(r.variantId, r.id);
  const rules = ruleRows.map((r) => ({ ...r, inForce: inForceRule.get(r.variantId) === r.id }));

  const stores = await storesInScope(tx, actor);
  const offers: OfferHistoryRow[] = [];
  for (const s of stores) {
    for (const v of variants) {
      const rows = await menuRepo.offerHistory(tx, s.id, v.id);
      const seen = new Set<string>();
      for (const r of rows) {
        let state: OfferHistoryRow['state'];
        if (r.effectiveFrom > now) state = 'scheduled';
        else if (!seen.has(r.channel)) {
          seen.add(r.channel);
          state = 'in_force';
        } else state = 'replaced';
        offers.push({
          storeId: s.id,
          variantId: v.id,
          channel: r.channel,
          effectiveFrom: r.effectiveFrom,
          amount: r.amount,
          bundleHeads: r.bundleHeads,
          extraHeadAmount: r.extraHeadAmount,
          withdrawn: r.withdrawn,
          pricingMode: r.pricingMode,
          markupPercent: r.markupPercent,
          fixedMarkupAmount: r.fixedMarkupAmount,
          state,
        });
      }
    }
  }
  return { now, item, category: categories.find((c) => c.id === item.categoryId), categories, variants, optionGroups, allGroups, refillChoices, refillsByVariant, rules, stores, offers };
}

export interface ScheduledOffer {
  id: string;
  variantId: string;
  channel: 'store' | 'online';
  effectiveFrom: Date;
  amount: string | null;
  withdrawn: boolean;
  pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
  markupPercent: string | null;
  fixedMarkupAmount: string | null;
}

export interface ScheduledOptionOffer {
  id: string;
  optionValueId: string;
  channel: 'store' | 'online';
  effectiveFrom: Date;
  priceDelta: string | null;
  withdrawn: boolean;
}

export interface PricesPageData {
  now: Date;
  categories: CategoryRow[];
  items: { id: string; categoryId: string; name: string; itemType: 'a_la_carte' | 'package' | 'refill'; variants: { id: string; label: string | null }[] }[];
  inForce: menuRepo.OfferInForce[];
  scheduled: ScheduledOffer[];
  optionValues: { id: string; label: string }[];
  optionInForce: menuRepo.OptionOfferInForce[];
  optionScheduled: ScheduledOptionOffer[];
}

/** The price grid's data for one store: active items and variants, what is in force, what is scheduled, and the option deltas. */
export async function loadPricesPage(tx: Tx, orgId: string, storeId: string): Promise<PricesPageData> {
  const now = await menuRepo.dbNow(tx);
  const categories = await listCategories(tx, orgId);
  const itemRows = await tx
    .select({ id: schema.menuItems.id, categoryId: schema.menuItems.categoryId, name: schema.menuItems.name, itemType: schema.menuItems.itemType })
    .from(schema.menuItems)
    .where(and(eq(schema.menuItems.orgId, orgId), eq(schema.menuItems.status, 'active')))
    .orderBy(asc(schema.menuItems.sortOrder), asc(schema.menuItems.name), asc(schema.menuItems.id));
  const variantRows = await tx
    .select({ id: schema.menuItemVariants.id, menuItemId: schema.menuItemVariants.menuItemId, label: schema.menuItemVariants.label })
    .from(schema.menuItemVariants)
    .where(and(eq(schema.menuItemVariants.orgId, orgId), eq(schema.menuItemVariants.status, 'active')))
    .orderBy(asc(schema.menuItemVariants.sortOrder), asc(schema.menuItemVariants.createdAt));
  const items = itemRows.map((i) => ({ ...i, variants: variantRows.filter((v) => v.menuItemId === i.id).map((v) => ({ id: v.id, label: v.label })) }));
  const inForce = await menuRepo.offersInForce(tx, storeId, now);
  const scheduled = await tx
    .select({
      id: schema.menuOffers.id,
      variantId: schema.menuOffers.variantId,
      channel: schema.menuOffers.channel,
      effectiveFrom: schema.menuOffers.effectiveFrom,
      amount: schema.menuOffers.amount,
      withdrawn: schema.menuOffers.withdrawn,
      pricingMode: schema.menuOffers.pricingMode,
      markupPercent: schema.menuOffers.markupPercent,
      fixedMarkupAmount: schema.menuOffers.fixedMarkupAmount,
    })
    .from(schema.menuOffers)
    .where(and(eq(schema.menuOffers.orgId, orgId), eq(schema.menuOffers.storeId, storeId), gt(schema.menuOffers.effectiveFrom, now)))
    .orderBy(asc(schema.menuOffers.effectiveFrom), asc(schema.menuOffers.id));
  const valueRows = await tx
    .select({ id: schema.menuOptionValues.id, name: schema.menuOptionValues.name, groupName: schema.menuOptionGroups.name })
    .from(schema.menuOptionValues)
    .innerJoin(schema.menuOptionGroups, eq(schema.menuOptionGroups.id, schema.menuOptionValues.optionGroupId))
    .where(and(eq(schema.menuOptionValues.orgId, orgId), eq(schema.menuOptionValues.status, 'active'), eq(schema.menuOptionGroups.status, 'active')))
    .orderBy(asc(schema.menuOptionGroups.name), asc(schema.menuOptionValues.sortOrder), asc(schema.menuOptionValues.name), asc(schema.menuOptionValues.id));
  const optionInForce = await menuRepo.optionOffersInForce(tx, storeId, now);
  const optionScheduled = await tx
    .select({
      id: schema.menuOptionOffers.id,
      optionValueId: schema.menuOptionOffers.optionValueId,
      channel: schema.menuOptionOffers.channel,
      effectiveFrom: schema.menuOptionOffers.effectiveFrom,
      priceDelta: schema.menuOptionOffers.priceDelta,
      withdrawn: schema.menuOptionOffers.withdrawn,
    })
    .from(schema.menuOptionOffers)
    .where(and(eq(schema.menuOptionOffers.orgId, orgId), eq(schema.menuOptionOffers.storeId, storeId), gt(schema.menuOptionOffers.effectiveFrom, now)))
    .orderBy(asc(schema.menuOptionOffers.effectiveFrom), asc(schema.menuOptionOffers.id));
  return {
    now,
    categories,
    items,
    inForce,
    scheduled,
    optionValues: valueRows.map((v) => ({ id: v.id, label: `${v.groupName}: ${v.name}` })),
    optionInForce,
    optionScheduled,
  };
}

export interface RequestRow {
  id: string;
  name: string;
  itemType: 'a_la_carte' | 'package' | 'refill';
  status: 'open' | 'approved' | 'duplicate' | 'rejected' | 'withdrawn';
  storeName: string;
  requesterName: string;
  requestedBy: string;
  categoryId: string | null;
  note: string | null;
  resolvedItemId: string | null;
  resolvedItemName: string | null;
  resolutionNote: string | null;
  createdAt: Date;
}

async function requestRows(tx: Tx, orgId: string, where: ReturnType<typeof and>): Promise<RequestRow[]> {
  const rows = await tx
    .select({
      id: schema.menuItemRequests.id,
      name: schema.menuItemRequests.name,
      itemType: schema.menuItemRequests.itemType,
      status: schema.menuItemRequests.status,
      storeName: schema.stores.name,
      requesterName: schema.persons.displayName,
      requestedBy: schema.menuItemRequests.requestedBy,
      categoryId: schema.menuItemRequests.categoryId,
      note: schema.menuItemRequests.note,
      resolvedItemId: schema.menuItemRequests.resolvedItemId,
      resolutionNote: schema.menuItemRequests.resolutionNote,
      createdAt: schema.menuItemRequests.createdAt,
    })
    .from(schema.menuItemRequests)
    .innerJoin(schema.stores, eq(schema.stores.id, schema.menuItemRequests.storeId))
    .innerJoin(schema.persons, eq(schema.persons.id, schema.menuItemRequests.requestedBy))
    .where(and(eq(schema.menuItemRequests.orgId, orgId), where))
    .orderBy(desc(schema.menuItemRequests.createdAt), desc(schema.menuItemRequests.id));
  const resolvedIds = [...new Set(rows.map((r) => r.resolvedItemId).filter((x): x is string => x !== null))];
  const names = new Map<string, string>();
  if (resolvedIds.length > 0) {
    for (const r of await tx.select({ id: schema.menuItems.id, name: schema.menuItems.name }).from(schema.menuItems).where(inArray(schema.menuItems.id, resolvedIds))) names.set(r.id, r.name);
  }
  return rows.map((r) => ({ ...r, resolvedItemName: r.resolvedItemId ? (names.get(r.resolvedItemId) ?? null) : null }));
}

/** A person's own requests, newest first, with how each ended. */
export async function myRequests(tx: Tx, actor: Actor): Promise<RequestRow[]> {
  return requestRows(tx, actor.orgId, eq(schema.menuItemRequests.requestedBy, actor.personId));
}

/** Every open request in the organisation (a super admin's queue). */
export async function openRequests(tx: Tx, orgId: string): Promise<RequestRow[]> {
  return requestRows(tx, orgId, eq(schema.menuItemRequests.status, 'open'));
}
