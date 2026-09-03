/**
 * Posting and voiding a usage record — T-168.
 *
 * ⭐ **Posting is the only step that moves anything.** A draft is a claim; posting makes it real.
 * That separation is what lets a floor worker record what they used and a manager check it before
 * stock and the P&L both move.
 *
 * ## What one post does
 *
 * ```
 * per line:  consume()          layers relieved, OUT movement written   (T-162 + T-161)
 * once:      postConsumption()  Dr 5110/5120/… · Cr inventory            (T-164)
 *            postWastage()      Dr 5300 · Cr inventory
 * ```
 *
 * ⚠️ **All of it or none.** The caller owns the transaction; a refusal after a write throws, for
 * the reason T-166 found the hard way — *a returned error and a thrown one are not
 * interchangeable inside a transaction.*
 */
import { add, ZERO, type Money } from '@shareat/core/money';
import { journalRepo, type Tx } from '@shareat/db';
import { reverseEntry } from '../ledger/reverse-entry';
import { consume, reverseConsumption } from './consume';
import { postConsumption, postWastage } from './consumption-posting';
import { isReservedUsageCategory, type WastageReason } from './wastage-reasons';
import type { ConsumedLine } from './layers';
import type { Quantity } from './quantity';

export interface UsageLineInput {
  readonly lineId: string;
  readonly itemId: string;
  /** COA-ALIGNMENT §4.1's consumption category — meat, sides, packaging… */
  readonly cogsCategory: string;
  /** The inventory account this item's stock sits in. */
  readonly inventoryAccount: string;
  /** Positive, base units. */
  readonly quantity: Quantity;
}

export interface PostUsageInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly recordId: string;
  readonly kind: 'usage' | 'wastage';
  /** YYYY-MM-DD. */
  readonly usedOn: string;
  readonly lines: readonly UsageLineInput[];
  /** Required for `wastage`, and checked against the reserved list. */
  readonly reason?: WastageReason;
  /** ⚠️ Wastage only. Phase 5 owns the advance — the post REFUSES if it is not built. */
  readonly chargePersonId?: string | null;
  readonly postedBy: string;
}

export interface PostUsageResult {
  readonly ok: true;
  readonly entryIds: readonly string[];
  readonly movementIds: readonly string[];
  readonly totalCost: Money;
}

export type PostUsageOutcome = PostUsageResult | { readonly ok: false; readonly reason: string };

/** Phase 5's salary-advance module. Absent today, and the post says so rather than dropping it. */
const SALARY_ADVANCE_AVAILABLE = false;

export async function postUsageRecord(tx: Tx, input: PostUsageInput): Promise<PostUsageOutcome> {
  if (input.lines.length === 0) {
    return { ok: false, reason: 'a usage record with no lines posts nothing' };
  }

  // ⭐ Every precondition BEFORE the first write — T-166 §7.2's lesson, applied rather than
  // rediscovered. A refusal found after a movement is written commits a half-post.
  if (input.kind === 'wastage' && !input.reason) {
    return { ok: false, reason: 'a wastage must carry a reason' };
  }
  if (input.reason && isReservedUsageCategory(input.reason)) {
    // ⛔ v1's named footgun. The usage flow writes only an OUT leg, so a movement labelled as a
    // transfer DESTROYS stock rather than moving it — it leaves one room and arrives nowhere.
    return {
      ok: false,
      reason: `"${input.reason}" is a reserved category: a usage writes only an OUT leg, so a transfer recorded here would destroy the stock instead of moving it. Use a stock transfer.`,
    };
  }
  if (input.chargePersonId) {
    if (input.kind !== 'wastage') {
      return { ok: false, reason: 'only a wastage can be charged to a person' };
    }
    if (!SALARY_ADVANCE_AVAILABLE) {
      // ⛔ Refused, never silently dropped. A charge that vanishes is worse than one that fails:
      // the stock still moved and somebody believes they are being recovered from.
      return {
        ok: false,
        reason:
          'charging wastage to a person needs the salary-advance module (Phase 5). ' +
          'Record the wastage without a charge, or wait for Phase 5.',
      };
    }
  }

  const entryIds: string[] = [];
  const movementIds: string[] = [];
  let totalCost: Money = ZERO;

  // ⚠️ Grouped by (account, category) so one entry covers each — not one entry per line, which
  // would scatter a single document across the ledger.
  const byGroup = new Map<string, { lines: ConsumedLine[]; input: UsageLineInput }>();

  for (const line of input.lines) {
    const result = await consume(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      itemId: line.itemId,
      quantity: line.quantity,
      movedAt: new Date(`${input.usedOn}T00:00:00Z`),
      kind: input.kind === 'wastage' ? 'wastage' : 'usage',
      sourceType: input.kind,
      sourceId: input.recordId,
      createdBy: input.postedBy,
    });
    if (!result.ok) {
      // ⛔ A refusal on line 2+ arrives AFTER line 1's movement and layer consumptions are written.
      // Returning it would let the caller COMMIT a half-post — item A consumed, no entry, the record
      // still `draft`, and a second press consuming A again. Found by the 2026-09-03 review; the
      // same rule this file already states for the posting step below.
      if (movementIds.length > 0) {
        throw new Error(`postUsageRecord: refused after stock was written — ${result.reason}`);
      }
      return result;
    }

    movementIds.push(result.movementId);
    totalCost = add(totalCost, result.totalCost);

    const key = `${line.inventoryAccount}:${line.cogsCategory}`;
    const group = byGroup.get(key);
    if (group) group.lines.push(...result.lines);
    else byGroup.set(key, { lines: [...result.lines], input: line });
  }

  for (const [key, group] of byGroup) {
    const common = {
      orgId: input.orgId,
      storeId: input.storeId,
      inventoryAccount: group.input.inventoryAccount,
      movedOn: input.usedOn,
      sourceType: input.kind,
      costLines: group.lines,
      postedBy: input.postedBy,
    };
    // ⚠️ The key rides the source id so two groups on one record do not collide on idempotency.
    const posted =
      input.kind === 'wastage'
        ? await postWastage(tx, { ...common, sourceId: `${input.recordId}:${key}`, reason: input.reason! })
        : await postConsumption(tx, {
            ...common,
            sourceId: `${input.recordId}:${key}`,
            cogsCategory: group.input.cogsCategory,
          });

    if (!posted.ok) {
      // ⛔ Stock is already written. Throw so the transaction unwinds — T-166 §7.2.
      throw new Error(`postUsageRecord: posting refused after stock moved — ${posted.reason}`);
    }
    entryIds.push(posted.entryId);
  }

  return { ok: true, entryIds, movementIds, totalCost };
}

