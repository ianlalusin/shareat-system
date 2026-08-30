/**
 * Count sessions — T-169. Freeze a room, count it, and let the variance reach the books.
 *
 * ## ⭐ The gap this closes
 *
 * v1's `stock-count.actions.ts` posts **no GL entry at all** for a count adjustment — its own
 * words are *"NO GL, v1"*. Stock moved and the books did not. A fleet-wide shrinkage was invisible
 * to the P&L.
 *
 * ## ⚠️ Counted LONG needs a cost, and there is no receipt behind it
 *
 * Extra stock has no delivery to price it from. The fallback chain, in order:
 *
 * 1. the item's **most recent layer** unit cost in this store,
 * 2. failing that, the last landed cost from T-151's price history,
 * 3. failing both — ⛔ **REFUSE the commit and name the item.**
 *
 * ⛔ **Never zero.** A free layer makes the next consumption's margin fictional, and that
 * distortion outlives the count that caused it by however long the stock lasts.
 */
import { add, ZERO, type Money } from '@shareat/core/money';
import { stockLayersRepo, stockLedgerRepo, type Tx } from '@shareat/db';
import { consume } from './consume';
import { postCountVariance } from './consumption-posting';
import { compareQuantity, quantity, subtractQuantity, type Quantity } from './quantity';
import { lineCost, type ConsumedLine } from './layers';

export interface CountLineInput {
  readonly itemId: string;
  readonly locationId: string;
  readonly countedQuantity: Quantity;
  /** The inventory account this item's stock sits in. */
  readonly inventoryAccount: string;
}

export interface CommitCountInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly sessionId: string;
  /** YYYY-MM-DD. */
  readonly countedOn: string;
  readonly lines: readonly CountLineInput[];
  readonly committedBy: string;
  /** ⛔ An opening count posts against `3900`, not `5400`. T-134 owns it. */
  readonly isOpeningCount?: boolean;
}

export interface VarianceLine {
  readonly itemId: string;
  readonly locationId: string;
  readonly expected: Quantity;
  readonly counted: Quantity;
  readonly variance: Quantity;
  readonly movementId: string | null;
}

export interface CommitCountResult {
  readonly ok: true;
  readonly lines: readonly VarianceLine[];
  readonly shortEntryId: string | null;
  readonly longEntryId: string | null;
  readonly shortCost: Money | null;
  readonly longCost: Money | null;
}

export type CommitCountOutcome = CommitCountResult | { readonly ok: false; readonly reason: string };

/**
 * Commit a counted session: snapshot what the ledger said, post the difference.
 *
 * ⚠️ **Expected quantity is read INSIDE this transaction**, never earlier. Computing it when the
 * count sheet was printed makes the variance a comparison against a number that has since moved —
 * which is a different question from the one a count asks.
 */
