/**
 * Wholesale orders. T-132 — `docs/tasks/132-wholesale-orders.md`.
 *
 * ⭐ **Dispatch is the billing event**, and it bills by calling `recordCharge` rather than posting
 * its own entry. One function owns the `1210`/revenue legs, so the double-post class of bug — the
 * one that cost ₱198,148.29 in v1 when a platform fee was recognised twice — is impossible here by
 * construction rather than by a rule someone must remember.
 *
 * ⛔ **No COGS, and that is a stated omission, not an oversight.** There is no inventory module in
 * v2, so a dispatch relieves no stock. Wholesale revenue is measurable after this task; wholesale
 * MARGIN is not. See the spec's Out of scope.
 */
import {
  arRepo,
  customersRepo,
  itemsRepo,
  transaction,
  wholesaleRepo,
  type Tx,
} from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { recordCharge, voidCharge } from '../ar';

/** The account this task adds to the chart. Every 4xxx leaf before it was retail. */
export const WHOLESALE_REVENUE_CODE = '4300';

/** Decimal noise only, never a business allowance. Same value and reasoning as AP's and AR's. */
const EPSILON = 0.005;

export interface WholesaleLineDraft {
  itemId: string;
  quantity: string;
  unit?: string | null;
  /**
   * Omit to take the customer's price-list rate. ⚠️ Whatever is used is **captured** onto the
   * line — a later price-list edit never reaches back and changes it.
   */
  rate?: string | null;
}

export interface CreateWholesaleOrderInput {
  storeId: string;
  customerId: string;
  orderDate: string;
  lines: WholesaleLineDraft[];
  referenceNo?: string | null;
  notes?: string | null;
  /** Optional. When given it must equal the sum of the lines, to the centavo. */
  totalAmount?: string | null;
}

/**
 * Create a wholesale order — the document that finally consumes the item master, the price lists
 * and the wholesale flag.
 */