export interface VoidUsageInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly recordId: string;
  readonly kind: 'usage' | 'wastage';
  readonly voidedOn: string;
  readonly lines: readonly { itemId: string; movementId: string; quantity: Quantity }[];
  readonly voidedBy: string;
  readonly hasLiveStaffCharge?: boolean;
  /** Lands on the reversal entries' memo. Defaults to naming the record, never empty. */
  readonly reason?: string | null;
}

/**
 * Void a posted usage record — stock back, layers restored, **and the entry reversed.**
 *
 * ⭐ **A linked staff charge is voided FIRST**, and the ordering is v1's for a real reason: a
 * failure must never leave a reversed stock movement standing beside an un-reversed pay deduction.
 * Somebody is still being charged for meat that is back on the shelf.
 *
 * ⚠️ DEF-141 (2026-09-03): until the screen arrived, this reversed the movements and the layers
 * and **left the `Dr 5110 / Cr 1310` entry standing** — the spec's invariant 7 says "stock, layers
 * and entry in one transaction", the engine's own test asserted only the first two, and nothing
 * called it from `apps/` to notice. A voided usage therefore silently kept its COGS. The entries
 * are found by the `(source_type, source_id prefix)` they were posted under — one per
 * (account, category) group — and each is reversed through `reverseEntry`, so the ledger's own
 * reversal discipline (idempotent by `reverse:{entryId}`, linked, original flipped to `reversed`)
 * applies rather than a hand-rolled opposite entry.
 */
export async function voidUsageRecord(
  tx: Tx,
  input: VoidUsageInput,
): Promise<{ ok: true; movementIds: string[]; reversalEntryIds: string[] } | { ok: false; reason: string }> {
  if (input.hasLiveStaffCharge && !SALARY_ADVANCE_AVAILABLE) {
    return {
      ok: false,
      reason:
        'this record carries a staff charge and the salary-advance module (Phase 5) is not built, ' +
        'so the charge cannot be voided first. Voiding stock alone would leave the deduction standing.',
    };
  }

  const movementIds: string[] = [];
  for (const line of input.lines) {
    const result = await reverseConsumption(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      itemId: line.itemId,
      originalMovementId: line.movementId,
      quantity: line.quantity,
      movedAt: new Date(`${input.voidedOn}T00:00:00Z`),
      kind: input.kind === 'wastage' ? 'wastage' : 'usage',
      sourceType: `${input.kind}_void`,
      sourceId: input.recordId,
      createdBy: input.voidedBy,
    });
    if (!result.ok) {
      // ⛔ Same rule as the post: a refusal after an earlier line's reversal was written must
      // unwind it, never be handed back for the caller to commit.
      if (movementIds.length > 0) {
        throw new Error(`voidUsageRecord: refused after stock was reversed — ${result.reason}`);
      }
      return result;
    }
    movementIds.push(result.movementId);
  }

  // ⭐ The entry, third — after the stock and the layers, inside the same transaction. A reversal
  // that fails (closed period for `voidedOn`, say) THROWS and unwinds the stock above with it:
  // "all of it or none" holds in the void direction exactly as it does in the post direction.
  const reason = (input.reason ?? '').trim() || `void of ${input.kind} record ${input.recordId}`;
  const entries = await journalRepo.findPostedEntriesBySource(tx, input.orgId, input.kind, `${input.recordId}:`);
  const reversalEntryIds: string[] = [];
  for (const entry of entries) {
    const reversed = await reverseEntry(tx, {
      entryId: entry.id,
      reason,
      reversalDate: input.voidedOn,
      reversedBy: input.voidedBy,
    });
    reversalEntryIds.push(reversed.reversalEntryId);
  }

  return { ok: true, movementIds, reversalEntryIds };
}
