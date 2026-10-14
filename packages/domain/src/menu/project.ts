/**
 * T-401 S3 - the store-menu projection (pure). docs/tasks/401-erp-menu-catalog-master.md "S3 projection types".
 *
 * PURE and carrier-neutral (I14): no database, no clock, no Firestore, no network. It takes a plain snapshot and returns the menu
 * plus its content hash. Money is never computed here: every price comes from `resolveOfferPrice`.
 */
import { createHash } from 'node:crypto';
import { internalFault } from '../shared/refusal-leaf';
import { resolveOfferPrice, type ResolvableOffer } from './resolve-price';

type Status = 'active' | 'retired';
type Channel = 'store' | 'online';
type ItemType = 'a_la_carte' | 'package' | 'refill';

export interface MenuSnapshot {
  readonly categories: readonly { id: string; name: string; parentId: string | null; sortOrder: number; status: Status }[];
  readonly items: readonly {
    id: string; categoryId: string; name: string; description: string | null; itemType: ItemType;
    soldALaCarte: boolean; soldInPackageSession: boolean; dinerOrderable: boolean; sortOrder: number; status: Status;
  }[];
  readonly variants: readonly { id: string; menuItemId: string; label: string | null; isDefault: boolean; sortOrder: number; status: Status }[];
  readonly optionGroups: readonly { id: string; name: string; selectionMode: 'single' | 'multi'; minSelections: number; maxSelections: number; status: Status }[];
  readonly optionValues: readonly { id: string; optionGroupId: string; name: string; sortOrder: number; status: Status }[];
  readonly optionGroupLinks: readonly { id: string; optionGroupId: string; menuItemId: string | null; variantId: string | null; sortOrder: number; status: Status }[];
  readonly packageRefills: readonly { packageVariantId: string; refillItemId: string; status: Status }[];
  readonly stores: readonly StoreOffersAt[];
}

type OfferRow = ResolvableOffer & { variantId: string; channel: Channel; effectiveFrom: Date };

export interface StoreOffersAt {
  readonly storeId: string;
  /** The instant offersInForce / optionOffersInForce were read at. */
  readonly at: Date;
  readonly offers: readonly OfferRow[];
  readonly optionOffers: readonly { optionValueId: string; channel: Channel; priceDelta: string }[];
  /** effective_from of every offer and option-offer row of this store later than `at`, both channels. */
  readonly upcoming: readonly Date[];
}

export type MenuNotOfferedReason = 'no_offer' | 'withdrawn' | 'no_basis' | 'rule_below_zero';
export type ChannelOffer =
  | { orderable: true; amount: string | null; bundleHeads: number | null; extraHeadAmount: string | null }
  | { orderable: false; notOffered: MenuNotOfferedReason };
export type ChannelDelta = { orderable: true; priceDelta: string } | { orderable: false; notOffered: 'no_offer' };

export interface StoreMenuV1 { schemaVersion: 1; storeId: string; categories: ProjectedCategory[]; items: ProjectedItem[] }
export interface ProjectedCategory { id: string; name: string; parentId: string | null; sortOrder: number }
export interface ProjectedItem {
  id: string; categoryId: string; name: string; description: string | null; itemType: ItemType;
  soldALaCarte: boolean; soldInPackageSession: boolean; dinerOrderable: boolean; sortOrder: number; variants: ProjectedVariant[];
}
export interface ProjectedVariant {
  id: string; label: string | null; isDefault: boolean; sortOrder: number;
  channels: { store: ChannelOffer; online: ChannelOffer }; optionGroups: ProjectedOptionGroup[]; refillItemIds: string[];
}
export interface ProjectedOptionGroup {
  id: string; name: string; selectionMode: 'single' | 'multi'; minSelections: number; maxSelections: number;
  values: { id: string; name: string; sortOrder: number; channels: { store: ChannelDelta; online: ChannelDelta } }[];
}
export interface ProjectedStoreMenu { menu: StoreMenuV1; contentHash: string; nextChangeAt: string | null }

/** UTF-16 code unit comparison, never localeCompare. */
const cmp = (a: string, b: string): number => (a === b ? 0 : [a, b].sort()[0] === a ? -1 : 1); // default sort = UTF-16 code units, no relational operator
const cmpNum = (a: number, b: number): number => a - b;
const key = (id: string, channel: Channel): string => `${id}|${channel}`;

