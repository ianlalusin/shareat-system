/**
 * T-401 S6 round 2 (Ian, 15 Oct): the next-afternoon AUTO-POST of the usage drafts the POS pull made.
 *
 * Finalizing the v1 POS pull writes a usage DRAFT at the expected quantities (`pos/usage-pull.ts`). Staff may edit it to actuals and a
 * manager posts it. If nobody has posted it by 14:00 Manila the day AFTER its business date, `autoPostDueUsageDrafts` posts it:
 *
 *  - lines inside the tolerance band post as they stand;
 *  - a line whose item is OUTSIDE the band (no reason is possible: nobody is there to give one) is rewritten to the EXPECTED quantity,
 *    less whatever other records of that day already hold for the item, and posts at that;
 *  - the record is marked `auto_posted`, posted by the org's system person, and `stock.usage_auto_posted` is audited (system actor);
 *  - a post the system cannot make (a room under count, a closed stock month, a short item) is NOT forced: the draft stays a draft and
 *    the run reports it in `skipped` with the reason in words. The next run tries again.
 *
 * Only PULL-MADE drafts are considered (a line of a live pull points at the record). A manual draft for an item the POS does not sell
 * waits for a manager however old it is. Idempotent: a posted record is no longer a draft.
 *
 * Each record is posted inside its own savepoint, so a refusal leaves no half-rewritten lines and never stops the next record.
 */
import { auditLogRepo, countSessionsRepo, stockLocationsRepo, stockUsageRepo, type Tx } from '@shareat/db';
import { RefusalError } from '../shared/refusal';
import { isFrozenBySessions } from './count-workflow';
import { assertUsageSource } from '../stock-locations/rules';
import { postLoadedUsageRecord } from './usage-post-core';
import { addQuantity, compareQuantity, quantity, subtractQuantity, ZERO_QUANTITY } from './quantity';
import { usageVariancesFor } from './usage-tolerance';

export interface AutoPostedRecord {
  readonly recordId: string;
  readonly storeId: string;
  readonly usedOn: string;
}

export interface AutoPostResult {
  readonly posted: readonly AutoPostedRecord[];
  readonly skipped: readonly { readonly recordId: string; readonly reason: string }[];
}

/** A refusal that is already words for the report. */
class AutoPostRefused extends Error {}

function wordsOf(err: unknown): string {
  if (err instanceof AutoPostRefused) return err.message;
  if (err instanceof RefusalError) return err.userMessage;
  const text = err instanceof Error ? err.message : String(err);
  const first = text.split('\n')[0] ?? text;
  return `The system could not post this draft (${first.slice(0, 200)}). A manager can post it by hand.`;
}

export async function autoPostDueUsageDrafts(tx: Tx, now: Date): Promise<AutoPostResult> {
  const due = await stockUsageRepo.listDuePullUsageDrafts(tx, now);
  const posted: AutoPostedRecord[] = [];
  const skipped: { recordId: string; reason: string }[] = [];
  for (const row of due) {
    try {
      const outcome = await tx.transaction(async (inner) => autoPostOne(inner as Tx, row));
      if (outcome === 'posted') posted.push({ recordId: row.id, storeId: row.storeId, usedOn: row.usedOn });
    } catch (err) {
      skipped.push({ recordId: row.id, reason: wordsOf(err) });
    }
  }
  return { posted, skipped };
}

async function autoPostOne(tx: Tx, row: stockUsageRepo.DueUsageDraftRow): Promise<'posted' | 'gone'> {
  // Locked first: a manager posting the same draft right now wins, and this run finds it no longer a draft.
  if ((await stockUsageRepo.lockUsageStatus(tx, row.id)) !== 'draft') return 'gone';
  const record = await stockUsageRepo.getUsageRecord(tx, row.id);
  if (!record || record.status !== 'draft' || record.kind !== 'usage') return 'gone';

  const roomName = await stockUsageRepo.locationName(tx, record.locationId);
  const room = await stockLocationsRepo.getLocation(tx, record.locationId);
  if (!room || !assertUsageSource(room).ok) {
    throw new AutoPostRefused(`${roomName} can't take usage (it is not an operating room, or it is inactive).`);
  }
  const sessions = await countSessionsRepo.freezingSessionsFor(tx, [record.locationId]);
  if (isFrozenBySessions(sessions, record.locationId)) {
    throw new AutoPostRefused(`${roomName} is being counted, so nothing can be posted from it until the count ends.`);
  }

  let lines = await stockUsageRepo.listUsageLines(tx, record.id);
  if (lines.length === 0) throw new AutoPostRefused('The draft has no lines, so there is nothing to post.');

  // Out-of-band items go back to expected (less what the day's other records already hold for the item).
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const variances = await usageVariancesFor(tx, record.orgId, record.storeId, record.usedOn, itemIds);
  const adjusted: { itemId: string; recorded: string; posted: string }[] = [];
  for (const v of variances) {
    if (v.withinBand) continue;
    const mine = lines.filter((l) => l.itemId === v.itemId);
    const myTotal = addQuantity(...mine.map((l) => quantity(l.quantity)));
    const others = subtractQuantity(quantity(v.actual), myTotal);
    const wanted = subtractQuantity(quantity(v.expected), others);
    const target = compareQuantity(wanted, ZERO_QUANTITY) > 0 ? wanted : ZERO_QUANTITY;
    adjusted.push({ itemId: v.itemId, recorded: myTotal, posted: target });
    if (compareQuantity(target, ZERO_QUANTITY) === 0) {
      await stockUsageRepo.deleteUsageLines(tx, mine.map((l) => l.id));
    } else {
      await stockUsageRepo.updateUsageLineQuantity(tx, mine[0]!.id, target);
      await stockUsageRepo.deleteUsageLines(tx, mine.slice(1).map((l) => l.id));
    }
  }
  if (adjusted.length > 0) lines = await stockUsageRepo.listUsageLines(tx, record.id);
  if (lines.length === 0) {
    throw new AutoPostRefused('Every line was outside the tolerance against an expected of nothing, so there is nothing left to post. A manager should review it.');
  }

  const author = await stockUsageRepo.systemAuthorId(tx, record.orgId);
  const result = await postLoadedUsageRecord(tx, record, lines, author, true);
  if (!result.ok) throw new AutoPostRefused(result.reason);

  await auditLogRepo.appendSystem(tx, record.orgId, {
    action: 'stock.usage_auto_posted',
    storeId: record.storeId,
    entityId: record.id,
    before: null,
    after: { businessDate: record.usedOn, lineCount: lines.length, adjusted },
    source: 'cron',
  });
  return 'posted';
}
