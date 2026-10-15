/**
 * Server-only reads for the daily POS usage pull screen — T-177.
 */
import { eq, inArray } from 'drizzle-orm';
import { posMappingRepo, posV1Repo, salesDaysRepo, schema, stockUsageRepo } from '@shareat/db';
import type { PosV1FeedPurpose } from '@shareat/db/schema';
import { buildPlan } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface SalesDayOption {
  readonly id: string;
  readonly businessDate: string;
  readonly status: string;
  /** T-373 S1: a voided day kept only because it carries a live pull — readable, never writable. */
  readonly viewOnly?: boolean;
}

export async function listSalesDaysForStore(orgId: string, storeId: string): Promise<SalesDayOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await salesDaysRepo.listSalesDays(tx, { orgId, storeId, limit: 60 });
    const voidedIds = rows.filter((r) => r.status === 'voided').map((r) => r.id);
    const withPull = await posMappingRepo.listDayIdsWithLivePull(tx, storeId, voidedIds);
    // On a business_date tie, live days sort before view-only voided ones (the page defaults to the first row).
    const rank = (r: { status: string }) => (r.status === 'voided' ? 1 : 0);
    return [...rows]
      .sort((a, b) => (a.businessDate === b.businessDate ? rank(a) - rank(b) : b.businessDate.localeCompare(a.businessDate)))
      .filter((r) => r.status !== 'voided' || withPull.has(r.id))
      .map((r) => ({ id: r.id, businessDate: r.businessDate, status: r.status, ...(r.status === 'voided' ? { viewOnly: true } : {}) }));
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
  /** T-401 S6: the status of the usage record this line went into ('draft' until a manager or the auto-post posts it). */
  readonly recordStatus: string | null;
  readonly blocked: { reason: string } | null;
}

export interface PullView {
  readonly id: string;
  readonly status: string;
  readonly salesDayId: string;
  readonly snapshotTakenAt: Date;
  /** T-375 S5: the stored sold-items feed the plan was built from; null on a pull made before S5-lite. */
  readonly soldItemsFeed: { readonly fetchedAt: Date; readonly purpose: PosV1FeedPurpose } | null;
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
    const feed = pull.posV1DayFeedId ? await posV1Repo.getFeedById(tx, orgId, pull.posV1DayFeedId) : undefined;

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

    const recordIds = [...new Set(lines.map((l) => l.usageRecordId).filter((v): v is string => !!v))];
    const statusRows = recordIds.length
      ? await tx.select({ id: schema.stockUsageRecords.id, status: schema.stockUsageRecords.status }).from(schema.stockUsageRecords).where(inArray(schema.stockUsageRecords.id, recordIds))
      : [];
    const statusById = new Map(statusRows.map((r) => [r.id, r.status as string]));

    const toView = (l: (typeof lines)[number]): PullLineView => ({
      lineKey: l.lineKey,
      posItemKey: l.posItemKey,
      posItemName: l.posItemName,
      itemName: l.itemId ? (itemNameById.get(l.itemId) ?? l.itemId) : null,
      locationName: l.locationId ? (locationNameById.get(l.locationId) ?? l.locationId) : null,
      quantity: l.quantity,
      usageRecordId: l.usageRecordId,
      recordStatus: l.usageRecordId ? (statusById.get(l.usageRecordId) ?? null) : null,
      blocked: l.blocked,
    });

    return {
      id: pull.id,
      status: pull.status,
      salesDayId: pull.salesDayId,
      snapshotTakenAt: pull.snapshotTakenAt,
      soldItemsFeed: feed ? { fetchedAt: feed.fetchedAt, purpose: feed.purpose } : null,
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
  return withOrgPrincipal(orgId, async (tx) => (await posMappingRepo.findLivePullForDay(tx, storeId, salesDayId)) ?? null);
}