/** Object keys sorted by code unit at every depth, no whitespace, undefined never emitted. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmp);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

function channelOffer(row: OfferRow | undefined): ChannelOffer {
  if (!row) return { orderable: false, notOffered: 'no_offer' };
  const r = resolveOfferPrice(row);
  if ('notOffered' in r) return { orderable: false, notOffered: r.notOffered };
  return { orderable: true, amount: r.amount, bundleHeads: r.bundleHeads, extraHeadAmount: r.extraHeadAmount };
}

function channelDelta(delta: string | undefined): ChannelDelta {
  return delta === undefined ? { orderable: false, notOffered: 'no_offer' } : { orderable: true, priceDelta: delta };
}

export function projectStoreMenu(snapshot: MenuSnapshot, storeId: string, at: Date): ProjectedStoreMenu {
  const entry = snapshot.stores.find((s) => s.storeId === storeId);
  if (!entry) throw internalFault(`projectStoreMenu: store ${storeId} is not in the snapshot`);
  if (entry.at.getTime() !== at.getTime()) {
    throw internalFault('projectStoreMenu: `at` differs from the instant the offers were read at');
  }

  const offerAt = new Map<string, OfferRow>();
  for (const o of entry.offers) offerAt.set(key(o.variantId, o.channel), o);
  const optAt = new Map<string, string>();
  for (const o of entry.optionOffers) optAt.set(key(o.optionValueId, o.channel), o.priceDelta);

  const itemById = new Map(snapshot.items.map((i) => [i.id, i]));
  const groupById = new Map(snapshot.optionGroups.map((g) => [g.id, g]));
  const activeLinks = snapshot.optionGroupLinks.filter((l) => l.status === 'active');

  // Which variants appear: active, item active, orderable on at least one channel.
  const appearing = new Map<string, { variant: MenuSnapshot['variants'][number]; channels: { store: ChannelOffer; online: ChannelOffer } }>();
  for (const v of snapshot.variants) {
    const item = itemById.get(v.menuItemId);
    if (v.status !== 'active' || !item || item.status !== 'active') continue;
    const channels = {
      store: channelOffer(offerAt.get(key(v.id, 'store'))),
      online: channelOffer(offerAt.get(key(v.id, 'online'))),
    };
    if (!channels.store.orderable && !channels.online.orderable) continue;
    appearing.set(v.id, { variant: v, channels });
  }
  const appearingItemIds = new Set<string>();
  for (const { variant } of appearing.values()) appearingItemIds.add(variant.menuItemId);

  // Package -> refill rows (I10): only refill items that appear; empty never means all.
  const refillsOf = new Map<string, string[]>();
  for (const r of snapshot.packageRefills) {
    if (r.status !== 'active' || !appearingItemIds.has(r.refillItemId)) continue;
    const list = refillsOf.get(r.packageVariantId) ?? [];
    list.push(r.refillItemId);
    refillsOf.set(r.packageVariantId, list);
  }

  // I9: a variant's own active links replace its item's links; never the union.
  const groupsFor = (variantId: string, itemId: string): ProjectedOptionGroup[] => {
    const own = activeLinks.filter((l) => l.variantId === variantId);
    const links = own.length > 0 ? own : activeLinks.filter((l) => l.menuItemId === itemId && l.variantId === null);
    const nameOf = (id: string): string => groupById.get(id)?.name ?? '';
    const ordered = [...links].sort(
      (a, b) => cmpNum(a.sortOrder, b.sortOrder) || cmp(nameOf(a.optionGroupId), nameOf(b.optionGroupId)) || cmp(a.optionGroupId, b.optionGroupId),
    );
    const seen = new Set<string>();
    const out: ProjectedOptionGroup[] = [];
    for (const l of ordered) {
      const g = groupById.get(l.optionGroupId);
      if (!g || g.status !== 'active' || seen.has(g.id)) continue;
      seen.add(g.id);
      const values = snapshot.optionValues
        .filter((ov) => ov.optionGroupId === g.id && ov.status === 'active')
        .map((ov) => ({
          id: ov.id,
          name: ov.name,
          sortOrder: ov.sortOrder,
          channels: {
            store: channelDelta(optAt.get(key(ov.id, 'store'))),
            online: channelDelta(optAt.get(key(ov.id, 'online'))),
          },
        }))
        .filter((v) => v.channels.store.orderable || v.channels.online.orderable)
        .sort((a, b) => cmpNum(a.sortOrder, b.sortOrder) || cmp(a.name, b.name) || cmp(a.id, b.id));
      out.push({ id: g.id, name: g.name, selectionMode: g.selectionMode, minSelections: g.minSelections, maxSelections: g.maxSelections, values });
    }
    return out;
  };

  const items: ProjectedItem[] = snapshot.items
    .filter((i) => appearingItemIds.has(i.id) && snapshot.categories.some((c) => c.id === i.categoryId && c.status === 'active'))
    .map((i) => {
      const variants: ProjectedVariant[] = [...appearing.values()]
        .filter(({ variant }) => variant.menuItemId === i.id)
        .map(({ variant: v, channels }) => ({
          id: v.id,
          label: v.label,
          isDefault: v.isDefault,
          sortOrder: v.sortOrder,
          channels,
          optionGroups: groupsFor(v.id, i.id),
          refillItemIds: i.itemType === 'package' ? [...(refillsOf.get(v.id) ?? [])].sort(cmp) : [],
        }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || cmpNum(a.sortOrder, b.sortOrder) || cmp(a.label ?? '', b.label ?? '') || cmp(a.id, b.id));
      return {
        id: i.id,
        categoryId: i.categoryId,
        name: i.name,
        description: i.description,
        itemType: i.itemType,
        soldALaCarte: i.soldALaCarte,
        soldInPackageSession: i.soldInPackageSession,
        dinerOrderable: i.dinerOrderable,
        sortOrder: i.sortOrder,
        variants,
      };
    })
    .sort((a, b) => cmpNum(a.sortOrder, b.sortOrder) || cmp(a.name, b.name) || cmp(a.id, b.id));

  // A category appears iff it holds an appearing item or parents (at any depth) an appearing category.
  const catById = new Map(snapshot.categories.map((c) => [c.id, c]));
  const catAppears = new Set<string>();
  for (const i of items) {
    const guard = new Set<string>();
    let id: string | null = i.categoryId;
    while (id !== null && !guard.has(id)) {
      guard.add(id);
      const c = catById.get(id);
      if (!c) break;
      catAppears.add(c.id);
      id = c.parentId;
    }
  }
  const flat: ProjectedCategory[] = snapshot.categories
    .filter((c) => c.status === 'active' && catAppears.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder }))
    .sort((a, b) => cmpNum(a.sortOrder, b.sortOrder) || cmp(a.name, b.name) || cmp(a.id, b.id));
  // Tree order: parents before children, siblings by (sortOrder, name, id); a category whose parent is absent is a root.
  const flatIds = new Set(flat.map((c) => c.id));
  const kids = new Map<string | null, ProjectedCategory[]>();
  for (const c of flat) {
    const k = c.parentId !== null && flatIds.has(c.parentId) && c.parentId !== c.id ? c.parentId : null;
    kids.set(k, [...(kids.get(k) ?? []), c]);
  }
  const categories: ProjectedCategory[] = [];
  const placed = new Set<string>();
  const walk = (parent: string | null): void => {
    for (const c of kids.get(parent) ?? []) {
      if (placed.has(c.id)) continue;
      placed.add(c.id);
      categories.push(c);
      walk(c.id);
    }
  };
  walk(null);
  for (const c of flat) if (!placed.has(c.id)) categories.push(c); // cycle guard

  const menu: StoreMenuV1 = { schemaVersion: 1, storeId, categories, items };
  const contentHash = createHash('sha256').update(canonicalJson(menu), 'utf8').digest('hex');

  let next: number | null = null;
  for (const d of entry.upcoming) {
    const t = d.getTime();
    if (t > at.getTime() && (next === null || t < next)) next = t;
  }
  return { menu, contentHash, nextChangeAt: next === null ? null : new Date(next).toISOString() };
}
