/**
 * T-632 - "What this store sells": one store's view of the company menu, and the three switches on it. docs/tasks/632-store-menu-screen.md.
 *
 * Nothing new is stored. A variant is "on" at a store when it has a live offer (`menu_offers`), "off" when it has none or the newest row is a
 * withdrawal; a flavour is on when it has a live option offer. The writers below only call the existing `setMenuOffer`, `withdrawMenuOffer` and
 * `setOptionOffer` (each authorizes, validates, audits and appends history) inside ONE transaction, so a switch is all or nothing: a store never
 * ends up half-withdrawn. They authorize `set_menu_price` at the store first, so a refusal is the capability's, ahead of any other sentence.
 */
import { authorize, type Actor } from '@shareat/auth';
import { daypartsRepo, kitchenRepo, menuRepo, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { inTx, parseMenuAmount } from './shared';
import { compareMenuOrder, compareVariantOrder } from './order';
import { cancelScheduledOffer, cancelScheduledOptionOffer, setMenuOffer, setOptionOffer, withdrawMenuOffer } from './pricing';

export interface SwitchPrice {
  /** null or omitted = all day. */
  daypartId?: string | null;
  /** Text, at most two decimals. Omitted only for a refill. */
  amount?: string | null;
  bundleHeads?: number | null;
  extraHeadAmount?: string | null;
}

const slotKey = (daypartId: string | null | undefined): string => daypartId ?? '';

/** Switches a variant ON at a store (store channel): one offer per price given, one per daypart. A slot already live at the same price is left alone; a blank price withdraws a live slot. */
export async function switchVariantOn(
  actor: Actor,
  input: { storeId: string; variantId: string; prices: SwitchPrice[] },
  tx?: Tx,
): Promise<{ written: number }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    if (input.prices.length === 0) throw refuse('switchVariantOn: no price given.', 'Enter the price.');
    const keys = input.prices.map((p) => slotKey(p.daypartId));
    if (new Set(keys).size !== keys.length) throw refuse('switchVariantOn: a daypart is listed twice.', 'Each time of day can only be priced once.');
    const variant = await menuRepo.getVariant(trx, actor.orgId, input.variantId);
    if (!variant) throw gone(`switchVariantOn: variant ${input.variantId} does not exist.`, 'variant');
    const item = await menuRepo.getItem(trx, actor.orgId, variant.menuItemId);
    const isRefill = item?.itemType === 'refill';
    const live = (await menuRepo.offersInForce(trx, input.storeId, await menuRepo.dbNow(trx))).filter(
      (r) => r.variantId === input.variantId && r.channel === 'store' && !r.withdrawn,
    );
    // A blank price on a priced item means "not sold at that time of day": left out, but at least one must be given.
    const isBlank = (p: SwitchPrice) => p.amount == null || p.amount.trim() === '';
    if (!isRefill && input.prices.every(isBlank)) throw refuse('switchVariantOn: no price given.', 'Enter the price.');
    let written = 0;
    for (const p of input.prices) {
      const blank = isBlank(p);
      if (blank && !isRefill) {
        // Blank = not sold at that time of day: a slot that is live is withdrawn (the pairing rule applies), one that is not live stays unsold.
        if (live.some((r) => slotKey(r.daypartId) === slotKey(p.daypartId))) {
          await withdrawMenuOffer(actor, { storeId: input.storeId, variantId: input.variantId, channel: 'store', daypartId: p.daypartId ?? null }, trx);
          written += 1;
        }
        continue;
      }
      const amount = blank ? null : parseMenuAmount(p.amount, 'switchVariantOn: the price', 'The price', false);
      const heads = p.bundleHeads ?? undefined;
      const extra = p.extraHeadAmount ?? undefined;
      const same = live.find((r) => slotKey(r.daypartId) === slotKey(p.daypartId));
      if (same && same.amount === amount && (same.bundleHeads ?? undefined) === heads && (same.extraHeadAmount ?? undefined) === extra) continue;
      await setMenuOffer(
        actor,
        {
          storeId: input.storeId,
          variantId: input.variantId,
          channel: 'store',
          daypartId: p.daypartId ?? null,
          ...(amount !== null ? { amount } : {}),
          ...(heads !== undefined ? { bundleHeads: heads } : {}),
          ...(extra !== undefined ? { extraHeadAmount: extra } : {}),
        },
        trx,
      );
      written += 1;
    }
    return { written };
  });
}

