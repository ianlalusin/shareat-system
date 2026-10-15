/**
 * T-401 S5 (Ian's Q3, 2026-10-13): THE ONE SEAM between the live v1 usage pull and the menu's depletion rules.
 * docs/tasks/401-erp-menu-catalog-master.md R7 and "S5 rulings (Opus planner, 2026-10-14)".
 *
 * This is the only file under `pos/**` that may name the menu (guard `tests/unit/t401-v1-feed-untouched.test.ts`), and `plan.ts` and
 * `usage-pull.ts` reach the menu only through `loadDepletionLookups` below. Everything that reads the v1 feed for a menu reason lives
 * here: the lookup loader, the two-way comparison, the usage-source switch, links (link / unlink / seed from a map) and the guard that
 * stops a recipe changing under a pull the manager has not finished.
 *
 * WRITES ONLY MENU TABLES (links, switches, a seeded rule). It never writes a v1 table (`pos_item_maps`, pulls, day feeds).
 *
 * Source of a store's usage = the latest `menu_usage_source_switches` row; no row = `v1_pos_map` (exactly today's code path).
 * A switched store resolves a sold v1 item key like this: an active link -> the variant's rule in force when the plan is built, at the
 * link's own stock location; no link -> its `pos_item_maps` row; neither -> an orphan, as today.
 */
import { authorize, type Actor } from '@shareat/auth';
import { decimal } from '@shareat/core/money';
import type { BusinessDate } from '@shareat/core/datetime';
import { accessRepo, menuRepo, posMappingRepo, posV1Repo, stockLocationsRepo, storesRepo, type Tx } from '@shareat/db';
import type { MenuUsageSource } from '@shareat/db/schema';
import { audit, inTx, parseMenuQuantity, requireUsableRuleTarget } from '../menu/shared';
import { gone, humanDate, refuse } from '../shared/refusal';
import { explodePosSales, type MapLookup, type PlanLine, type RecipeLookup } from './plan';
import { soldItemsFromFeed } from './v1-sold-items';

export type UsageSource = MenuUsageSource;

/** The maps and recipes `explodePosSales` takes, for one store at one instant. */
export interface DepletionLookups {
  readonly mapsByPosItemKey: Map<string, MapLookup>;
  readonly recipesById: Map<string, RecipeLookup>;
}

interface MapRow extends MapLookup {
  readonly posItemKey: string;
  readonly posItemName: string;
}

// -------------------------------------------------------------------------------------------------------------------
// Lookups: the one place the usage plan's mapping is chosen
// -------------------------------------------------------------------------------------------------------------------
/** The lookups for `source`: the store's maps, with a switched store's linked keys overridden by the rule in force. Pure. */
function lookupsFor(
  source: UsageSource,
  maps: readonly MapRow[],
  links: readonly menuRepo.MenuPosV1LinkRow[],
  rules: ReadonlyMap<string, menuRepo.RuleInForce>,
): Map<string, MapLookup> {
  const out = new Map<string, MapLookup>(maps.map((m) => [m.posItemKey, m]));
  if (source !== 'menu_rules') return out;
  for (const link of links) {
    const rule = rules.get(link.variantId);
    if (!rule) continue; // cannot happen (a link needs a rule in force and rules are never withdrawn); the map stays as the safe fallback
    out.set(link.posItemKey, {
      mode: rule.mode,
      itemId: rule.itemId,
      recipeId: rule.recipeId,
      quantityPerSale: rule.quantityPerSale,
      locationId: link.locationId,
    });
  }
  return out;
}

/** Active recipes (as `rebuildLines` always read them) for every recipe the given lookups name. */
async function loadRecipes(tx: Tx, orgId: string, lookups: readonly ReadonlyMap<string, MapLookup>[]): Promise<Map<string, RecipeLookup>> {
  const ids = new Set<string>();
  for (const lk of lookups) for (const m of lk.values()) if (m.mode === 'recipe' && m.recipeId) ids.add(m.recipeId);
  const rows = await posMappingRepo.getRecipesForExplosion(tx, orgId, [...ids]);
  return new Map(rows.filter((r) => r.status === 'active').map((r) => [r.id, { outputQuantity: r.outputQuantity, lines: r.lines }]));
}

