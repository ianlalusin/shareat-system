/**
 * Server-only reads for the POS item mapping screen — T-177.
 */
import { itemsRepo, posMappingRepo, productionRepo, stockUsageRepo } from '@shareat/db';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface PosMapScreenData {
  readonly maps: Awaited<ReturnType<typeof posMappingRepo.listMapsForStore>>;
  readonly requests: Awaited<ReturnType<typeof posMappingRepo.listRequestsForStore>>;
  readonly items: { id: string; code: string; name: string }[];
  readonly recipes: { id: string; name: string }[];
  readonly locations: { id: string; code: string; name: string }[];
}

export async function posMapScreenData(orgId: string, storeId: string): Promise<PosMapScreenData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [maps, requests, itemRows, recipeRows, locations] = await Promise.all([
      posMappingRepo.listMapsForStore(tx, storeId),
      posMappingRepo.listRequestsForStore(tx, storeId),
      itemsRepo.listItems(tx, orgId, { includeInactive: false }),
      productionRepo.listRecipes(tx, orgId, false),
      stockUsageRepo.listOperatingLocations(tx, storeId),
    ]);
    return {
      maps,
      requests,
      items: itemRows.map((i) => ({ id: i.id, code: i.code, name: i.name })),
      recipes: recipeRows.map((r) => ({ id: r.id, name: r.name })),
      locations,
    };
  });
}
