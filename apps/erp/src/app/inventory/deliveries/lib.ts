/**
 * Server-only reads for the deliveries screen — T-166 / DEF-135.
 *
 * ⭐ Until this file existed, `createDeliveryDocument`/`receiveDeliveryDocument` (this same task)
 * and the engine underneath them (`receiveDelivery`, `duplicateRisk` — built and tested since
 * 2026-08-29) had zero UI callers. These helpers only read; every rule they surface lives in
 * `packages/domain` and is enforced there.
 */
import { apRepo, deliveriesRepo, itemsRepo, stockLocationsRepo, type Tx } from '@shareat/db';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };
export type DeliveryDocument = deliveriesRepo.DeliveryDocument;
export type DeliveryListRow = deliveriesRepo.DeliveryListRow;

export interface DeliveryItemOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly baseUnit: string;
}

export interface DeliverySupplierOption {
  readonly id: string;
  readonly name: string;
}

export interface DeliveryLocationOption {
  readonly id: string;
  readonly name: string;
}

export interface DeliveryFormData {
  readonly items: DeliveryItemOption[];
  readonly suppliers: DeliverySupplierOption[];
  readonly locations: DeliveryLocationOption[];
}

async function activeLocations(tx: Tx, storeId: string): Promise<DeliveryLocationOption[]> {
  const rows = await stockLocationsRepo.listActiveLocations(tx, storeId);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Everything the "New delivery" form needs, in one org-scoped transaction. */
export async function deliveryFormData(orgId: string, storeId: string): Promise<DeliveryFormData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [itemRows, supplierRows, locations] = await Promise.all([
      itemsRepo.listItems(tx, orgId, { includeInactive: false }),
      apRepo.listSuppliers(tx, orgId),
      activeLocations(tx, storeId),
    ]);
    return {
      // ⭐ Only what may actually be bought — T-149's `isPurchasable` flag, same gate the AP
      // invoice screen and trade orders already respect for their own item pickers.
      items: itemRows
        .filter((i) => i.isPurchasable)
        .map((i) => ({ id: i.id, code: i.code, name: i.name, baseUnit: i.baseUnit })),
      suppliers: supplierRows.map((s) => ({ id: s.id, name: s.name })),
      locations,
    };
  });
}

/** Newest first, for the register. */
export async function deliveryRegister(orgId: string, storeId: string): Promise<DeliveryListRow[]> {
  return withOrgPrincipal(orgId, (tx) => deliveriesRepo.listDeliveries(tx, storeId));
}

export interface DeliveryDetail {
  readonly doc: DeliveryDocument;
  readonly locations: DeliveryLocationOption[];
}

export async function deliveryDetail(orgId: string, id: string): Promise<DeliveryDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const doc = await deliveriesRepo.getDeliveryDocument(tx, id);
    // ⭐ The RLS principal already confines the read to this org, but a stray delivery from another
    // org's id space returning `undefined` above is the same "not found" a wrong id would be —
    // never a 500, never a cross-org leak of "it exists, you just can't see it."
    if (!doc) return null;
    const locations = await activeLocations(tx, doc.storeId);
    return { doc, locations };
  });
}
