/** Server-only helpers for the item master. T-145. */
import {
  itemsRepo,
  type DuplicateCandidate,
  type ItemRequestRow,
  type ItemRow,
  type PriceObservation,
  type PriceMonth,
  type SupplierPrice,
} from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { withOrgPrincipal };

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