/** The instant a usage plan is built "as of" (the database's clock). Stored on the pull as its snapshot time; finalize rebuilds as of it. */
export async function planInstant(tx: Tx): Promise<Date> {
  return menuRepo.clockNow(tx);
}

/**
 * What the usage pull explodes against, AS OF `asOf`: plan time, and finalize's rebuild at the PLAN's instant (so a rule that comes
 * due between plan and finalize cannot change a pull in progress). Takes the store row FOR KEY SHARE first, the lock a switch,
 * link or rule change takes FOR UPDATE, so they cannot interleave with planning. An unswitched store reads exactly what it read
 * before S5 (`listActiveMaps` and the recipes they name): nothing about the menu is touched.
 */
export async function loadDepletionLookups(tx: Tx, orgId: string, storeId: string, asOf: Date): Promise<DepletionLookups> {
  await posV1Repo.lockStoreForShare(tx, orgId, storeId);
  const source = await menuRepo.usageSourceInForce(tx, storeId);
  const maps = await posMappingRepo.listActiveMaps(tx, storeId);
  const links = source === 'menu_rules' ? await menuRepo.listActiveLinks(tx, storeId) : [];
  const rules = source === 'menu_rules' ? await menuRepo.rulesInForce(tx, orgId, links.map((l) => l.variantId), asOf) : new Map();
  const mapsByPosItemKey = lookupsFor(source, maps, links, rules);
  return { mapsByPosItemKey, recipesById: await loadRecipes(tx, orgId, [mapsByPosItemKey]) };
}

/**
 * T-401 S6: the stock items a store's MENU RULES cover right now, for the usage tolerance check. Only a store whose usage source is
 * `menu_rules` has any; a store on the POS item maps is covered only by what its pull plans. A direct rule covers its item, a recipe
 * rule the items of the recipe's active lines, `no_stock` nothing. A plain read: no lock, nothing written.
 */
export async function menuRuleCoveredItemIds(tx: Tx, orgId: string, storeId: string): Promise<Set<string>> {
  const covered = new Set<string>();
  if ((await menuRepo.usageSourceInForce(tx, storeId)) !== 'menu_rules') return covered;
  const links = await menuRepo.listActiveLinks(tx, storeId);
  if (links.length === 0) return covered;
  const rules = await menuRepo.rulesInForce(tx, orgId, links.map((l) => l.variantId), await planInstant(tx));
  const recipeIds = new Set<string>();
  for (const rule of rules.values()) {
    if (rule.mode === 'direct' && rule.itemId) covered.add(rule.itemId);
    else if (rule.mode === 'recipe' && rule.recipeId) recipeIds.add(rule.recipeId);
  }
  if (recipeIds.size > 0) {
    for (const r of await posMappingRepo.getRecipesForExplosion(tx, orgId, [...recipeIds])) {
      if (r.status === 'active') for (const l of r.lines) covered.add(l.itemId);
    }
  }
  return covered;
}

// -------------------------------------------------------------------------------------------------------------------
// The guard: a recipe, a link or a source must not move under a pull the manager has not finished
// -------------------------------------------------------------------------------------------------------------------
const dayWords = (d: string): string => humanDate(d as BusinessDate);

async function lockedStore(tx: Tx, orgId: string, storeId: string): Promise<{ id: string; name: string }> {
  const store = await posV1Repo.lockStoreForUpdate(tx, orgId, storeId);
  if (!store) throw gone(`depletion-source: store ${storeId} does not exist.`, 'store');
  return store;
}

