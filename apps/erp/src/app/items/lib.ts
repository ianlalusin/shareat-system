/** Server-only helpers for the item master. T-145. */
import { itemsRepo, type ItemRow, type PriceObservation, type PriceMonth, type SupplierPrice } from '@shareat/db';
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
