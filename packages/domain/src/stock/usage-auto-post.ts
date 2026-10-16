/**
 * T-401 S6 round 2 (Ian, 15 Oct): the next-afternoon AUTO-POST of the usage drafts the POS pull made.
 *
 * Finalizing the v1 POS pull writes a usage DRAFT at the expected quantities (`pos/usage-pull.ts`). Staff may edit it to actuals and a
 * manager posts it. If nobody has posted it by 14:00 Manila the day AFTER its business date, `autoPostDueUsageDrafts` posts it:
 *
 *  - lines inside the tolerance band post as they stand (each judged against ITS OWN snapshot of what the pull expected, A4);
 *  - an item OUTSIDE the band (no reason is possible: nobody is there to give one) goes back to its snapshot expected quantity, which
 *    already has what other records held taken off (A5). That includes a covered item whose line staff DELETED (an actual of 0, A3):
 *    the line is added back at expected. A draft left with nothing to post (every item expects nothing) is deleted, not skipped forever;
 *  - the record is marked `auto_posted`, posted by the org's system person, and `stock.usage_auto_posted` is audited (system actor);
 *  - a post the system cannot make (a room under count, a closed stock month, a short item) is NOT forced: the draft stays a draft and
 *    the run reports it in `skipped` with the reason in words. The next run tries again.
 *
 * Only SYSTEM-MADE pull drafts are considered (a line of a live pull points at the record; a staff draft is never touched by the pull, A2,
 * and one whose pull was voided is unlinked, A7). A manual draft waits for a manager however old it is. A draft is due at the later of
 * 14:00 Manila the day after its business date and four hours after it was made (A10). Idempotent: a posted record is no longer a draft.
 *
 * Each record is posted inside its own savepoint, so a refusal leaves no half-rewritten lines and never stops the next record.
 */
import { auditLogRepo, countSessionsRepo, posMappingRepo, stockLocationsRepo, stockUsageRepo, type AuditLogSource, type Tx } from '@shareat/db';
import { RefusalError } from '../shared/refusal';
import { isFrozenBySessions } from './count-workflow';
import { assertUsageSource } from '../stock-locations/rules';
import { postLoadedUsageRecord } from './usage-post-core';
import { addQuantity, compareQuantity, quantity, subtractQuantity, ZERO_QUANTITY } from './quantity';
import { snapshotVariancesFor, usageVariancesFor } from './usage-tolerance';

export interface AutoPostedRecord {
  readonly recordId: string;
  readonly storeId: string;
  readonly usedOn: string;
}

export interface AutoPostResult {
  readonly posted: readonly AutoPostedRecord[];
  /** `subjectName` is words for a report line (the room and the business date), never an id. */
  readonly skipped: readonly { readonly recordId: string; readonly subjectName: string; readonly reason: string }[];
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

export async function autoPostDueUsageDrafts(tx: Tx, now: Date, source: AuditLogSource = 'cron'): Promise<AutoPostResult> {
  const due = await stockUsageRepo.listDuePullUsageDrafts(tx, now);
  const posted: AutoPostedRecord[] = [];
  const skipped: { recordId: string; subjectName: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const row of due) {
    // A12: a draft is reported at most once per sweep, whatever refused it.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    try {
      const outcome = await tx.transaction(async (inner) => autoPostOne(inner as Tx, row, source));
      if (outcome === 'posted') posted.push({ recordId: row.id, storeId: row.storeId, usedOn: row.usedOn });
    } catch (err) {
      const room = await stockUsageRepo.locationName(tx, row.locationId).catch(() => 'a room');
      skipped.push({ recordId: row.id, subjectName: `${room} usage draft of ${row.usedOn}`, reason: wordsOf(err) });
    }
  }
  return { posted, skipped };
}