export async function createWholesaleOrder(
  tx: Tx | null,
  actor: Actor,
  input: CreateWholesaleOrderInput,
): Promise<{ orderId: string; totalAmount: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_buyer', { storeId: input.storeId });

    const customer = await customersRepo.getById(trx, actor.orgId, input.customerId);
    if (!customer) throw new Error(`createWholesaleOrder: customer ${input.customerId} does not exist.`);
    if (customer.status !== 'active') {
      throw new Error(`createWholesaleOrder: ${customer.name} is ${customer.status}, not active.`);
    }

    // ⛔ An own branch is NOT a wholesale customer, and the difference is a chart decision, not a
    // label. Consolidated, an internal transfer must eliminate against the buying store's 5170 —
    // the warning written beside that account in the seed — or the same peso is counted twice.
    if (customer.customerGroup === 'internal') {
      throw new Error(
        `createWholesaleOrder: ${customer.name} is an internal counterparty, so this is an ` +
          'inter-entity transfer, not a wholesale sale. Posting it to ordinary revenue would ' +
          'double-count on consolidation — it eliminates against 5170. That is T-133.',
      );
    }
    if (customer.customerGroup !== 'wholesale' && customer.customerGroup !== 'franchise') {
      throw new Error(
        `createWholesaleOrder: ${customer.name} is a ${customer.customerGroup} account, not a ` +
          'wholesale or franchise buyer.',
      );
    }

    if (input.lines.length === 0) {
      throw new Error('createWholesaleOrder: an order with no lines is the lump sum this task exists to replace.');
    }

    const lines: { itemId: string; quantity: string; unit: string; rate: string; lineTotal: string }[] = [];
    let total = 0;

    for (const [i, draft] of input.lines.entries()) {
      const item = await itemsRepo.getItemById(trx, actor.orgId, draft.itemId);
      if (!item) throw new Error(`createWholesaleOrder: line ${i + 1} names an item that does not exist.`);
      if (item.status !== 'active') {
        throw new Error(`createWholesaleOrder: line ${i + 1} names ${item.name}, which is ${item.status}.`);
      }

      // ⭐ Resolved AT THE SELLING STORE, not org-wide. Ian's bulgogi case, read from the selling
      // side: Lipa may sell the sauce it makes, while a branch that only buys it in may not.
      const sellability = await itemsRepo.sellabilityAt(trx, actor.orgId, draft.itemId, input.storeId);
      if (!sellability?.sellableWholesale) {
        throw new Error(
          `createWholesaleOrder: line ${i + 1} names ${item.name}, which this store does not sell ` +
            'wholesale. A bento box is sold à la carte and not to a franchisee — mark it sellable ' +
            'wholesale here first if that is genuinely what you mean.',
        );
      }

      const quoted = await wholesaleRepo.quotedRate(trx, actor.orgId, input.customerId, draft.itemId);
      const rate = draft.rate ?? quoted?.rate;
      if (rate === undefined || rate === null) {
        throw new Error(
          `createWholesaleOrder: line ${i + 1} names ${item.name}, and ${customer.name}'s price ` +
            'list does not quote it. Add a rate to the price list, or state one on the line.',
        );
      }
      if (Number(rate) < 0) throw new Error(`createWholesaleOrder: line ${i + 1} has a negative rate.`);
      if (Number(draft.quantity) <= 0) {
        throw new Error(`createWholesaleOrder: line ${i + 1} has a quantity of ${draft.quantity}.`);
      }

      const lineTotal = (Number(draft.quantity) * Number(rate)).toFixed(2);
      if (Number(lineTotal) <= 0) {
        throw new Error(`createWholesaleOrder: line ${i + 1} comes to zero, so it bills nothing.`);
      }
      total += Number(lineTotal);
      lines.push({
        itemId: draft.itemId,
        quantity: draft.quantity,
        unit: draft.unit?.trim() || quoted?.unit || item.baseUnit,
        rate: Number(rate).toFixed(2),
        lineTotal,
      });
    }

    const totalAmount = total.toFixed(2);
    if (input.totalAmount != null && Math.abs(Number(input.totalAmount) - total) > EPSILON) {
      throw new Error(
        `createWholesaleOrder: the lines come to ₱${totalAmount}, but the order says ` +
          `₱${input.totalAmount}. One of the two is wrong.`,
      );
    }

    const { id: orderId } = await wholesaleRepo.insertOrder(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      customerId: input.customerId,
      orderDate: input.orderDate,
      referenceNo: input.referenceNo?.trim() || null,
      notes: input.notes?.trim() || null,
      totalAmount,
      createdBy: actor.personId,
    });
    await wholesaleRepo.insertLines(trx, actor.orgId, orderId, lines);
    return { orderId, totalAmount };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Nothing posts here. Confirming says the order is agreed and ready to go out. */