/** Refuses, in a sentence naming the store and the date, while the store has a pull still in status `planned` (a partly finalized one included). */
async function refuseWhilePlanned(tx: Tx, store: { id: string; name: string }, because: string): Promise<void> {
  const dates = await posMappingRepo.listPlannedPullDates(tx, store.id);
  const first = dates[0];
  if (first === undefined) return;
  const more = dates.length > 1 ? ` (and ${dates.length - 1} more day${dates.length > 2 ? 's' : ''})` : '';
  throw refuse(
    `depletion-source: ${store.name} has a planned usage pull for ${first}; ${because}`,
    `Finish or void the ${dayWords(first)} usage pull at ${store.name}${more} first: ${because}`,
  );
}

/**
 * `setDepletionRule` / `cancelScheduledDepletionRule` call this (through the one allowed import from `menu/pricing.ts`): a rule is
 * org-wide, so for every store that reads the menu rules and links this variant, a planned pull would change under its manager.
 */
export async function assertNoPlannedPullAtLinkedSwitchedStores(tx: Tx, orgId: string, variantId: string): Promise<void> {
  const storeIds = (await menuRepo.switchedStoresLinkedToVariant(tx, orgId, variantId)).sort();
  for (const id of storeIds) {
    await refuseWhilePlanned(tx, await lockedStore(tx, orgId, id), "this item's stock rule decides what that pull takes out of stock, and changing it now would change a pull that is not finished.");
  }
}

// -------------------------------------------------------------------------------------------------------------------
// Compare (read-only): the plan both ways over the last stored day feeds
// -------------------------------------------------------------------------------------------------------------------
export type DifferenceKind =
  | 'orphan_in_pos_map'
  | 'orphan_in_menu_rules'
  | 'only_in_pos_map'
  | 'only_in_menu_rules'
  | 'different_item'
  | 'quantity'
  | 'location'
  | 'link_without_pos_map';

export interface SourceDifference {
  /** The business date 'YYYY-MM-DD' of a stored day that plans differently; `null` for a standing link-versus-map difference. */
  readonly businessDate: string | null;
  readonly posItemKey: string;
  readonly kind: DifferenceKind;
  readonly summary: string;
}

export interface SourceComparison {
  /** The number of distinct v1 item keys with at least one difference. */
  readonly differenceCount: number;
  readonly differences: readonly SourceDifference[];
  /** The stored days that were compared (oldest first). */
  readonly daysCompared: readonly string[];
}

const SUMMARY: Record<DifferenceKind, string> = {
  orphan_in_pos_map: 'The POS item map has no entry for it (an orphan today); the menu rule would use stock for it.',
  orphan_in_menu_rules: 'The menu rules have nothing for it (an orphan after the switch); the POS item map uses stock for it today.',
  only_in_pos_map: 'Only the POS item map takes stock out for it; the menu rule takes none.',
  only_in_menu_rules: 'Only the menu rule takes stock out for it; the POS item map takes none.',
  different_item: 'The menu rule and the POS item map use different stock items.',
  quantity: 'The menu rule and the POS item map use a different quantity.',
  location: 'The menu rule and the POS item map take stock from different rooms.',
  link_without_pos_map: 'It is linked to a menu rule but has no POS item map, so it is an orphan today.',
};

/** Where a store with no default room plans from: the same value on both sides, so it can never be a difference. */
const NO_DEFAULT_ROOM = '00000000-0000-0000-0000-000000000000';
const MAX_DAYS = 31;

const canon = (l: PlanLine): string => `${l.key}|${l.section}|${l.itemId ?? ''}|${l.locationId ?? ''}|${l.quantity ?? ''}|${l.blocked ? 'blocked' : ''}`;
const byKey = (lines: readonly PlanLine[]): Map<string, PlanLine[]> => {
  const m = new Map<string, PlanLine[]>();
  for (const l of lines) m.set(l.posItemKey, [...(m.get(l.posItemKey) ?? []), l]);
  return m;
};