async function autoPostOne(tx: Tx, row: stockUsageRepo.DueUsageDraftRow, source: AuditLogSource): Promise<'posted' | 'gone' | 'emptied'> {
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
  const adjusted: { itemId: string; recorded: string; posted: string }[] = [];

  // 1. Items the pull covered in this record, each against its own snapshot (A3/A4). Outside the band: back to expected, which for an
  //    item with no line (staff deleted it) means the line comes back.
  for (const v of await snapshotVariancesFor(tx, record.orgId, record, lines)) {
    if (v.withinBand) continue;
    const mine = lines.filter((l) => l.itemId === v.itemId);
    // T-420 C5: back to the snapshot LESS what posted cooking in this room already took out; never below 0.
    const afterCook = subtractQuantity(quantity(v.expected), quantity(v.cooked));
    const target = compareQuantity(afterCook, ZERO_QUANTITY) > 0 ? afterCook : ZERO_QUANTITY;
    adjusted.push({ itemId: v.itemId, recorded: v.actual, posted: target });
    if (compareQuantity(target, ZERO_QUANTITY) === 0) {
      await stockUsageRepo.deleteUsageLines(tx, mine.map((l) => l.id));
    } else if (mine.length === 0) {
      const nextNo = lines.reduce((m, l) => Math.max(m, Number(l.lineNo) || 0), lines.length) + 1;
      await stockUsageRepo.insertUsageLines(tx, record.id, [{ lineNo: String(nextNo), itemId: v.itemId, quantity: target, expectedQty: target }]);
    } else {
      await stockUsageRepo.updateUsageLineQuantity(tx, mine[0]!.id, target, target);
      await stockUsageRepo.deleteUsageLines(tx, mine.slice(1).map((l) => l.id));
    }
    lines = await stockUsageRepo.listUsageLines(tx, record.id);
  }

  // 2. Any other covered item of the draft (a line staff typed in for something the pull did not cover for this record): the day's
  //    total against the plan, as before; outside goes to expected less what the day's other records already hold.
  const snapshotIds = new Set((await posMappingRepo.draftExpectedByItem(tx, record.id)).keys());
  const otherIds = [...new Set(lines.map((l) => l.itemId))].filter((id) => !snapshotIds.has(id));
  for (const v of await usageVariancesFor(tx, record.orgId, record.storeId, record.usedOn, otherIds)) {
    if (v.withinBand) continue;
    const mine = lines.filter((l) => l.itemId === v.itemId);
    const myTotal = addQuantity(...mine.map((l) => quantity(l.quantity)));
    const others = subtractQuantity(quantity(v.actual), myTotal);
    const wanted = subtractQuantity(subtractQuantity(quantity(v.expected), others), quantity(v.cooked)); // T-420 C5: and the store's cooking
    const target = compareQuantity(wanted, ZERO_QUANTITY) > 0 ? wanted : ZERO_QUANTITY;
    adjusted.push({ itemId: v.itemId, recorded: myTotal, posted: target });
    if (compareQuantity(target, ZERO_QUANTITY) === 0) {
      await stockUsageRepo.deleteUsageLines(tx, mine.map((l) => l.id));
    } else {
      await stockUsageRepo.updateUsageLineQuantity(tx, mine[0]!.id, target);
      await stockUsageRepo.deleteUsageLines(tx, mine.slice(1).map((l) => l.id));
    }
  }
  if (otherIds.length > 0) lines = await stockUsageRepo.listUsageLines(tx, record.id);

  // Nothing left to post: every covered item expects nothing (other records already hold the day's usage). The draft is cleaned up, not
  // reported as skipped on every run for ever.
  if (lines.length === 0) {
    await posMappingRepo.unlinkRecordFromPulls(tx, record.id);
    await stockUsageRepo.deleteUsageDraft(tx, record.id);
    return 'emptied';
  }

  const author = await stockUsageRepo.systemAuthorId(tx, record.orgId, source);
  const result = await postLoadedUsageRecord(tx, record, lines, author, true);
  if (!result.ok) throw new AutoPostRefused(result.reason);

  await auditLogRepo.appendSystem(tx, record.orgId, {
    action: 'stock.usage_auto_posted',
    storeId: record.storeId,
    entityId: record.id,
    before: null,
    after: { businessDate: record.usedOn, lineCount: lines.length, adjusted },
    source,
  });
  return 'posted';
}