export async function confirmWholesaleOrder(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await wholesaleRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`confirmWholesaleOrder: order ${input.orderId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    if (order.status !== 'draft') {
      throw new Error(`confirmWholesaleOrder: order is ${order.status}, not draft.`);
    }
    await wholesaleRepo.setStatus(trx, actor.orgId, order.id, 'confirmed');
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface DispatchResult {
  orderId: string;
  chargeId: string;
  entryId: string;
  /** True when the credit limit was breached and someone with the capability let it through. */
  creditOverridden: boolean;
}

/**
 * ⭐ **The billing event.** Goods leave, the receivable exists, revenue is recognised — one act,
 * because for a dozen named buyers billed per delivery there is nothing for a separate invoice
 * step to add. (`docs/discovery/19-b2b-order-to-cash.md` §2.5; Dolibarr bills straight from a
 * validated order, and even ERPNext ships a switch to skip the delivery note.)
 *
 * ⚠️ Idempotent: dispatching an already-dispatched order returns what it already did.
 */
export async function dispatchWholesaleOrder(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string; creditOverrideReason?: string | null },
): Promise<DispatchResult> {
  const run = async (trx: Tx): Promise<DispatchResult> => {
    const order = await wholesaleRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`dispatchWholesaleOrder: order ${input.orderId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });

    // Idempotent by design — a retried dispatch must not raise a second receivable.
    if (order.status === 'dispatched') {
      if (!order.arChargeId || !order.journalEntryId) {
        throw new Error('dispatchWholesaleOrder: order is dispatched but carries no charge — that is a bug.');
      }
      return {
        orderId: order.id,
        chargeId: order.arChargeId,
        entryId: order.journalEntryId,
        creditOverridden: order.creditOverrideReason !== null,
      };
    }
    if (order.status !== 'draft' && order.status !== 'confirmed') {
      throw new Error(`dispatchWholesaleOrder: order is ${order.status}, so it cannot be dispatched.`);
    }

    const customer = await customersRepo.getById(trx, actor.orgId, order.customerId);
    if (!customer) throw new Error('dispatchWholesaleOrder: the order names a customer that no longer exists.');

    // ---------------------------------------------------------------------------------------
    // The credit gate — ONE gate, here, because this is the one act that creates exposure.
    // ⛔ ERPNext checks at three document-submit hooks; it has three documents. We have one.
    // ---------------------------------------------------------------------------------------
    let creditOverrideBy: string | null = null;
    let creditOverrideReason: string | null = null;

    if (customer.creditLimit !== null) {
      // ⚠️ Derived from the ledger, never a stored balance — org-wide, because a credit limit is
      // extended to a BUYER, not to a buyer at one branch.
      const { controlBalance } = await arRepo.positionOf(trx, actor.orgId, order.customerId);
      const after = Number(controlBalance) + Number(order.totalAmount);
      if (after > Number(customer.creditLimit) + EPSILON) {
        const reason = input.creditOverrideReason?.trim() || '';
        // ⚠️ `authorize` throws rather than answering, and there is no `can()` in @shareat/auth.
        // Catching ONLY AuthorizationError keeps a real failure (a dead connection, a missing
        // person) loud instead of silently reading as "not permitted".
        let mayOverride = true;
        try {
          await authorize(trx, actor, 'override_credit_limit', { storeId: order.storeId });
        } catch (e) {
          if (!(e instanceof AuthorizationError)) throw e;
          mayOverride = false;
        }
        if (!mayOverride || !reason) {
          throw new Error(
            `dispatchWholesaleOrder: ${customer.name} owes ₱${controlBalance} and this order is ` +
              `₱${order.totalAmount}, which would take them to ₱${after.toFixed(2)} against a ` +
              `limit of ₱${customer.creditLimit}. A manager or admin can dispatch it anyway by ` +
              'saying why.',
          );
        }
        creditOverrideBy = actor.personId;
        creditOverrideReason = reason;
      }
    }

    // ⭐ Bills by calling AR, never by posting its own legs. One owner of the 1210/4200 entry.
    const { chargeId, entryId } = await recordCharge(trx, actor, {
      storeId: order.storeId,
      customerId: order.customerId,
      chargeDate: order.orderDate,
      totalAmount: order.totalAmount,
      revenueAccountCode: WHOLESALE_REVENUE_CODE,
      referenceNo: order.referenceNo,
      notes: `Wholesale order ${order.referenceNo ?? order.id}`,
    });

    await wholesaleRepo.markDispatched(trx, actor.orgId, order.id, {
      arChargeId: chargeId,
      journalEntryId: entryId,
      dispatchedBy: actor.personId,
      creditOverrideBy,
      creditOverrideReason,
    });

    return { orderId: order.id, chargeId, entryId, creditOverridden: creditOverrideReason !== null };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Void an order. ⚠️ A dispatched order's receivable is **reversed**, never deleted — `voidCharge`
 * posts the mirror entry, so the ledger keeps both halves of what happened.
 */
export async function voidWholesaleOrder(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string; reason: string },
): Promise<{ reversedEntryId: string | null }> {
  const run = async (trx: Tx) => {
    const order = await wholesaleRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`voidWholesaleOrder: order ${input.orderId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    if (order.status === 'void') throw new Error('voidWholesaleOrder: this order is already void.');

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidWholesaleOrder: say why this order is being voided.');

    let reversedEntryId: string | null = null;
    if (order.status === 'dispatched') {
      if (!order.arChargeId) {
        throw new Error('voidWholesaleOrder: order is dispatched but carries no charge — that is a bug.');
      }
      const { entryId } = await voidCharge(trx, actor, { chargeId: order.arChargeId, reason });
      reversedEntryId = entryId;
    }

    await wholesaleRepo.markVoided(trx, actor.orgId, order.id, {
      voidedBy: actor.personId,
      voidReason: reason,
    });
    return { reversedEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}