/** Why one v1 item key plans differently on the two sources, or null when it does not. */
function dayKind(a: readonly PlanLine[], b: readonly PlanLine[]): DifferenceKind | null {
  const as = a.map(canon).sort().join('\n');
  const bs = b.map(canon).sort().join('\n');
  if (as === bs) return null;
  const orphan = (ls: readonly PlanLine[]) => ls.some((l) => l.section === 'orphan');
  if (orphan(a) && !orphan(b)) return 'orphan_in_pos_map';
  if (orphan(b) && !orphan(a)) return 'orphan_in_menu_rules';
  if (a.length === 0) return 'only_in_menu_rules';
  if (b.length === 0) return 'only_in_pos_map';
  const items = (ls: readonly PlanLine[]) => ls.map((l) => `${l.key}|${l.itemId ?? ''}`).sort().join('\n');
  if (items(a) !== items(b)) return 'different_item';
  const qty = (ls: readonly PlanLine[]) => ls.map((l) => `${l.key}|${l.quantity ?? ''}`).sort().join('\n');
  if (qty(a) !== qty(b)) return 'quantity';
  return 'location';
}

/** The standing difference between an active link's rule and the store's active map for that key, or null when they agree. */
function standingKind(link: menuRepo.MenuPosV1LinkRow, rule: menuRepo.RuleInForce, map: MapRow | undefined): DifferenceKind | null {
  if (!map) return 'link_without_pos_map';
  if (map.mode !== rule.mode) return map.mode === 'no_stock' ? 'only_in_menu_rules' : rule.mode === 'no_stock' ? 'only_in_pos_map' : 'different_item';
  if (rule.mode === 'direct' && map.itemId !== rule.itemId) return 'different_item';
  if (rule.mode === 'recipe' && map.recipeId !== rule.recipeId) return 'different_item';
  if (rule.mode === 'direct' && (map.quantityPerSale ?? null) !== (rule.quantityPerSale ?? null)) return 'quantity';
  if (rule.mode !== 'no_stock' && (map.locationId ?? null) !== (link.locationId ?? null)) return 'location';
  return null;
}

async function computeComparison(tx: Tx, orgId: string, storeId: string, days: number): Promise<SourceComparison> {
  const maps = await posMappingRepo.listActiveMaps(tx, storeId);
  const links = await menuRepo.listActiveLinks(tx, storeId);
  const rules = await menuRepo.rulesInForce(tx, orgId, links.map((l) => l.variantId));
  const mapLookups = lookupsFor('v1_pos_map', maps, links, rules);
  const ruleLookups = lookupsFor('menu_rules', maps, links, rules);
  const recipesById = await loadRecipes(tx, orgId, [mapLookups, ruleLookups]);
  const defaultRoom = (await stockLocationsRepo.defaultLocationFor(tx, storeId))?.id ?? NO_DEFAULT_ROOM;

  const dates = (await posV1Repo.recentSoldItemsDates(tx, orgId, storeId, Math.min(MAX_DAYS, Math.max(1, Math.trunc(days))))).sort();
  const rooms = await posMappingRepo.liveUsageLocationsByDate(tx, storeId, dates);
  const differences: SourceDifference[] = [];
  for (const date of dates) {
    const feed = await posV1Repo.latestForDay(tx, orgId, storeId, date, 'sold_items');
    if (!feed) continue;
    const sold = soldItemsFromFeed(feed.payload);
    if (!sold.ok) continue; // an unreadable stored feed is not a difference between sources
    const room = rooms.get(date) ?? defaultRoom;
    const mapsSide = byKey(explodePosSales({ posItems: sold.items, mapsByPosItemKey: mapLookups, recipesById, defaultLocationId: room }));
    const rulesSide = byKey(explodePosSales({ posItems: sold.items, mapsByPosItemKey: ruleLookups, recipesById, defaultLocationId: room }));
    for (const key of [...new Set([...mapsSide.keys(), ...rulesSide.keys(), ...sold.items.map((i) => i.posItemKey)])].sort()) {
      const kind = dayKind(mapsSide.get(key) ?? [], rulesSide.get(key) ?? []);
      if (kind) differences.push({ businessDate: date, posItemKey: key, kind, summary: SUMMARY[kind] });
    }
  }

  // Every active link's rule against the store's map, sold or not (a slow seller cannot hide a difference). A key that already
  // differs on a sold day is not listed twice.
  const seen = new Set(differences.map((d) => d.posItemKey));
  const mapByKey = new Map(maps.map((m) => [m.posItemKey, m]));
  for (const link of links) {
    const rule = rules.get(link.variantId);
    if (!rule || seen.has(link.posItemKey)) continue;
    const kind = standingKind(link, rule, mapByKey.get(link.posItemKey));
    if (kind) differences.push({ businessDate: null, posItemKey: link.posItemKey, kind, summary: SUMMARY[kind] });
  }
  return { differenceCount: new Set(differences.map((d) => d.posItemKey)).size, differences, daysCompared: dates };
}

