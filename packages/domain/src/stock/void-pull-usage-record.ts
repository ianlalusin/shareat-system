/**
 * T-374 S7 (DEF-578): the actor-less core of a usage-record void. ONLY `pos/usage-pull.ts` (voidPosUsagePull) and
 * `stock/usage-records.ts` (voidUsage) import this module (pinned by tests/unit/t374-s7-void-core-import-census.test.ts).
 * It is deliberately NOT re-exported from `@shareat/domain`'s barrel: it has no `authorize`, so it must not be
 * reachable from an app.
 */
import { stockUsageRepo, type Tx } from '@shareat/db';
import type { BusinessDate } from '@shareat/core/datetime';
import { voidUsageRecord, type VoidUsageInput } from './usage';
import { quantity } from './quantity';
import type { VoidUsageOutcome } from './usage-records';

/**
 * T-374 S7 (R8, review): the body of a usage-record void, after the gate. EXPORTED and ACTOR-LESS on purpose.
 * `voidUsage` (the screen's function) authorizes, applies R10 (a pull-made record is not voided alone), then
 * calls this with today's date. `voidPosUsagePull` authorizes once on the pull's store and calls this per
 * record with the pull's chosen date. There is no flag on `voidUsage` that skips R10: the only way past it is
 * this function, which takes no actor and so cannot be wired to a form by accident.
 */
export async function voidPullUsageRecord(
  tx: Tx,
  input: { readonly recordId: string; readonly reason: string; readonly voidedOn: BusinessDate; readonly voidedBy: string },
): Promise<VoidUsageOutcome> {
  const record = await stockUsageRepo.getUsageRecord(tx, input.recordId);
  if (!record) return { ok: false, reason: `usage record ${input.recordId} does not exist` };

  if (record.status !== 'posted') {
    return { ok: false, reason: `usage record ${input.recordId} is ${record.status}, not posted` };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'a void needs a reason' };
  if (record.kind !== 'usage' && record.kind !== 'wastage') {
    return { ok: false, reason: `voiding a "${record.kind}" record is not built yet` };
  }

  const lines = await stockUsageRepo.listUsageLines(tx, input.recordId);
  const missing = lines.find((l) => !l.movementId);
  if (missing) {
    // ⛔ A posted record with an un-linked line means `postUsage`'s own assertion above was
    // bypassed by some other writer — data is inconsistent, not merely refused.
    throw new Error(`voidUsage: posted line ${missing.id} carries no movement id — data is inconsistent`);
  }

  const voidInput: VoidUsageInput = {
    orgId: record.orgId,
    storeId: record.storeId,
    locationId: record.locationId,
    recordId: record.id,
    kind: record.kind,
    voidedOn: input.voidedOn,
    voidedBy: input.voidedBy,
    lines: lines.map((l) => ({ itemId: l.itemId, movementId: l.movementId!, quantity: quantity(l.quantity) })),
    reason,
  };

  const result = await voidUsageRecord(tx, voidInput);
  if (!result.ok) return result;

  await stockUsageRepo.markUsageVoid(tx, record.id, input.voidedBy, reason);
  return { ok: true, reversalEntryIds: result.reversalEntryIds };
}