/**
 * Switches a variant OFF at a store: cancels every FUTURE-dated row first (a scheduled price must not switch it back on, and a later row would
 * also block the withdrawal), then withdraws EVERY live row (each daypart, each channel), online first. History is kept; past sales are untouched.
 */
export async function switchVariantOff(actor: Actor, input: { storeId: string; variantId: string }, tx?: Tx): Promise<{ withdrawn: number; cancelled: number }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    if (!(await menuRepo.getVariant(trx, actor.orgId, input.variantId))) throw gone(`switchVariantOff: variant ${input.variantId} does not exist.`, 'variant');
    const now = await menuRepo.dbNow(trx);
    const later = (await menuRepo.offerHistory(trx, input.storeId, input.variantId)).filter((r) => r.effectiveFrom > now);
    for (const r of later) await cancelScheduledOffer(actor, { id: r.id, storeId: input.storeId }, trx);
    const live = (await menuRepo.offersInForce(trx, input.storeId, now)).filter((r) => r.variantId === input.variantId && !r.withdrawn);
    live.sort((a, b) => (a.channel === b.channel ? 0 : a.channel === 'online' ? -1 : 1));
    for (const r of live) await withdrawMenuOffer(actor, { storeId: input.storeId, variantId: input.variantId, channel: r.channel, daypartId: r.daypartId }, trx);
    return { withdrawn: live.length, cancelled: later.length };
  });
}

/** Switches a flavour (an option value) on at a store with its price difference (signed text, 0.00 for none), or off: future rows cancelled, every live channel withdrawn. */
export async function switchOptionValue(
  actor: Actor,
  input: { storeId: string; optionValueId: string; on: boolean; priceDelta?: string },
  tx?: Tx,
): Promise<{ written: number }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    if (input.on) {
      if (input.priceDelta === undefined || input.priceDelta.trim() === '') throw refuse('switchOptionValue: no price change given.', 'Enter the price change (0.00 for none).');
      await setOptionOffer(actor, { storeId: input.storeId, optionValueId: input.optionValueId, channel: 'store', priceDelta: input.priceDelta }, trx);
      return { written: 1 };
    }
    const now = await menuRepo.dbNow(trx);
    for (const r of await menuRepo.scheduledOptionOffers(trx, input.storeId, input.optionValueId, now)) await cancelScheduledOptionOffer(actor, { id: r.id, storeId: input.storeId }, trx);
    const live = (await menuRepo.optionOffersInForce(trx, input.storeId, now)).filter((r) => r.optionValueId === input.optionValueId);
    for (const r of live) await setOptionOffer(actor, { storeId: input.storeId, optionValueId: input.optionValueId, channel: r.channel, priceDelta: null }, trx);
    return { written: live.length };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------------------------------------------------
export interface SellsSlot {
  /** null = all day. */
  daypartId: string | null;
  daypartName: string | null;
  amount: string | null;
  bundleHeads: number | null;
  extraHeadAmount: string | null;
}

export interface SellsVariant {
  variantId: string;
  label: string | null;
  /** A live offer on either channel. */
  on: boolean;
  /** Live online but not on the store channel: not on the tablet. */
  onlineOnly: boolean;
  /** Its live store rows are tied to dayparts: switching it on or off changes the structure (a super admin's, R8). */
  dayparted: boolean;
  /** The rows the price dialog shows: the live ones, else the store's dayparts (or all day), prefilled when a price is known. */
  formSlots: SellsSlot[];
  /** Where an off variant's prefill came from; null when nothing is known. */
  prefill: { from: 'last_here' | 'other_store'; storeName: string | null } | null;
}