/** A dry run, read-only: the usage plan over the last `days` stored day feeds from the POS item maps and from the menu rules. */
export async function compareDepletionSources(actor: Actor, input: { storeId: string; days?: number }, tx?: Tx): Promise<SourceComparison> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'view_menu', {});
    if (!(await accessRepo.storeIdsForPerson(trx, actor.personId)).includes(input.storeId)) {
      throw refuse(`compareDepletionSources: store ${input.storeId} is outside the store scope of person ${actor.personId}.`, 'You are not assigned to that store, so you cannot compare its usage sources.');
    }
    if (!(await storesRepo.getById(trx, actor.orgId, input.storeId))) {
      throw gone(`compareDepletionSources: store ${input.storeId} does not exist.`, 'store');
    }
    return computeComparison(trx, actor.orgId, input.storeId, input.days ?? 7);
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Switch
// -------------------------------------------------------------------------------------------------------------------
export interface SwitchUsageSourceInput {
  storeId: string;
  source: UsageSource;
  /** Switching TO the menu rules while the comparison shows differences needs this and a reason. */
  acceptDifferences?: boolean;
  reason?: string;
}

export async function switchUsageSource(
  actor: Actor,
  input: SwitchUsageSourceInput,
  tx?: Tx,
): Promise<{ id: string; source: UsageSource; differenceCount: number | null }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'switch_usage_source', { storeId: input.storeId });
    if (input.source !== 'menu_rules' && input.source !== 'v1_pos_map') {
      throw refuse('switchUsageSource: source must be menu_rules or v1_pos_map.', 'Choose the menu rules or the POS item maps.');
    }
    const store = await lockedStore(trx, actor.orgId, input.storeId);
    const reason = input.reason?.trim() ? input.reason.trim() : null;
    // A store with no switch row is on the POS item maps, so switching to maps there is a no-op too.
    const current = await menuRepo.usageSourceInForce(trx, input.storeId);
    if (current === input.source) {
      throw refuse(
        `switchUsageSource: ${store.name} already reads ${input.source}.`,
        `${store.name} already reads its stock usage from ${input.source === 'menu_rules' ? 'the menu rules' : 'the POS item maps'}, so there is nothing to switch.`,
      );
    }

    let differenceCount: number | null = null;
    if (input.source === 'menu_rules') {
      // A source change moves plans under an unfinished pull. Switching BACK is the always-available rollback: it is not refused.
      await refuseWhilePlanned(trx, store, 'switching where its stock usage comes from now would change a pull that is not finished.');
      const cmp = await computeComparison(trx, actor.orgId, input.storeId, 7);
      differenceCount = cmp.differenceCount;
      if (cmp.differenceCount > 0) {
        const first = [...cmp.differences].sort((a, b) => (a.businessDate ?? '9999-99-99').localeCompare(b.businessDate ?? '9999-99-99'))[0]!;
        const where = first.businessDate ? `on ${dayWords(first.businessDate)}` : 'in its stored rule';
        if (!input.acceptDifferences) {
          throw refuse(
            `switchUsageSource: ${cmp.differenceCount} item(s) plan differently from the menu rules, first ${first.posItemKey} ${where}.`,
            `${store.name} would use stock differently under the menu rules: ${cmp.differenceCount} item${cmp.differenceCount === 1 ? '' : 's'} differ, the first being "${first.posItemKey}" ${where}. Fix the rule or the map, or accept the differences with a reason.`,
          );
        }
        if (!reason) {
          throw refuse(
            'switchUsageSource: acceptDifferences needs a reason.',
            `Type why you accept the ${cmp.differenceCount} difference${cmp.differenceCount === 1 ? '' : 's'} before switching ${store.name} to the menu rules.`,
          );
        }
      }
    }
    const row = await menuRepo.insertUsageSwitch(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      source: input.source,
      reason,
      differenceCount,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu.usage_source_switch', input.storeId, row.id, null, { source: input.source, differenceCount, reason });
    return { id: row.id, source: input.source, differenceCount };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Links
// -------------------------------------------------------------------------------------------------------------------
export interface LinkPosV1ItemInput {
  storeId: string;
  posItemKey: string;
  variantId: string;
  /** This store's own stock room for the item (the `pos_item_maps.location_id` an org rule cannot hold). Blank = the pull's room. */
  locationId?: string | null;
}

/** Common to link and seed: the store is locked, a switched store with a planned pull refuses, the key is clean and not yet linked. */
async function beginLink(tx: Tx, actor: Actor, input: { storeId: string; posItemKey: string }): Promise<{ store: { id: string; name: string }; key: string }> {
  await authorize(tx, actor, 'manage_pos_map', { storeId: input.storeId });
  const store = await lockedStore(tx, actor.orgId, input.storeId);
  if ((await menuRepo.usageSourceInForce(tx, input.storeId)) === 'menu_rules') {
    await refuseWhilePlanned(tx, store, 'a link decides what a sale of that POS item takes out of stock, and changing it now would change a pull that is not finished.');
  }
  const key = (input.posItemKey ?? '').trim();
  if (!key) throw refuse('depletion-source: the POS item key is blank.', 'Enter the POS item key.');
  return { store, key };
}

async function requireFreeKey(tx: Tx, storeId: string, key: string, storeName: string): Promise<void> {
  if (await menuRepo.getActiveLink(tx, storeId, key)) {
    throw refuse(`depletion-source: "${key}" is already linked at ${storeName}.`, `"${key}" is already linked at ${storeName}. Remove that link first, then link it again.`);
  }
}

export async function linkPosV1Item(actor: Actor, input: LinkPosV1ItemInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    const { store, key } = await beginLink(trx, actor, input);
    await requireFreeKey(trx, input.storeId, key, store.name);
    if (!(await menuRepo.getVariant(trx, actor.orgId, input.variantId))) throw gone(`linkPosV1Item: variant ${input.variantId} does not exist.`, 'menu item');
    if (!(await menuRepo.rulesInForce(trx, actor.orgId, [input.variantId])).has(input.variantId)) {
      throw refuse(
        `linkPosV1Item: variant ${input.variantId} has no depletion rule in force.`,
        'That menu item has no stock rule yet. Set what a sale uses up on the item page first, then link it.',
      );
    }
    const locationId = input.locationId ? input.locationId : null;
    if (locationId) {
      const room = await stockLocationsRepo.getLocation(trx, locationId);
      if (!room || room.storeId !== input.storeId) {
        throw refuse(`linkPosV1Item: location ${locationId} is not a room of store ${input.storeId}.`, `That room does not belong to ${store.name}.`);
      }
    }
    const row = await menuRepo.insertPosV1Link(trx, { orgId: actor.orgId, storeId: input.storeId, posItemKey: key, variantId: input.variantId, locationId, createdBy: actor.personId });
    await audit(trx, actor, 'menu.pos_v1_link', input.storeId, row.id, null, { posItemKey: key, variantId: input.variantId, locationId });
    return { id: row.id };
  });
}

