/** Server-only helpers for the item master. T-145. */
import {
  itemsRepo,
  type DuplicateCandidate,
  type ItemRequestRow,
  type ItemRow,
  type PriceObservation,
  type PriceMonth,
  type ResolvedSellability,
  type StoreSellabilityOverrideRow,
  type SupplierPrice,
} from '@shareat/db';
import { listStores, withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { withOrgPrincipal };

/** One store's view of an item — the RESOLVED answer, and the raw override behind it if any. */
export interface StoreSellabilityView {
  storeId: string;
  storeName: string;
  storeCode: string;
  resolved: ResolvedSellability;
  /** `null` when the store has said nothing and simply follows the organisation. */
  override: StoreSellabilityOverrideRow | null;
}

/**
 * ⭐ DEF-130. What each store does with this item. T-149's bulgogi case rendered: Lipa makes the
 * sauce and sells it wholesale; another branch buys it in. The override table stays EMPTY for a
 * store that agrees with the org, so most rows here carry `override: null`.
 */
export async function sellabilityByStore(orgId: string, itemId: string): Promise<StoreSellabilityView[]> {
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const overrides = await itemsRepo.listStoreSellabilityOverrides(tx, orgId, itemId);
    const byStore = new Map(overrides.map((o) => [o.storeId, o]));
    const out: StoreSellabilityView[] = [];
    for (const s of stores) {
      const resolved = await itemsRepo.sellabilityAt(tx, orgId, itemId, s.id);
      if (!resolved) continue;
      out.push({ storeId: s.id, storeName: s.name, storeCode: s.code, resolved, override: byStore.get(s.id) ?? null });
    }
    return out;
  });
}

/** "retail · wholesale", "wholesale", or "—" — plus "made, not bought" when nobody bills us for it. */
export function soldAsLabel(item: Pick<ItemRow, 'isPurchasable' | 'sellableRetail' | 'sellableWholesale'>): string {
  const sold = [item.sellableRetail && 'retail', item.sellableWholesale && 'wholesale'].filter(Boolean).join(' · ');
  const made = item.isPurchasable ? '' : 'made, not bought';
  return [sold || '—', made].filter(Boolean).join(' · ');
}

export async function listItems(orgId: string, includeInactive = true): Promise<ItemRow[]> {
  return withOrgPrincipal(orgId, (tx) => itemsRepo.listItems(tx, orgId, { includeInactive }));
}

export async function getItem(orgId: string, id: string): Promise<ItemRow | undefined> {
  return withOrgPrincipal(orgId, (tx) => itemsRepo.getItemById(tx, orgId, id));
}

export async function itemPrices(
  orgId: string,
  itemId: string,
): Promise<{ history: PriceObservation[]; movement: PriceMonth[]; bySupplier: SupplierPrice[] }> {
  return withOrgPrincipal(orgId, async (tx) => ({
    history: await itemsRepo.priceHistory(tx, orgId, itemId),
    movement: await itemsRepo.priceMovement(tx, orgId, itemId),
    bySupplier: await itemsRepo.priceBySupplier(tx, orgId, itemId),
  }));
}

/** Requests waiting for a super-admin. Everyone with manage_items may LOOK; only a super-admin decides. */
export async function pendingRequests(orgId: string): Promise<ItemRequestRow[]> {
  return withOrgPrincipal(orgId, (tx) => itemsRepo.listItemRequests(tx, orgId, { status: "requested" }));
}

/** The standing near-duplicate alert — a query, so it can never go stale. */
export async function duplicateCandidates(orgId: string): Promise<DuplicateCandidate[]> {
  return withOrgPrincipal(orgId, (tx) => itemsRepo.findDuplicateCandidates(tx, orgId));
}