export interface SellsFlavour {
  optionValueId: string;
  name: string;
  on: boolean;
  /** Signed text when on. */
  priceDelta: string | null;
}

export interface SellsItem {
  itemId: string;
  name: string;
  itemType: 'a_la_carte' | 'package' | 'refill';
  categoryId: string;
  variants: SellsVariant[];
  /** Some variant is on. */
  on: boolean;
  /** On the store channel but no route to an active kitchen station: the POS leaves it out (project.ts R5). */
  noStation: boolean;
  flavourGroups: { groupId: string; name: string; values: SellsFlavour[] }[];
}

export interface StoreSells {
  categories: { id: string; name: string }[];
  items: SellsItem[];
  /** The store has active dayparts, so a new price is asked per daypart. */
  hasDayparts: boolean;
}

type LastPrice = Awaited<ReturnType<typeof menuRepo.lastStorePrices>>[number];

/**
 * Everything the screen draws for one store. `otherStores` are the stores the viewer may see (never the store itself): the first one that ever priced an
 * off variant offers its price as a suggestion, a daypart matched by name (as the copy tool does). Plain reads, no authorization: the page gates the store.
 */
export async function loadStoreSells(tx: Tx, orgId: string, storeId: string, otherStores: { id: string; name: string }[]): Promise<StoreSells> {
  const now = await menuRepo.dbNow(tx);
  const [catalog, offers, optionOffers, daypartRows, stations, routes, lastHere] = await Promise.all([
    menuRepo.catalogOfOrg(tx, orgId),
    menuRepo.offersInForce(tx, storeId, now),
    menuRepo.optionOffersInForce(tx, storeId, now),
    daypartsRepo.listDaypartsOfStore(tx, orgId, storeId),
    kitchenRepo.listStations(tx, orgId, storeId),
    kitchenRepo.listRoutes(tx, orgId, storeId),
    menuRepo.lastStorePrices(tx, storeId, now),
  ]);
  const dayparts = daypartRows.filter((d) => d.status === 'active');
  const nameOfDaypart = new Map(daypartRows.map((d) => [d.id, d.name]));
  const others = await Promise.all(
    otherStores
      .filter((s) => s.id !== storeId)
      .map(async (s) => ({
        name: s.name,
        prices: await menuRepo.lastStorePrices(tx, s.id, now),
        dayparts: await daypartsRepo.listDaypartsOfStore(tx, orgId, s.id),
      })),
  );

  const activeStations = new Set(stations.map((s) => s.id)); // listStations: active only
  const routed = new Set(routes.filter((r) => activeStations.has(r.stationId)).map((r) => r.menuItemId));
  const categories = catalog.categories.filter((c) => c.status === 'active').sort(compareMenuOrder);
  const activeCategory = new Set(categories.map((c) => c.id));

  const slotOf = (daypartId: string | null, r?: { amount: string | null; bundleHeads: number | null; extraHeadAmount: string | null }): SellsSlot => ({
    daypartId,
    daypartName: daypartId ? (nameOfDaypart.get(daypartId) ?? null) : null,
    amount: r?.amount ?? null,
    bundleHeads: r?.bundleHeads ?? null,
    extraHeadAmount: r?.extraHeadAmount ?? null,
  });
  /** The price a slot starts from: the same daypart, else the all-day price, else (for all day) any price. */
  const pick = (rows: LastPrice[], variantId: string, daypartId: string | null, daypartName: string | null, rowDaypartName: (id: string) => string | undefined): LastPrice | undefined => {
    const mine = rows.filter((r) => r.variantId === variantId);
    return (
      mine.find((r) => r.daypartId !== null && daypartName !== null && rowDaypartName(r.daypartId)?.toLowerCase() === daypartName.toLowerCase()) ??
      mine.find((r) => r.daypartId === daypartId) ??
      mine.find((r) => r.daypartId === null) ??
      (daypartId === null ? mine[0] : undefined)
    );
  };

  const items: SellsItem[] = [];
  for (const item of catalog.items.filter((i) => i.status === 'active').sort(compareMenuOrder)) {
    const vrows = catalog.variants.filter((v) => v.menuItemId === item.id && v.status === 'active').sort(compareVariantOrder);
    if (vrows.length === 0) continue;
    const variants: SellsVariant[] = vrows.map((v) => {
      const mine = offers.filter((r) => r.variantId === v.id && !r.withdrawn);
      const storeRows = mine.filter((r) => r.channel === 'store');
      let formSlots: SellsSlot[];
      let prefill: SellsVariant['prefill'] = null;
      if (storeRows.length > 0) {
        formSlots = storeRows.map((r) => slotOf(r.daypartId, r));
      } else {
        const base = item.itemType === 'refill' || dayparts.length === 0 ? [null] : dayparts.map((d) => d.id);
        formSlots = base.map((id) => {
          if (item.itemType === 'refill') return slotOf(null);
          const name = id ? (nameOfDaypart.get(id) ?? null) : null;
          const here = pick(lastHere, v.id, id, name, (d) => nameOfDaypart.get(d));
          if (here) {
            prefill = { from: 'last_here', storeName: null };
            return slotOf(id, here);
          }
          for (const o of others) {
            const found = pick(o.prices, v.id, id, name, (d) => o.dayparts.find((x) => x.id === d)?.name);
            if (found) {
              prefill = prefill?.from === 'last_here' ? prefill : { from: 'other_store', storeName: o.name };
              return slotOf(id, found);
            }
          }
          return slotOf(id);
        });
      }
      return {
        variantId: v.id,
        label: v.label,
        on: mine.length > 0,
        onlineOnly: mine.length > 0 && storeRows.length === 0,
        dayparted: mine.some((r) => r.daypartId !== null),
        formSlots,
        prefill,
      };
    });
    const variantIds = new Set(vrows.map((v) => v.id));
    const itemLinks = catalog.optionGroupLinks.filter((l) => l.menuItemId === item.id || (l.variantId !== null && variantIds.has(l.variantId)));
    const groupIds = new Set(itemLinks.map((l) => l.optionGroupId));
    // T-653: a link limited to some flavours shows only those; a group reached by several links shows the union (an unlimited link shows them all).
    const limitedBy = new Map<string, Set<string>>();
    for (const r of catalog.optionLinkValues) {
      const set = limitedBy.get(r.linkId) ?? new Set<string>();
      set.add(r.optionValueId);
      limitedBy.set(r.linkId, set);
    }
    const allowedIn = (groupId: string): Set<string> | null => {
      const union = new Set<string>();
      for (const l of itemLinks.filter((x) => x.optionGroupId === groupId)) {
        const only = limitedBy.get(l.id);
        if (!only) return null;
        for (const id of only) union.add(id);
      }
      return union;
    };
    const flavourGroups = catalog.optionGroups
      .filter((g) => g.status === 'active' && groupIds.has(g.id))
      .map((g) => ({
        groupId: g.id,
        name: g.name,
        values: catalog.optionValues
          .filter((ov) => ov.optionGroupId === g.id && ov.status === 'active' && (allowedIn(g.id)?.has(ov.id) ?? true))
          .sort(compareMenuOrder)
          .map((ov) => {
            const live = optionOffers.find((o) => o.optionValueId === ov.id && o.channel === 'store');
            return { optionValueId: ov.id, name: ov.name, on: live !== undefined, priceDelta: live?.priceDelta ?? null };
          }),
      }))
      .filter((g) => g.values.length > 0);
    const storeLive = variants.some((v) => v.on && !v.onlineOnly);
    items.push({
      itemId: item.id,
      name: item.name,
      itemType: item.itemType,
      categoryId: item.categoryId,
      variants,
      on: variants.some((v) => v.on),
      noStation: storeLive && !routed.has(item.id) && activeCategory.has(item.categoryId),
      flavourGroups,
    });
  }
  return { categories: categories.map((c) => ({ id: c.id, name: c.name })), items: items.filter((i) => activeCategory.has(i.categoryId)), hasDayparts: dayparts.length > 0 };
}