export async function unlinkPosV1Item(actor: Actor, input: { storeId: string; posItemKey: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    const { store, key } = await beginLink(trx, actor, input);
    const link = await menuRepo.getActiveLink(trx, input.storeId, key);
    if (!link) throw gone(`unlinkPosV1Item: no active link for "${key}" at ${store.name}.`, 'link');
    await menuRepo.deactivatePosV1Link(trx, link.id);
    await audit(trx, actor, 'menu.pos_v1_unlink', input.storeId, link.id, { posItemKey: key, variantId: link.variantId, locationId: link.locationId }, null);
    return { id: link.id };
  });
}

/**
 * Links a v1 key to a variant FROM the store's active map and copies the map exactly: its stock room onto the link and, only when
 * the variant has no rule row at all, its shape (direct / recipe / no_stock, item, recipe, quantity) as the variant's rule from now.
 * A variant that already has a rule keeps it (the rule is org-wide: another switched store may follow it); the difference is then
 * reported by the comparison, never overwritten. `pos_item_maps` is never touched.
 */
export async function seedLinkFromMap(
  actor: Actor,
  input: { storeId: string; posItemKey: string; variantId: string },
  tx?: Tx,
): Promise<{ id: string; ruleId: string | null }> {
  return inTx(tx, async (trx) => {
    const { store, key } = await beginLink(trx, actor, input);
    await requireFreeKey(trx, input.storeId, key, store.name);
    const map = await posMappingRepo.getActiveMapByKey(trx, input.storeId, key);
    if (!map) {
      throw refuse(`seedLinkFromMap: no active POS item map for "${key}" at ${store.name}.`, `${store.name} has no POS item map for "${key}", so there is nothing to copy. Map it first, or link it to a rule you set yourself.`);
    }
    const variant = await menuRepo.getVariantForUpdate(trx, actor.orgId, input.variantId);
    if (!variant) throw gone(`seedLinkFromMap: variant ${input.variantId} does not exist.`, 'menu item');
    await menuRepo.lockKey(trx, input.variantId);

    let ruleId: string | null = null;
    if ((await menuRepo.ruleRowCount(trx, input.variantId)) === 0) {
      // The map becomes an org rule: it must be a whole, usable shape (a sentence, never a raw database error).
      const incomplete = (what: string) =>
        refuse(`seedLinkFromMap: the map for "${key}" is ${what}.`, `The POS item map for "${key}" is incomplete (${what}), so it cannot become a menu rule. Fix the map first.`);
      if (map.mode === 'direct' && (!map.itemId || map.quantityPerSale === null)) throw incomplete('a stock-item map with no item or no quantity');
      if (map.mode === 'recipe' && !map.recipeId) throw incomplete('a recipe map with no recipe');
      if (map.mode === 'direct') parseMenuQuantity(map.quantityPerSale, `seedLinkFromMap: the map quantity for "${key}"`, 'The quantity per sale on the POS item map');
      await requireUsableRuleTarget(trx, actor.orgId, { itemId: map.mode === 'direct' ? map.itemId : null, recipeId: map.mode === 'recipe' ? map.recipeId : null }, 'seedLinkFromMap');
      const rule = await menuRepo.insertRuleAtTxNow(trx, {
        orgId: actor.orgId,
        variantId: input.variantId,
        mode: map.mode,
        itemId: map.mode === 'direct' ? map.itemId : null,
        recipeId: map.mode === 'recipe' ? map.recipeId : null,
        quantityPerSale: map.mode === 'direct' && map.quantityPerSale !== null ? decimal(map.quantityPerSale, '14,6') : null,
        createdBy: actor.personId,
      });
      ruleId = rule.id;
      await audit(trx, actor, 'menu_depletion_rule_set', null, rule.id, null, rule);
    }
    const row = await menuRepo.insertPosV1Link(trx, { orgId: actor.orgId, storeId: input.storeId, posItemKey: key, variantId: input.variantId, locationId: map.locationId, createdBy: actor.personId });
    await audit(trx, actor, 'menu.pos_v1_link', input.storeId, row.id, null, { posItemKey: key, variantId: input.variantId, locationId: map.locationId, seededFromMap: map.id, ruleCreated: ruleId !== null });
    return { id: row.id, ruleId };
  });
}
