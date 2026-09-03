/**
 * Server-only reads for the stock-locations screen — T-160 / DEF-135, 2026-09-03.
 *
 * Mirrors `apps/erp/src/app/commissary/catalogue/lib.ts`: every function here only reads, and
 * every rule it surfaces lives in `packages/domain/src/stock-locations/service.ts` and is
 * enforced there. Until this screen existed, `createLocation`/`updateLocation`/`setDefault`/
 * `deactivateLocation` had ZERO callers anywhere in `apps/` — the only writer of a real
 * `stock_locations` row was a raw SQL insert in a dev-seed script (DEF-135).
 */
import { stockLocationsRepo, type Tx } from '@shareat/db';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface LocationsPageData {
  stockModel: 'single_room' | 'multi_room';
  locations: stockLocationsRepo.LocationRow[];
  types: stockLocationsRepo.LocationTypeRow[];
}

/** Everything the screen needs for one store, in one org-scoped transaction. `null` if the store
 *  does not exist (defensive only — `page.tsx` validates `storeId` against `listStores` first). */
export async function locationsPageData(orgId: string, storeId: string): Promise<LocationsPageData | null> {
  return withOrgPrincipal(orgId, async (tx: Tx) => {
    const store = await stockLocationsRepo.getStoreStockModel(tx, storeId);
    if (!store) return null;
    const [locations, types] = await Promise.all([
      stockLocationsRepo.listLocations(tx, storeId),
      stockLocationsRepo.listLocationTypes(tx, orgId),
    ]);
    return { stockModel: store.stockModel, locations, types };
  });
}
