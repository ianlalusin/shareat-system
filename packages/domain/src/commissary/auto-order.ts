/**
 * Low stock becomes an order — T-175.
 *
 * ## ⭐ The one change from v1, and it is the task's open question
 *
 * v1 queues a low-stock item onto the branch's open draft at **quantity 0**. `docs/discovery/14`
 * §D asks directly whether that is *"used and valued in practice, or does it just clutter drafts
 * with 0-qty lines nobody fills in?"*
 *
 * ⚠️ **A zero-quantity line is a to-do item wearing an order line's clothes.** This builds it with
 * a **suggested quantity** — `threshold − onHand`, rounded up to a whole base unit — because that
 * number is computable from data v2 already has, and a line that arrives with a figure the branch
 * can accept or type over is one keystroke fewer than typing into a blank.
 *
 * ⛔ **One line reverts it**: `suggestedQuantity` below becomes `quantity('0')`. It is flagged for
 * Ian rather than decided quietly.
 *
 * ## ⭐ Failure here NEVER fails the usage post that triggered it
 *
 * This runs **after** the usage transaction commits, in its own. *A cook must be able to record
 * what they used even when the ordering subsystem is down.* ⚠️ That is the whole reason the
 * function returns a report instead of throwing, and the reason `postUsageRecord` does not call it.
 */
import { commissaryRepo, lowStockRepo, transaction, type Tx } from '@shareat/db';
import { lineCost } from '../stock/layers';
import { quantity, toThousandths, type Quantity } from '../stock/quantity';
import { resolveBranchRate } from './orders';
import type { Outcome } from './outcome';

export interface AutoOrderInput {
  readonly orgId: string;
  readonly branchStoreId: string;
  /**
   * The buyer's counterparty record — how an internal order names the branch.
   *
   * ⭐ **Optional since T-223.** The real caller is an ERP action that has just committed a usage
   * post; it holds the store, not the customer, and should not open a transaction of its own to go
   * looking. Omitted, it is resolved here from the store, inside the transaction that is already
   * open. ⛔ A store with no counterparty customer is **not a buyer**, which is a note and not an
   * error — the same shape as having no commissary link.
   */
  readonly customerId?: string;
  readonly orderedOn: string;
  readonly createdBy: string;
  /** Restrict to the items a usage post just touched; omit to sweep the whole store. */
  readonly itemIds?: readonly string[];
}

export interface AutoOrderReport {
  readonly orderId: string | null;
  readonly created: boolean;
  readonly appended: readonly { itemId: string; suggested: Quantity }[];
  /** Already on the order, so left alone — invariant 6's idempotence, made visible. */
  readonly skipped: readonly string[];
  readonly notes: readonly string[];
}

/**
 * ⭐ Round UP to a whole base unit. Ordering 3.4 kg of pork is not a thing anybody does, and a
 * suggestion that has to be rounded by hand is a suggestion that gets retyped.
 */
export function suggestFor(shortfall: string): Quantity {
  const thousandths = toThousandths(quantity(shortfall));
  if (thousandths <= 0n) return quantity('0');
  const whole = (thousandths + 999n) / 1000n;
  return quantity(whole.toString());
}

