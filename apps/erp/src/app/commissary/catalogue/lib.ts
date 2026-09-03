/**
 * Server-only reads for the commissary-catalogue screen — T-171 / DEF-129, 2026-09-03.
 *
 * Mirrors `apps/erp/src/app/trade/orders/lib.ts`: every function here only reads, and every rule
 * it surfaces lives in `packages/domain/src/commissary/catalogue.ts` and is enforced there. Until
 * this screen existed, `upsertCommissaryLink` / `upsertOffering` / `upsertMap` (DEF-129) had ZERO
 * callers in `apps/` — every row in `commissary_item_map` was hand-run SQL.
 */
import { commissaryCatalogueRepo, itemsRepo, type ItemRow } from '@shareat/db';
import {
  listCategoriesGrouped,
  listStores,
  withOrgPrincipal,
  type CategoryOption,
  type StoreOption,
} from '../../expenses/lib';

export { peso } from '../../../lib/format';
export { listStores, withOrgPrincipal, listCategoriesGrouped };
export type { StoreOption, CategoryOption };

export interface ItemOption {
  id: string;
  code: string;
  name: string;
  baseUnit: string;
}

function toItemOption(i: ItemRow): ItemOption {
  return { id: i.id, code: i.code, name: i.name, baseUnit: i.baseUnit };
}

export interface CataloguePageData {
  /** Every branch linked to THIS commissary, either status — DEF-129's "table of branches
   *  linked to this commissary with status". */
  links: commissaryCatalogueRepo.LinkRow[];
  /** Every offering THIS commissary has ever made, active or not. */
  offerings: commissaryCatalogueRepo.OfferingRow[];
  /** The org's active items that are purchasable — what a NEW offering may name. */
  purchasableItems: ItemOption[];
}

/** Everything the Links and Offerings sections need, in one org-scoped transaction. */
export async function catalogueData(orgId: string, commissaryStoreId: string): Promise<CataloguePageData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [allLinks, offerings, items] = await Promise.all([
      commissaryCatalogueRepo.listLinks(tx, orgId),
      commissaryCatalogueRepo.listOfferings(tx, orgId, commissaryStoreId),
      itemsRepo.listItems(tx, orgId, { includeInactive: false }),
    ]);
    return {
      links: allLinks.filter((l) => l.commissaryStoreId === commissaryStoreId),
      offerings,
      purchasableItems: items.filter((i) => i.isPurchasable).map(toItemOption),
    };
  });
}

export interface MapPageData {
  map: commissaryCatalogueRepo.MapRow[];
  /** This commissary's ACTIVE offerings only — T-171 invariant 3: a map can only ever name
   *  something the commissary actually offers. */
  commissaryItems: ItemOption[];
  /** Every active item in the org — what the branch's own side of the map may be. */
  branchItems: ItemOption[];
}

/** Everything the Item map section needs for one (commissary, branch) pair. */
export async function mapData(
  orgId: string,
  commissaryStoreId: string,
  branchStoreId: string,
): Promise<MapPageData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [map, offerings, items] = await Promise.all([
      commissaryCatalogueRepo.listMap(tx, orgId, commissaryStoreId, branchStoreId),
      commissaryCatalogueRepo.listOfferings(tx, orgId, commissaryStoreId),
      itemsRepo.listItems(tx, orgId, { includeInactive: false }),
    ]);
    const commissaryItems: ItemOption[] = offerings
      .filter((o) => o.status === 'active' && o.itemStatus === 'active')
      .map((o) => ({ id: o.itemId, code: o.itemCode, name: o.itemName, baseUnit: o.baseUnit }));
    return { map, commissaryItems, branchItems: items.map(toItemOption) };
  });
}

/** The four groups, in the same fixed order every other screen shows them in
 *  (`apps/erp/src/app/expenses/new/page.tsx`). */
export const EXPENSE_GROUPS: readonly CategoryOption['group'][] = ['COGS', 'OPEX', 'PERSONAL', 'CAPEX'];