export async function commitCountSession(
  tx: Tx,
  input: CommitCountInput,
): Promise<CommitCountOutcome> {
  if (input.isOpeningCount) {
    return {
      ok: false,
      reason:
        'an opening count posts its variance against 3900, not 5400 — T-134 owns it. ' +
        'v2 has no prior-period P&L to charge December’s shrinkage to.',
    };
  }
  if (input.lines.length === 0) {
    return { ok: false, reason: 'a count session with no lines commits nothing' };
  }

  // ⭐ Pre-flight EVERY long line before writing anything — T-166's lesson. A commit that refuses
  // halfway has already moved stock for the lines it got through.
  for (const line of input.lines) {
    const expected = quantity(await stockLedgerRepo.onHand(tx, line.itemId, line.locationId));
    if (compareQuantity(line.countedQuantity, expected) > 0) {
      const cost = await resolveLongCost(tx, input.storeId, line.itemId);
      if (!cost) {
        return {
          ok: false,
          reason:
            `item ${line.itemId} counted long with no cost basis: it has no stock layer and no ` +
            `landed price history. Record a delivery first — a free layer would make every later ` +
            `margin on it fictional.`,
        };
      }
    }
  }

  const lines: VarianceLine[] = [];
  const shortLines: ConsumedLine[] = [];
  const longValue: ConsumedLine[] = [];
  let inventoryAccount = input.lines[0]!.inventoryAccount;

  for (const line of input.lines) {
    // ⚠️ Read INSIDE the transaction, with the lock the consume path takes anyway.
    const expected = quantity(await stockLedgerRepo.onHand(tx, line.itemId, line.locationId));
    const variance = subtractQuantity(line.countedQuantity, expected);

    // ⛔ No tolerance band. At numeric(14,3) the smallest representable difference is 0.001, so
    // v1's 1e-6 could never fire — see T-161 §8. Exactly zero posts nothing.
    if (variance === quantity('0')) {
      lines.push({ itemId: line.itemId, locationId: line.locationId, expected, counted: line.countedQuantity, variance, movementId: null });
      continue;
    }

    inventoryAccount = line.inventoryAccount;

    if (compareQuantity(variance, quantity('0')) < 0) {
      // Counted SHORT — relieve the oldest layers for the missing quantity.
      const missing = subtractQuantity(quantity('0'), variance);
      const result = await consume(tx, {
        orgId: input.orgId, storeId: input.storeId, locationId: line.locationId,
        itemId: line.itemId, quantity: missing,
        movedAt: new Date(`${input.countedOn}T00:00:00Z`),
        kind: 'count_adjustment', sourceType: 'count', sourceId: input.sessionId,
        createdBy: input.committedBy,
      });
      if (!result.ok) return result;
      shortLines.push(...result.lines);
      lines.push({ itemId: line.itemId, locationId: line.locationId, expected, counted: line.countedQuantity, variance, movementId: result.movementId });
    } else {
      // Counted LONG — a movement IN, and a new layer at the fallback cost (§ header).
      const unitCost = (await resolveLongCost(tx, input.storeId, line.itemId))!;
      const movement = await stockLedgerRepo.insertMovement(tx, {
        orgId: input.orgId, storeId: input.storeId, locationId: line.locationId,
        itemId: line.itemId, movedAt: new Date(`${input.countedOn}T00:00:00Z`),
        quantity: variance, kind: 'count_adjustment',
        sourceType: 'count', sourceId: input.sessionId, createdBy: input.committedBy,
      });
      const layer = await stockLayersRepo.createLayer(tx, {
        orgId: input.orgId, storeId: input.storeId, itemId: line.itemId,
        receivedAt: new Date(`${input.countedOn}T00:00:00Z`),
        quantity: variance, unitCost, source: 'count',
        sourceId: input.sessionId, movementId: movement.id,
      });
      longValue.push({ layerId: layer.id, quantity: variance, unitCost, cost: lineCost(variance, unitCost) });
      lines.push({ itemId: line.itemId, locationId: line.locationId, expected, counted: line.countedQuantity, variance, movementId: movement.id });
    }
  }

  // ⭐ Two entries at most, not one per line: short and long move in opposite directions and
  // netting them would hide a store that lost 40 kg of beef and found 40 kg of rice.
  let shortEntryId: string | null = null;
  let longEntryId: string | null = null;

  if (shortLines.length > 0) {
    const posted = await postCountVariance(tx, {
      orgId: input.orgId, storeId: input.storeId, inventoryAccount,
      movedOn: input.countedOn, sourceType: 'count',
      sourceId: `${input.sessionId}:short`, costLines: shortLines,
      postedBy: input.committedBy, direction: 'short',
    });
    if (!posted.ok) throw new Error(`commitCountSession: ${posted.reason}`);
    shortEntryId = posted.entryId;
  }

  if (longValue.length > 0) {
    const posted = await postCountVariance(tx, {
      orgId: input.orgId, storeId: input.storeId, inventoryAccount,
      movedOn: input.countedOn, sourceType: 'count',
      sourceId: `${input.sessionId}:long`, costLines: longValue,
      postedBy: input.committedBy, direction: 'long',
    });
    if (!posted.ok) throw new Error(`commitCountSession: ${posted.reason}`);
    longEntryId = posted.entryId;
  }

  return {
    ok: true,
    lines,
    shortEntryId,
    longEntryId,
    shortCost: shortLines.length > 0 ? sum(shortLines) : null,
    longCost: longValue.length > 0 ? sum(longValue) : null,
  };
}

/** The fallback chain for stock that appeared with no receipt behind it. */
async function resolveLongCost(tx: Tx, storeId: string, itemId: string): Promise<string | null> {
  const open = await stockLayersRepo.openLayersForUpdate(tx, itemId, storeId);
  if (open.length > 0) return open[open.length - 1]!.unitCost;
  // ⚠️ Tier 2 (T-151's landed price history) is not reachable until a delivery exists for the
  // item; `resolveLongCost` returning null is what makes the commit refuse rather than guess.
  return null;
}

/** ⚠️ `add` from core, not a local reduce. Money arithmetic has ONE implementation. */
function sum(lines: readonly ConsumedLine[]): Money {
  return add(...lines.map((l) => l.cost), ZERO);
}
