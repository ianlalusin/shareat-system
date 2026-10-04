/**
 * Disposal — taking an asset off the books. docs/tasks/124-fixed-assets-and-depreciation.md §5.
 *
 * ## The entry
 *
 * ```
 *   DR 1590  accumulated depreciation   — what has been consumed, cleared
 *   DR 7400  loss on disposal           — the remaining book value, written off
 *   CR 1510  property and equipment     — the cost, removed
 * ```
 *
 * ⚠️ **7400, not a 6xxx account.** The spec's §5 table said *"loss on disposal (6xxx)"* and that
 * was a spec defect, corrected 2026-08-26: there is no 6xxx disposal account. The seeded account
 * is `7400 Loss on disposal of assets`, under header 7000, and `docs/POSTING-PATTERNS.md` agrees.
 * The chart outranks a task spec.
 *
 * ## ⭐ The loss is DERIVED, not read off the asset
 *
 * v1 stores `disposalLoss` on the asset row. There is no such column here — the loss is
 * `cost − accumulatedFromLedger`, computed at the moment of disposal from the journal itself. The
 * same reasoning as accumulated depreciation (DEF-044): a stored loss can disagree with the entry
 * that recorded it, and then there are two answers to *"what did we write off?"*
 *
 * This also means the three legs **cannot** fail to balance: `accumulated + bookValue` is `cost`
 * by construction, because `bookValue` is defined as the difference.
 *
 * ## What this deliberately does NOT do
 *
 * **Sale with proceeds.** v1 has a `'sold'` asset status wired through its UI with *no
 * implementing code at all* — no proceeds field, no gain-on-disposal account, and its one
 * status-setting action updates the row with no journal entry whatsoever. So disposal here is a
 * write-off at zero proceeds, exactly like v1's only working path, and `'sold'` is not carried
 * over as a status that does nothing. A real sale needs a proceeds figure and a gain account, and
 * that is a spec, not an inference.
 */
import { authorize, type Actor } from '@shareat/auth';
import { fixedAssetsRepo, transaction, type Tx } from '@shareat/db';
import { compare, money, subtract } from '@shareat/core/money';
import { postEntry } from '../ledger/post-entry';

const ASSET_COST_CODE = '1510';
const ACCUMULATED_DEPRECIATION_CODE = '1590';
const LOSS_ON_DISPOSAL_CODE = '7400';

export interface DisposeAssetInput {
  assetId: string;
  /** `YYYY-MM-DD`. The entry dates on this, not on today. */
  disposedOn: string;
  reason: string;
}

export interface DisposeAssetResult {
  journalEntryId: string;
  created: boolean;
  /** The written-off remaining book value — derived, and returned so a caller can show it
   *  without recomputing it a second, possibly different, way. */
  loss: string;
  accumulated: string;
}

export async function disposeAsset(
  tx: Tx | null,
  actor: Actor,
  input: DisposeAssetInput,
): Promise<DisposeAssetResult> {
  if (tx) return runDispose(tx, actor, input);
  return transaction((trx) => runDispose(trx, actor, input));
}

async function runDispose(
  tx: Tx,
  actor: Actor,
  input: DisposeAssetInput,
): Promise<DisposeAssetResult> {
  const asset = await fixedAssetsRepo.getById(tx, actor.orgId, input.assetId);
  if (!asset) {
    throw new Error(`disposeAsset: asset ${input.assetId} does not exist in org ${actor.orgId}`);
  }

  await authorize(tx, actor, 'manage_fixed_assets', {});

  const reason = input.reason.trim();
  if (!reason) {
    // v1 makes the reason mandatory in its dialog. Kept, and moved server-side: a write-off with
    // no stated reason is the one a reviewer most needs an explanation for.
    throw new Error('disposeAsset: a reason is required — a write-off with no reason is unauditable.');
  }

  if (asset.status !== 'active') {
    throw new Error(
      `disposeAsset: asset ${input.assetId} is ${asset.status}, and only an active asset can be disposed.`,
    );
  }
  if (!asset.cost || !asset.acquiredOn) {
    throw new Error(
      `disposeAsset: asset ${input.assetId} has no cost or acquisition date — it cannot be written off before it has been valued.`,
    );
  }
  if (input.disposedOn < asset.acquiredOn) {
    throw new Error(
      `disposeAsset: disposal date ${input.disposedOn} is before the asset was acquired (${asset.acquiredOn}).`,
    );
  }

  const cost = money(asset.cost);
  const accumulated = money(await fixedAssetsRepo.accumulatedFromLedger(tx, actor.orgId, asset.id));

  // ⚠️ Clamped rather than trusted. Accumulated should never exceed cost — the schedule stops at
  // salvage — but a manual journal entry against 1590 could push it past, and a negative book
  // value would post a CREDIT on the loss line, silently turning a write-off into income.
  const cappedAccumulated = compare(accumulated, cost) > 0 ? cost : accumulated;
  const bookValue = subtract(cost, cappedAccumulated);

  const lines = [];
  if (compare(cappedAccumulated, money('0')) > 0) {
    lines.push({
      accountCode: ACCUMULATED_DEPRECIATION_CODE,
      storeId: asset.storeId,
      debit: cappedAccumulated,
      credit: '0',
      lineMemo: `Accumulated depreciation cleared — ${asset.name}`,
    });
  }
  if (compare(bookValue, money('0')) > 0) {
    lines.push({
      accountCode: LOSS_ON_DISPOSAL_CODE,
      storeId: asset.storeId,
      debit: bookValue,
      credit: '0',
      lineMemo: `Remaining book value written off — ${asset.name}`,
    });
  }
  lines.push({
    accountCode: ASSET_COST_CODE,
    storeId: asset.storeId,
    debit: '0',
    credit: cost,
    lineMemo: `Cost removed — ${asset.name}`,
  });

  const result = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: input.disposedOn,
    sourceType: 'asset_disposal',
    sourceId: asset.id,
    idempotencyKey: `asset:${asset.id}:disposal`,
    memo: `Disposal — ${asset.name}: ${reason}`,
    postedBy: actor.personId,
    lines,
  });

  if (result.created) {
    // Only on `created`. A losing concurrent caller must not re-stamp the disposal fields, and
    // `markDisposed`'s WHERE clause requires `status = 'active'` anyway — it would throw.
    await fixedAssetsRepo.markDisposed(tx, actor.orgId, asset.id, {
      disposedOn: input.disposedOn,
      disposalReason: reason,
      disposedBy: actor.personId,
    });
  }

  return {
    journalEntryId: result.entryId,
    created: result.created,
    loss: String(bookValue),
    accumulated: String(cappedAccumulated),
  };
}
