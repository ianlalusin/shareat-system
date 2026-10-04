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
import { add, decimal, ZERO, type Decimal, type Money } from '@shareat/core/money';
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
  /** The first short / long entry — kept for callers that store one id. */
  readonly shortEntryId: string | null;
  readonly longEntryId: string | null;
  /** ⭐ One entry per (inventory account, direction) — a mixed-kind count posts several. */
  readonly shortEntryIds: readonly string[];
  readonly longEntryIds: readonly string[];
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
  // ⭐ Grouped by each line's OWN inventory account. A commissary counts pork (`1310`) and takeout
  // boxes (`1320`) in one room; each account must move by exactly its own items' cost, or the
  // control accounts stop tying to the layers (invariant 6). ⚠️ Until the 2026-09-03 review this
  // posted the WHOLE variance against whichever account the last varying line carried — reachable
  // for the first time once T-169's screen let one session hold two kinds.
  const shortByAccount = new Map<string, ConsumedLine[]>();
  const longByAccount = new Map<string, ConsumedLine[]>();
  let anyWritten = false;

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
      if (!result.ok) {
        // ⛔ A refusal after an earlier line already wrote its movement must UNWIND the
        // transaction, never be handed back for the caller to commit (T-166 §7.2).
        if (anyWritten) throw new Error(`commitCountSession: refused after stock was written — ${result.reason}`);
        return result;
      }
      anyWritten = true;
      const group = shortByAccount.get(line.inventoryAccount) ?? [];
      group.push(...result.lines);
      shortByAccount.set(line.inventoryAccount, group);
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
      anyWritten = true;
      const group = longByAccount.get(line.inventoryAccount) ?? [];
      group.push({ layerId: layer.id, quantity: variance, unitCost, cost: lineCost(variance, unitCost) });
      longByAccount.set(line.inventoryAccount, group);
      lines.push({ itemId: line.itemId, locationId: line.locationId, expected, counted: line.countedQuantity, variance, movementId: movement.id });
    }
  }

  // ⭐ One entry per (inventory account, direction), never one per line — and short and long are
  // never netted: netting would hide a store that lost 40 kg of beef and found 40 kg of rice.
  const shortEntryIds: string[] = [];
  const longEntryIds: string[] = [];
  let shortCost: Money | null = null;
  let longCost: Money | null = null;

  for (const [inventoryAccount, costLines] of shortByAccount) {
    const posted = await postCountVariance(tx, {
      orgId: input.orgId, storeId: input.storeId, inventoryAccount,
      movedOn: input.countedOn, sourceType: 'count',
      sourceId: `${input.sessionId}:short:${inventoryAccount}`, costLines,
      postedBy: input.committedBy, direction: 'short',
    });
    if (!posted.ok) throw new Error(`commitCountSession: ${posted.reason}`);
    shortEntryIds.push(posted.entryId);
    shortCost = add(shortCost ?? ZERO, sum(costLines));
  }

  for (const [inventoryAccount, costLines] of longByAccount) {
    const posted = await postCountVariance(tx, {
      orgId: input.orgId, storeId: input.storeId, inventoryAccount,
      movedOn: input.countedOn, sourceType: 'count',
      sourceId: `${input.sessionId}:long:${inventoryAccount}`, costLines,
      postedBy: input.committedBy, direction: 'long',
    });
    if (!posted.ok) throw new Error(`commitCountSession: ${posted.reason}`);
    longEntryIds.push(posted.entryId);
    longCost = add(longCost ?? ZERO, sum(costLines));
  }

  return {
    ok: true,
    lines,
    shortEntryId: shortEntryIds[0] ?? null,
    longEntryId: longEntryIds[0] ?? null,
    shortEntryIds,
    longEntryIds,
    shortCost,
    longCost,
  };
}

/** The fallback chain for stock that appeared with no receipt behind it. */
async function resolveLongCost(tx: Tx, storeId: string, itemId: string): Promise<Decimal<'14,4'> | null> {
  const open = await stockLayersRepo.openLayersForUpdate(tx, itemId, storeId);
  if (open.length > 0) return decimal(open[open.length - 1]!.unitCost, '14,4'); // T-371 R4: re-minted, never cast
  // ⚠️ Tier 2 (T-151's landed price history) is not reachable until a delivery exists for the
  // item; `resolveLongCost` returning null is what makes the commit refuse rather than guess.
  return null;
}

/** ⚠️ `add` from core, not a local reduce. Money arithmetic has ONE implementation. */
function sum(lines: readonly ConsumedLine[]): Money {
  return add(...lines.map((l) => l.cost), ZERO);
}
