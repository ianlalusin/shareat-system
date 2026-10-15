/**
 * T-401 S6 round 2: the body of "post a usage record", shared by `postUsage` (a manager, with `authorize`) and
 * `autoPostDueUsageDrafts` (the system, 14:00 Manila the next day). It is deliberately NOT re-exported from the domain barrel: it has no
 * `authorize`, so it must not be reachable from an app (the same posture as `void-pull-usage-record.ts`).
 */
import { stockUsageRepo, type Tx } from '@shareat/db';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from './receipt-posting';
import { quantity } from './quantity';
import { postUsageRecord, type PostUsageInput, type UsageLineInput } from './usage';
import { cogsCategoryForItemKind, type PostOutcome } from './usage-records';
import type { WastageReason } from './wastage-reasons';

/**
 * Posts an already-loaded draft: builds the engine input from its lines, posts, links each line to its movement and marks the record
 * posted by `postedBy` (with `autoPosted` when the system did it). Returns the engine's refusal as `{ ok: false, reason }` before any
 * write it made; a `true` result has written the movements, the entries and the record's new status.
 */
export async function postLoadedUsageRecord(
  tx: Tx,
  record: NonNullable<Awaited<ReturnType<typeof stockUsageRepo.getUsageRecord>>>,
  lines: Awaited<ReturnType<typeof stockUsageRepo.listUsageLines>>,
  postedBy: string,
  autoPosted: boolean,
): Promise<PostOutcome> {
  if (record.kind !== 'usage' && record.kind !== 'wastage') {
    return { ok: false, reason: `posting a "${record.kind}" record is not built yet` };
  }
  const usageLines: UsageLineInput[] = [];
  for (const line of lines) {
    const inventoryAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind];
    if (!inventoryAccount) {
      return { ok: false, reason: `item kind "${line.itemKind}" has no inventory account in COA-ALIGNMENT §4.1` };
    }
    usageLines.push({
      lineId: line.id,
      itemId: line.itemId,
      cogsCategory: cogsCategoryForItemKind(line.itemKind),
      inventoryAccount,
      quantity: quantity(line.quantity),
    });
  }

  const postInput: PostUsageInput = {
    orgId: record.orgId,
    storeId: record.storeId,
    locationId: record.locationId,
    recordId: record.id,
    kind: record.kind,
    usedOn: record.usedOn,
    postedBy,
    reason: record.kind === 'wastage' && record.reasonCode ? (record.reasonCode as WastageReason) : undefined,
    lines: usageLines,
  };

  const result = await postUsageRecord(tx, postInput);
  if (!result.ok) return result;

  // ⭐ `movementIds` is in line order — `usage.ts`'s own contract — asserted, not assumed: a
  // mismatch here would silently attach the wrong movement to the wrong line.
  if (result.movementIds.length !== lines.length) {
    throw new Error(`postUsage: postUsageRecord returned ${result.movementIds.length} movement(s) for ${lines.length} line(s)`);
  }
  for (let i = 0; i < lines.length; i++) {
    await stockUsageRepo.setUsageLineMovement(tx, lines[i]!.id, result.movementIds[i]!);
  }
  await stockUsageRepo.markUsagePosted(tx, record.id, postedBy, autoPosted);

  return {
    ok: true,
    totalCost: result.totalCost,
    entryIds: result.entryIds,
    storeId: record.storeId,
    itemIds: lines.map((l) => l.itemId),
  };
}
