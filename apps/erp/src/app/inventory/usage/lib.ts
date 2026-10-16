/**
 * Server-only reads for the usage/wastage screen — T-168 / DEF-135.
 *
 * ⭐ Until this file existed, `saveUsageDraft`/`postUsage`/`voidUsage` (this same task, built
 * alongside it) had zero UI callers — the gap DEF-135 named for T-160/T-166/T-168/T-169 together.
 * These helpers only read; every rule they surface lives in `packages/domain` and is enforced
 * there.
 */
import { itemsRepo, posMappingRepo, stockLedgerRepo, stockUsageRepo } from '@shareat/db';
import { listCookUsageForDay, listStoreUsageQueue, listUsageVariances, type CookUsageLine, type UsageVariance } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface UsageItemOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly baseUnit: string;
}

export interface UsageFormData {
  readonly locations: { id: string; code: string; name: string }[];
  readonly departments: { id: string; code: string; name: string }[];
  readonly items: UsageItemOption[];
  readonly records: Awaited<ReturnType<typeof stockUsageRepo.listUsageRecords>>;
}

/** Everything the register + "New record" form needs, in one org-scoped transaction. */
export async function usageScreenData(orgId: string, storeId: string): Promise<UsageFormData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [locations, departments, itemRows, records] = await Promise.all([
      stockUsageRepo.listOperatingLocations(tx, storeId),
      stockUsageRepo.listDepartments(tx, orgId),
      itemsRepo.listUsableItems(tx, orgId, storeId),
      stockUsageRepo.listUsageRecords(tx, storeId),
    ]);
    return {
      locations,
      departments,
      // T-383 S2b: a retired item with stock at this store stays usable until it runs out, labelled as such.
      items: itemRows.map((i) => ({ id: i.id, code: i.code, name: i.status === 'inactive' ? `${i.name} (retired)` : i.name, baseUnit: i.baseUnit })),
      records,
    };
  });
}

export interface UsageLineView {
  readonly id: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly baseUnit: string;
  readonly quantity: string;
  readonly movementId: string | null;
  /** ⭐ Current on-hand in the record's own room — so the person sees what they are about to
   *  consume (or, once posted, what is left) beside each line, per this task's spec. */
  readonly onHand: string;
}

export interface UsageRecordDetail {
  readonly record: NonNullable<Awaited<ReturnType<typeof stockUsageRepo.getUsageRecord>>>;
  readonly locationName: string;
  readonly lines: UsageLineView[];
  /** T-374 S7 (R10): a live POS pull made this record, so it is voided with the pull, not here. */
  readonly fromLivePull: boolean;
}

export async function usageRecordDetail(orgId: string, id: string): Promise<UsageRecordDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const record = await stockUsageRepo.getUsageRecord(tx, id);
    if (!record) return null;
    const [lines, roomName] = await Promise.all([
      stockUsageRepo.listUsageLines(tx, id),
      stockUsageRepo.locationName(tx, record.locationId),
    ]);

    const lineViews: UsageLineView[] = [];
    for (const l of lines) {
      const onHand = await stockLedgerRepo.onHand(tx, l.itemId, record.locationId);
      lineViews.push({
        id: l.id,
        itemId: l.itemId,
        itemCode: l.itemCode,
        itemName: l.itemName,
        baseUnit: l.baseUnit,
        quantity: l.quantity,
        movementId: l.movementId,
        onHand,
      });
    }

    const fromLivePull = !!(await posMappingRepo.livePullForUsageRecord(tx, id));
    return { record, locationName: roomName, lines: lineViews, fromLivePull };
  });
}

export interface UsageQueueView {
  /** The business date the band table is for. */
  readonly date: string;
  /** Every covered item of that day: expected (from the POS plan), recorded so far, and the verdict. */
  readonly variances: UsageVariance[];
  /** Every usage draft of the store, from every author, oldest first. */
  readonly drafts: Awaited<ReturnType<typeof listStoreUsageQueue>>;
  /** T-419: ingredients recipe cooking used that day (display only; drafts included, marked). */
  readonly cooked: CookUsageLine[];
}

/**
 * T-401 S6: the store's draft queue and the tolerance band per covered item for one day. Both reads are the domain's own, so the
 * screen and the post gate cannot disagree about "inside" and "outside".
 */
export async function usageQueueData(orgId: string, actor: Actor, storeId: string, date: string): Promise<UsageQueueView> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [variances, drafts, cooked] = await Promise.all([
      listUsageVariances(tx, actor, { storeId, date }),
      listStoreUsageQueue(tx, actor, storeId),
      listCookUsageForDay(tx, actor, { storeId, date }),
    ]);
    return { date, variances, drafts, cooked };
  });
}
