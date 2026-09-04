/**
 * Server-only reads for the daily POS usage pull screen — T-177.
 */
import { eq, inArray } from 'drizzle-orm';
import { posMappingRepo, salesDaysRepo, schema, stockUsageRepo } from '@shareat/db';
import { buildPlan } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface SalesDayOption {
  readonly id: string;
  readonly businessDate: string;
  readonly status: string;
}

export async function listSalesDaysForStore(orgId: string, storeId: string): Promise<SalesDayOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await salesDaysRepo.listSalesDays(tx, { orgId, storeId, limit: 60 });
    return rows.map((r) => ({ id: r.id, businessDate: r.businessDate, status: r.status }));
  });
}

export async function listOperatingLocationsForStore(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => stockUsageRepo.listOperatingLocations(tx, storeId));
}

export async function buildPlanForDay(
  orgId: string,
  actor: Actor,
  input: { storeId: string; salesDayId: string; locationId: string },
) {
  return withOrgPrincipal(orgId, (tx) => buildPlan(tx, actor, { orgId, ...input }));
}

export interface PullLineView {
  readonly lineKey: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly itemName: string | null;
  readonly locationName: string | null;
  readonly quantity: string | null;
  readonly usageRecordId: string | null;
  readonly blocked: { reason: string } | null;
}

export interface PullView {
  readonly id: string;
  readonly status: string;
  readonly salesDayId: string;
  readonly snapshotTakenAt: Date;
  readonly directFinalizedAt: Date | null;
  readonly recipeFinalizedAt: Date | null;
  readonly orphanFinalizedAt: Date | null;
  readonly direct: PullLineView[];
  readonly recipe: PullLineView[];
  readonly orphan: PullLineView[];
}

export async function pullView(orgId: string, pullId: string): Promise<PullView | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const pull = await posMappingRepo.getPull(tx, pullId);
    if (!pull) return null;
    const lines = await posMappingRepo.listPullLines(tx, pullId);

    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
    const locationIds = [...new Set(lines.map((l) => l.locationId).filter((v): v is string => !!v))];
    const [itemRows, locationRows] = await Promise.all([
      itemIds.length ? tx.select({ id: schema.items.id, name: schema.items.name }).from(schema.items).where(inArray(schema.items.id, itemIds)) : Promise.resolve([]),
      locationIds.length
        ? tx.select({ id: schema.stockLocations.id, name: schema.stockLocations.name }).from(schema.stockLocations).where(inArray(schema.stockLocations.id, locationIds))
        : Promise.resolve([]),
    ]);
    const itemNameById = new Map(itemRows.map((r) => [r.id, r.name]));
    const locationNameById = new Map(locationRows.map((r) => [r.id, r.name]));

    const toView = (l: (typeof lines)[number]): PullLineView => ({
      lineKey: l.lineKey,
      posItemKey: l.posItemKey,
      posItemName: l.posItemName,
      itemName: l.itemId ? (itemNameById.get(l.itemId) ?? l.itemId) : null,
      locationName: l.locationId ? (locationNameById.get(l.locationId) ?? l.locationId) : null,
      quantity: l.quantity,
      usageRecordId: l.usageRecordId,
      blocked: l.blocked,
    });

    return {
      id: pull.id,
      status: pull.status,
      salesDayId: pull.salesDayId,
      snapshotTakenAt: pull.snapshotTakenAt,
      directFinalizedAt: pull.directFinalizedAt,
      recipeFinalizedAt: pull.recipeFinalizedAt,
      orphanFinalizedAt: pull.orphanFinalizedAt,
      direct: lines.filter((l) => l.section === 'direct').map(toView),
      recipe: lines.filter((l) => l.section === 'recipe').map(toView),
      orphan: lines.filter((l) => l.section === 'orphan').map(toView),
    };
  });
}

export async function findLivePull(orgId: string, storeId: string, salesDayId: string) {
  return withOrgPrincipal(orgId, (tx) => posMappingRepo.findLivePullForDay(tx, storeId, salesDayId));
}