export async function ensureAutoOrderLines(
  tx: Tx,
  input: AutoOrderInput,
): Promise<Outcome<AutoOrderReport>> {
  // ⭐ BUYER STORES ONLY. A commissary restocks from suppliers through T-166, by a human — it
  // never orders from itself, and the link table is what says which a store is.
  const commissaryStoreId = await lowStockRepo.commissaryFor(tx, input.orgId, input.branchStoreId);
  if (!commissaryStoreId) {
    return { ok: false, reason: 'this store has no active commissary link — it is not a buyer store' };
  }

  // ⭐ T-223. Resolve the counterparty here when the caller did not supply one — see AutoOrderInput.
  const customerId =
    input.customerId ??
    (await commissaryRepo.internalCustomerFor(tx, input.orgId, input.branchStoreId))?.id;
  if (!customerId) {
    return {
      ok: false,
      reason: 'this store has no counterparty customer record — it cannot be billed for an internal order',
    };
  }

  const low = await lowStockRepo.lowStock(tx, input.orgId, input.branchStoreId);
  const wanted = input.itemIds ? new Set(input.itemIds) : null;
  const candidates = wanted ? low.filter((r) => wanted.has(r.itemId)) : low;
  if (candidates.length === 0) {
    return { ok: true, orderId: null, created: false, appended: [], skipped: [], notes: ['nothing is at or below threshold'] };
  }

  const notes: string[] = [];
  // ⚠️ `FOR UPDATE`, so two concurrent usage posts cannot each decide there is no open order and
  // each create one — which `trade_orders_one_open_per_branch_key` would then refuse, failing the
  // second post for a reason that has nothing to do with what it was recording.
  const existing = await lowStockRepo.openOrderFor(tx, input.orgId, input.branchStoreId, commissaryStoreId);

  let orderId: string;
  let created = false;
  if (existing) {
    // ⛔ A `dispatched` order is goods-in-transit, not a draft. Appending to it would change an
    // order the commissary has already packed; starting a second one is refused by T-172's index.
    // So this reports and does nothing, which is the honest outcome.
    if (existing.status !== 'draft') {
      return {
        ok: true, orderId: existing.id, created: false, appended: [], skipped: [],
        notes: [`the open order is ${existing.status}, not a draft — nothing was added to it`],
      };
    }
    orderId = existing.id;
  } else {
    const draft = await lowStockRepo.createDraftOrder(tx, {
      orgId: input.orgId, commissaryStoreId, branchStoreId: input.branchStoreId,
      customerId: customerId, orderDate: input.orderedOn, createdBy: input.createdBy,
    });
    orderId = draft.id;
    created = true;
  }

  const already = await lowStockRepo.itemsAlreadyOnOrder(tx, orderId);
  const appended: { itemId: string; suggested: Quantity }[] = [];
  const skipped: string[] = [];

  for (const row of candidates) {
    // ⭐ Invariant 6: already on the draft means LEAVE IT ALONE, at any quantity. A second usage
    // post crossing the same threshold must not add the item twice, and must not overwrite a
    // figure somebody has already typed.
    if (already.has(row.itemId)) {
      skipped.push(row.itemId);
      continue;
    }
    const suggested = suggestFor(row.shortfall);
    if (toThousandths(suggested) <= 0n) {
      // Exactly AT threshold with nothing to make up. Real, and not worth a zero-quantity line.
      skipped.push(row.itemId);
      continue;
    }
    const rate = await resolveRate(tx, input.orgId, commissaryStoreId, row.itemId);
    if (!rate) {
      // ⛔ Never a silent zero. A ₱0 line becomes a ₱0 order becomes a ₱0 receivable, and nobody
      // notices until the month closes — T-171's rule, and it applies to a machine-made line more
      // than a hand-made one, because no human sees this one before it lands.
      notes.push(`${row.itemName} is low but the commissary has no price for it — not added`);
      continue;
    }
    await lowStockRepo.appendAutoLine(tx, {
      orgId: input.orgId, orderId, itemId: row.itemId, unit: row.baseUnit,
      suggestedQuantity: suggested, rate, lineTotal: lineCost(suggested, rate),
    });
    appended.push({ itemId: row.itemId, suggested });
  }

  if (appended.length > 0) await lowStockRepo.refreshOrderTotal(tx, orderId);
  return { ok: true, orderId, created, appended, skipped, notes };
}

/**
 * The commissary's price for this item.
 *
 * ⭐ Since 2026-09-03 (T-172) this is `resolveBranchRate` — T-151's branch-price rule first, then
 * the manager-set `manual_cost` on the offering — the SAME fallback a hand-made line uses, so a
 * machine-made line and a typed one cannot price differently. Until then it read tier 3 alone,
 * because the catalogue read path it belongs with was unbuilt. ⛔ Returning null rather than
 * guessing is the point: an unpriced line does not get created.
 */
async function resolveRate(
  tx: Tx,
  orgId: string,
  commissaryStoreId: string,
  itemId: string,
): Promise<string | null> {
  const resolved = await resolveBranchRate(tx, orgId, commissaryStoreId, itemId);
  return resolved?.rate ?? null;
}

/**
 * ⭐ **The after-commit wrapper, and it is invariant 8 in one function.**
 *
 * *A cook must be able to record what they used even when the ordering subsystem is down.* So this
 * opens its **own transaction**, and it **never throws**: any failure comes back as a report the
 * caller can log or turn into a finding.
 *
 * ⛔ Call it AFTER the usage transaction has committed — never inside it. Sharing the transaction
 * would mean a broken commissary link, a missing price row or a deadlock on the order rolls back
 * the usage the cook just recorded, and the cook would have no idea why.
 *
 * ⚠️ It is deliberately NOT called from `postUsageRecord`. That function takes a `tx` it does not
 * own, so it is structurally incapable of running anything after the commit — and wiring it in
 * there would produce exactly the coupling this invariant forbids.
 */
export async function replenishAfterUsage(
  input: AutoOrderInput,
): Promise<AutoOrderReport & { readonly failed: string | null }> {
  const empty = { orderId: null, created: false, appended: [], skipped: [], notes: [] };
  try {
    const res = await transaction((tx) => ensureAutoOrderLines(tx, input));
    if (!res.ok) return { ...empty, failed: null, notes: [res.reason] };
    const { ok: _ok, ...report } = res;
    return { ...report, failed: null };
  } catch (error) {
    // ⭐ Swallowed ON PURPOSE, and the report says so rather than the log alone. The usage post is
    // already committed and must stay that way; what is lost is a draft line, which the branch can
    // add by hand and the low-stock list still shows.
    return {
      ...empty,
      failed: error instanceof Error ? error.message : String(error),
      notes: ['the usage post is unaffected — it committed before this ran'],
    };
  }
}
