/**
 * T-401 S6 round 2 (Ian, 15 Oct): what the usage check leaves behind for the people who close the month and for the owners.
 *
 *  - `usageCloseRefusal` - the month close (`fiscal-periods/index.ts` `closePeriod`) refuses while, in that org and month, any usage
 *    record is still a DRAFT, or was POSTED by a person with an out-of-band line and no reason. An auto-posted record never blocks:
 *    its out-of-band lines went in at the expected quantity, and that is explained by the auto-post itself.
 *  - `usageCheckScorecard` - per store over a range of business dates: how many pull drafts there were, how many a manager posted,
 *    how many the system had to auto-post, and the auto-posted share. Capability `view_financial_reports`; a store-scoped manager
 *    sees only the stores they hold it at.
 *  - `unpostedUsageDraftCount` - the day-close warning: a store's usage drafts dated one business date.
 */
import { authorize, canAt, type Actor } from '@shareat/auth';
import { stockUsageRepo, type Tx } from '@shareat/db';
import { snapshotVariancesFor, usageVariancesFor } from './usage-tolerance';

/**
 * The sentence the month close refuses with, or `null` when no usage record stands in the way. `startsOn`/`endsOn` are the month's
 * first and last business dates.
 */
export async function usageCloseRefusal(tx: Tx, orgId: string, startsOn: string, endsOn: string): Promise<string | null> {
  const records = await stockUsageRepo.listMonthUsageRecordsForClose(tx, orgId, startsOn, endsOn);
  if (records.length === 0) return null;

  const drafts = records.filter((r) => r.status === 'draft');
  const posted = records.filter((r) => r.status === 'posted' && r.kind === 'usage');

  // Posted by a person, out of band, and no reason on file for that item. A4: an item the POS pull covered in THIS record is judged
  // against the record's own snapshot (never a live recomputation, never other records' quantities, so another room's explained post
  // cannot turn it out of band); any other item is judged by the day's total against the plan, as the post gate judges it. The stored
  // reason is the audit row `stock.usage_tolerance_verified`.
  let unexplained = 0;
  if (posted.length > 0) {
    const verified = await stockUsageRepo.verifiedToleranceKeys(tx, orgId, posted.map((r) => r.id));
    const cache = new Map<string, Awaited<ReturnType<typeof usageVariancesFor>>>();
    for (const r of posted) {
      const lines = await stockUsageRepo.listUsageLines(tx, r.id);
      const own = await snapshotVariancesFor(tx, orgId, r.id, lines);
      const ownIds = new Set(own.map((v) => v.itemId));
      const key = `${r.storeId}|${r.usedOn}`;
      let day = cache.get(key);
      if (!day) {
        day = await usageVariancesFor(tx, orgId, r.storeId, r.usedOn);
        cache.set(key, day);
      }
      const outside = new Set([...own, ...day.filter((v) => !ownIds.has(v.itemId))].filter((v) => !v.withinBand).map((v) => v.itemId));
      const touched = new Set([...r.itemIds, ...ownIds]);
      if ([...touched].some((itemId) => outside.has(itemId) && !verified.has(`${r.id}|${itemId}`))) unexplained += 1;
    }
  }

  if (drafts.length === 0 && unexplained === 0) return null;
  const parts: string[] = [];
  if (drafts.length > 0) parts.push(`${drafts.length} usage ${drafts.length === 1 ? 'record is' : 'records are'} still a draft`);
  if (unexplained > 0) {
    parts.push(`${unexplained} posted usage ${unexplained === 1 ? 'record has' : 'records have'} a line outside the tolerance with no reason given`);
  }
  return `${parts.join(' and ')} in this month. Post or void the drafts, and give a reason for the out-of-band lines, before the month can close.`;
}

export interface UsageCheckScorecardRow {
  readonly storeId: string;
  readonly storeName: string;
  readonly pullDrafts: number;
  readonly postedByManager: number;
  readonly autoPosted: number;
  /** autoPosted / pullDrafts x 100; 0 when the store had no pull drafts. */
  readonly autoPostedPct: number;
}

/** Per store (those the actor holds `view_financial_reports` at), over `used_on` in `[from, to]`. */
export async function usageCheckScorecard(
  tx: Tx,
  actor: Actor,
  range: { readonly from: string; readonly to: string },
): Promise<UsageCheckScorecardRow[]> {
  const everyStore = await stockUsageRepo.activeStoreIds(tx, actor.orgId);
  const visible: string[] = [];
  for (const storeId of everyStore) {
    if (await canAt(tx, actor.personId, 'view_financial_reports', storeId)) visible.push(storeId);
  }
  // Nobody sees any store: the same refusal as any other report gate (also the answer for a role without the capability).
  if (visible.length === 0) await authorize(tx, actor, 'view_financial_reports', {});

  const rows = await stockUsageRepo.usageCheckScorecardRows(tx, actor.orgId, range.from, range.to, visible);
  return rows.map((r) => ({
    storeId: r.storeId,
    storeName: r.storeName,
    pullDrafts: r.pullDrafts,
    postedByManager: r.postedByManager,
    autoPosted: r.autoPosted,
    autoPostedPct: r.pullDrafts === 0 ? 0 : (r.autoPosted * 100) / r.pullDrafts,
  }));
}

/**
 * How many usage drafts the store has dated `businessDate`, for the manager. Anyone who may record usage at the store may ask.
 */
export async function unpostedUsageDraftCount(tx: Tx, actor: Actor, input: { readonly storeId: string; readonly businessDate: string }): Promise<number> {
  await authorize(tx, actor, 'record_stock_movement', { storeId: input.storeId });
  return stockUsageRepo.countUsageDraftsOn(tx, input.storeId, input.businessDate);
}
