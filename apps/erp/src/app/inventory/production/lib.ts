/**
 * Server-only reads for the production screen — T-176.
 *
 * Every rule lives in `packages/domain/src/production`; this file only reads.
 */
import { itemsRepo, productionRepo, stockUsageRepo } from '@shareat/db';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface ProductionItemOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly baseUnit: string;
}

export interface ProductionScreenData {
  readonly locations: { id: string; code: string; name: string }[];
  readonly items: ProductionItemOption[];
  readonly recipes: Awaited<ReturnType<typeof productionRepo.listRecipes>>;
  readonly records: Awaited<ReturnType<typeof productionRepo.listProductionRecords>>;
}

/** Everything the register + "New record" form needs, in one org-scoped transaction. */
export async function productionScreenData(orgId: string, storeId: string): Promise<ProductionScreenData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [locations, itemRows, recipes, records] = await Promise.all([
      stockUsageRepo.listOperatingLocations(tx, storeId),
      itemsRepo.listItems(tx, orgId, { includeInactive: false }),
      productionRepo.listRecipes(tx, orgId),
      productionRepo.listProductionRecords(tx, storeId),
    ]);
    return {
      locations,
      items: itemRows.map((i) => ({ id: i.id, code: i.code, name: i.name, kind: i.kind, baseUnit: i.baseUnit })),
      recipes,
      records,
    };
  });
}

export interface ProductionLineView {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly unit: string;
  readonly movementId: string | null;
  readonly revision: number;
  readonly reversedAt: Date | null;
}

export interface ProductionRecordDetail {
  readonly record: NonNullable<Awaited<ReturnType<typeof productionRepo.getProductionRecord>>>;
  readonly locationName: string;
  readonly lines: ProductionLineView[];
}

export async function productionRecordDetail(orgId: string, id: string): Promise<ProductionRecordDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const record = await productionRepo.getProductionRecord(tx, id);
    if (!record || record.orgId !== orgId) return null;

    const [rows, itemRows, locationName] = await Promise.all([
      productionRepo.listProductionRecordLines(tx, id),
      itemsRepo.listItems(tx, orgId, { includeInactive: true }),
      stockUsageRepo.locationName(tx, record.locationId),
    ]);
    const itemsById = new Map(itemRows.map((i) => [i.id, i]));
    const lines: ProductionLineView[] = rows.map((r) => {
      const item = itemsById.get(r.itemId);
      return {
        id: r.id,
        direction: r.direction,
        itemId: r.itemId,
        itemCode: item?.code ?? r.itemId,
        itemName: item?.name ?? '(unknown item)',
        quantity: r.quantity,
        unit: r.unit,
        movementId: r.movementId,
        revision: r.revision,
        reversedAt: r.reversedAt,
      };
    });

    return { record, locationName, lines };
  });
}
