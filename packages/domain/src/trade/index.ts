/**
 * Trade orders — ONE flow, TWO accounting treatments. T-132 and T-133.
 * `docs/tasks/132-wholesale-orders.md`, `docs/tasks/133-inter-entity-trade.md`.
 *
 * ⭐ ADR-008 §8: *"One ordering and fulfilment flow. Two accounting treatments, derived from the
 * counterparty. … A mode is a fork; a derived treatment is a fact."* The commissary staff pack the
 * same crates on the same morning whoever is receiving; only the posting differs.
 *
 * | Counterparty | Dispatch posts |
 * |---|---|
 * | `external` / a franchise buying from us | `DR 1210 AR` / `CR 4300 Wholesale sales` — a real sale |
 * | `internal` — our own store | the four-leg `1330`/`1250`/`2150` transfer, which ELIMINATES |
 *
 * ⛔ **A branch is not a customer of its own company.** v1 books branch sales as revenue, which is
 * why it then needed `excludeBranchSales` to stop its own insights being wrong — the exclusion is
 * the tell that the recognition was wrong upstream.
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
  moneyTransfersRepo,
  transaction,
  tradeRepo,
  type Tx,
} from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { recordCharge, voidCharge } from '../ar';
import { branchPriceFor } from '../items';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';

/** The account T-132 adds to the chart. Every 4xxx leaf before it was retail. */
export const WHOLESALE_REVENUE_CODE = '4300';

/**
 * ⚠️ **SUPERSEDED SHAPE, STILL LIVE.** ADR-011 made this system perpetual, and T-172/T-173 built
 * the replacement — `dispatchOrder`/`confirmReceipt` in `../commissary/transfer.ts`, where the cost
 * stays an ASSET the whole way (`1310`/`1320`/`1330` → `1340` → the branch's inventory) and never
 * enters the P&L. Those functions are built and tested and **called by nothing**; this one is what
 * a real order still posts. **T-165 rewires the internal branch below onto them.** ⛔ Do not call
 * both for one order — the transfer would be counted twice and the trial balance would still tie.
 *
 * ⭐ T-133's internal-transfer legs. A transfer moves **COST**, not inventory.
 *
 * ⛔ `POSTING-PATTERNS.md` §`commissary_dispatch.transfer` moves `1330` inventory between stores,
 * and that pattern assumes **perpetual** inventory. This system is **periodic**: every expense
 * category maps to a 5xxx COGS account, there is no capitalisation path, and nothing anywhere
 * debits `1310`/`1330`/`1340`. Moving inventory that was never recognised drove the seller's
 * `1330` negative and left the cost stranded in the seller's P&L — so the receiving branch could
 * not expense what it received at all. Found by Ian, 2026-08-28.
 *
 * ⭐ The fix is what the chart already described: `5170`'s own comment has said since T-102b that
 * it *"must ELIMINATE against the commissary's transfer-out"*. `5175` is that transfer-out.
 *
 *     seller   DR 1250 Due from related store   /  CR 5175 Cost transferred to branches
 *     buyer    DR 5170 COGS — commissary transfers  /  CR 2150 Due to related store
 *
 * ⚠️ The transfer PRICE carries the seller's processing cost. Lipa buying a slab at ₱300/kg and
 * processing it at ₱10/kg transfers at ₱310 — that is the mechanism by which Lipa's work reaches
 * Malvar's books, and it is why the rate is on the line rather than derived.
 */
export const TRANSFER_OUT_CODE = '5175';
export const COMMISSARY_COGS_CODE = '5170';
export const DUE_FROM_STORE_CODE = '1250';
export const DUE_TO_STORE_CODE = '2150';

/** Decimal noise only, never a business allowance. Same value and reasoning as AP's and AR's. */
const EPSILON = 0.005;

export interface TradeLineDraft {
  itemId: string;
  quantity: string;
  unit?: string | null;
  /**
   * Omit to take the customer's price-list rate. ⚠️ Whatever is used is **captured** onto the
   * line — a later price-list edit never reaches back and changes it.
   */
  rate?: string | null;
}

export interface CreateTradeOrderInput {
  storeId: string;
  customerId: string;
  orderDate: string;
  lines: TradeLineDraft[];
  referenceNo?: string | null;
  notes?: string | null;
  /** Optional. When given it must equal the sum of the lines PLUS the fees, to the centavo. */
  totalAmount?: string | null;
  /**
   * T-151. Outbound freight - us to the receiving store. Ian, 2026-08-28: *"delivery fee on top
   * of that is the fee from Lipa to Malvar."*
   *
   * ON TOP of the priced goods, never into an item's cost: it is a haulage charge for one
   * shipment, not a property of the item. It rides the posting, so it lands on the receiving
   * store exactly like the goods do.
   */
  deliveryFee?: string | null;
  otherFees?: string | null;
}

/**
 * Create a wholesale order — the document that finally consumes the item master, the price lists
 * and the wholesale flag.
 */
export async function createTradeOrder(
  tx: Tx | null,
  actor: Actor,
  input: CreateTradeOrderInput,
): Promise<{ orderId: string; totalAmount: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_buyer', { storeId: input.storeId });

    const customer = await customersRepo.getById(trx, actor.orgId, input.customerId);
    if (!customer) throw new Error(`createTradeOrder: customer ${input.customerId} does not exist.`);
    if (customer.status !== 'active') {
      throw new Error(`createTradeOrder: ${customer.name} is ${customer.status}, not active.`);
    }

    // ⭐ T-133. The treatment is DERIVED from the counterparty links, never from the group label
    // and never stored (ADR-008 §2). This one fact decides the whole posting below.
    const treatment = customersRepo.treatmentOf(customer);

    if (treatment === 'inter_entity') {
      throw new Error(
        `createTradeOrder: ${customer.name} belongs to another organisation, and their side of ` +
          'the trade cannot be posted from here — no second org exists in the data yet, and once ' +
          'RLS isolates two orgs no single transaction spans both. Their agreement becomes a ' +
          'scheduled reconciliation, which needs a real counterparty to design against. See ' +
          'docs/tasks/133-inter-entity-trade.md §4.',
      );
    }
    if (treatment === 'external' && customer.customerGroup !== 'wholesale' && customer.customerGroup !== 'franchise') {
      throw new Error(
        `createTradeOrder: ${customer.name} is a ${customer.customerGroup} account, not a ` +
          'wholesale or franchise buyer.',
      );
    }
    // ⛔ A store cannot transfer to itself: the four legs would net to nothing while looking
    // like a real movement, and the reciprocal pair would silently balance against itself.
    if (treatment === 'internal' && customer.counterpartyStoreId === input.storeId) {
      throw new Error(
        `createTradeOrder: ${customer.name} points at the very store dispatching this order. ` +
          'A store cannot transfer to itself.',
      );
    }

    if (input.lines.length === 0) {
      throw new Error('createTradeOrder: an order with no lines is the lump sum this task exists to replace.');
    }

    const lines: { itemId: string; quantity: string; unit: string; rate: string; lineTotal: string }[] = [];
    let total = 0;

    for (const [i, draft] of input.lines.entries()) {
      const item = await itemsRepo.getItemById(trx, actor.orgId, draft.itemId);
      if (!item) throw new Error(`createTradeOrder: line ${i + 1} names an item that does not exist.`);
      if (item.status !== 'active') {
        throw new Error(`createTradeOrder: line ${i + 1} names ${item.name}, which is ${item.status}.`);
      }

      // ⭐ Resolved AT THE SELLING STORE, not org-wide. Ian's bulgogi case, read from the selling
      // side: Lipa may sell the sauce it makes, while a branch that only buys it in may not.
      //
      // ⚠️ T-133: this gate is about SELLING, so it does not apply to an internal transfer.
      // Moving prepped goods to our own branch is not a wholesale sale, and demanding the
      // wholesale flag for it would force every transferable item to be marked sellable to
      // franchisees — which is the opposite of what that flag means.
      if (treatment !== 'internal') {
        const sellability = await itemsRepo.sellabilityAt(trx, actor.orgId, draft.itemId, input.storeId);
        if (!sellability?.sellableWholesale) {
          throw new Error(
            `createTradeOrder: line ${i + 1} names ${item.name}, which this store does not sell ` +
              'wholesale. A bento box is sold à la carte and not to a franchisee — mark it sellable ' +
              'wholesale here first if that is genuinely what you mean.',
          );
        }
      }

      // T-151. An INTERNAL transfer is charged cost-plus, not off a rate card: a branch is not
      // quoted a price list, it is charged what the goods cost plus the agreed markup. A stated
      // rate still wins - the branch price is a default, never a lock.
      let derived: string | null = null;
      if (treatment === 'internal' && draft.rate == null) {
        const bp = await branchPriceFor(trx, actor.orgId, draft.itemId);
        derived = bp?.price ?? null;
      }
      const quoted = treatment === 'internal'
        ? undefined
        : await tradeRepo.quotedRate(trx, actor.orgId, input.customerId, draft.itemId);
      const rate = draft.rate ?? derived ?? quoted?.rate;
      if (rate === undefined || rate === null) {
        throw new Error(
          treatment === 'internal'
            ? `createTradeOrder: line ${i + 1} names ${item.name}, and nothing can price it — it ` +
              'has no branch price rule, or no purchase history to base one on. Set a pricing ' +
              'rule, or state a rate on the line.'
            : `createTradeOrder: line ${i + 1} names ${item.name}, and ${customer.name}'s price ` +
              'list does not quote it. Add a rate to the price list, or state one on the line.',
        );
      }
      if (Number(rate) < 0) throw new Error(`createTradeOrder: line ${i + 1} has a negative rate.`);
      if (Number(draft.quantity) <= 0) {
        throw new Error(`createTradeOrder: line ${i + 1} has a quantity of ${draft.quantity}.`);
      }

      const lineTotal = (Number(draft.quantity) * Number(rate)).toFixed(2);
      if (Number(lineTotal) <= 0) {
        throw new Error(`createTradeOrder: line ${i + 1} comes to zero, so it bills nothing.`);
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

    const deliveryFee = Number(input.deliveryFee ?? 0);
    const otherFees = Number(input.otherFees ?? 0);
    if (deliveryFee < 0 || otherFees < 0) {
      throw new Error('createTradeOrder: a fee cannot be negative.');
    }
    const goodsTotal = total;
    total += deliveryFee + otherFees;

    const totalAmount = total.toFixed(2);
    if (input.totalAmount != null && Math.abs(Number(input.totalAmount) - total) > EPSILON) {
      throw new Error(
        `createTradeOrder: the lines come to ₱${goodsTotal.toFixed(2)} plus ₱${(deliveryFee + otherFees).toFixed(2)} ` +
          `of fees, so ₱${totalAmount} — but the order says ₱${input.totalAmount}. One of the two is wrong.`,
      );
    }

    const { id: orderId } = await tradeRepo.insertOrder(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      customerId: input.customerId,
      orderDate: input.orderDate,
      referenceNo: input.referenceNo?.trim() || null,
      notes: input.notes?.trim() || null,
      totalAmount,
      deliveryFee: deliveryFee.toFixed(2),
      otherFees: otherFees.toFixed(2),
      createdBy: actor.personId,
    });
    await tradeRepo.insertLines(trx, actor.orgId, orderId, lines);
    return { orderId, totalAmount };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Nothing posts here. Confirming says the order is agreed and ready to go out. */
export async function confirmTradeOrder(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await tradeRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`confirmTradeOrder: order ${input.orderId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    if (order.status !== 'draft') {
      throw new Error(`confirmTradeOrder: order is ${order.status}, not draft.`);
    }
    await tradeRepo.setStatus(trx, actor.orgId, order.id, 'confirmed');
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface DispatchResult {
  orderId: string;
  /** ⛔ Null for an INTERNAL transfer — a branch is not extended credit, so nothing is receivable. */
  chargeId: string | null;
  entryId: string;
  /** True when the credit limit was breached and someone with the capability let it through. */
  creditOverridden: boolean;
  treatment: 'internal' | 'external';
}

/**
 * ⭐ **The billing event.** Goods leave, the receivable exists, revenue is recognised — one act,
 * because for a dozen named buyers billed per delivery there is nothing for a separate invoice
 * step to add. (`docs/discovery/19-b2b-order-to-cash.md` §2.5; Dolibarr bills straight from a
 * validated order, and even ERPNext ships a switch to skip the delivery note.)
 *
 * ⚠️ Idempotent: dispatching an already-dispatched order returns what it already did.
 */
export async function dispatchTradeOrder(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string; creditOverrideReason?: string | null },
): Promise<DispatchResult> {
  const run = async (trx: Tx): Promise<DispatchResult> => {
    const order = await tradeRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`dispatchTradeOrder: order ${input.orderId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });

    // Idempotent by design — a retried dispatch must not raise a second receivable.
    if (order.status === 'dispatched' || order.status === 'received') {
      if (!order.journalEntryId) {
        throw new Error('dispatchTradeOrder: order is dispatched but carries no entry — that is a bug.');
      }
      return {
        orderId: order.id,
        chargeId: order.arChargeId,
        entryId: order.journalEntryId,
        creditOverridden: order.creditOverrideReason !== null,
        // ⚠️ Read back from the FACT — an internal transfer never raised a charge.
        treatment: order.arChargeId ? 'external' : 'internal',
      };
    }
    if (order.status !== 'draft' && order.status !== 'confirmed') {
      throw new Error(`dispatchTradeOrder: order is ${order.status}, so it cannot be dispatched.`);
    }

    const customer = await customersRepo.getById(trx, actor.orgId, order.customerId);
    if (!customer) throw new Error('dispatchTradeOrder: the order names a customer that no longer exists.');

    // -----------------------------------------------------------------------------------------
    // ⭐ T-133 — the INTERNAL transfer. One entry, four legs, two stores, and it ELIMINATES.
    //
    // ⛔ NO REVENUE: a branch is not a customer of its own company. What moves is COST — see the
    // account constants above for why this is not the inventory movement POSTING-PATTERNS.md
    // describes, and what has to change for that shape to become correct.
    // -----------------------------------------------------------------------------------------
    if (customersRepo.treatmentOf(customer) === 'internal') {
      const toStoreId = customer.counterpartyStoreId!;
      const codes = await moneyTransfersRepo.storeCodes(trx, actor.orgId, [order.storeId, toStoreId]);
      const fromCode = codes.get(order.storeId);
      const toCode = codes.get(toStoreId);
      if (!fromCode || !toCode) {
        throw new Error('dispatchTradeOrder: could not resolve both store codes for the transfer.');
      }
      const memo = `Transfer ${fromCode} → ${toCode} — ${order.referenceNo ?? order.id}`;
      const posted = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate: order.orderDate,
        sourceType: 'commissary_dispatch',
        sourceId: order.id,
        idempotencyKey: `commissary_dispatch:${order.id}:transfer`,
        memo,
        postedBy: actor.personId,
        lines: [
          // ⭐ The seller's cost LEAVES its P&L. It bought the goods (5110) and processed them
          // (payroll); crediting 5175 for the transfer price nets both back out, so the seller
          // ends at zero cost for goods it no longer holds.
          { accountCode: TRANSFER_OUT_CODE, storeId: order.storeId, credit: order.totalAmount, lineMemo: memo },
          // ...and the seller is owed for them. ⚠️ party_id is the OTHER store's CODE, not a uuid
          // — there is no party FK yet (DEF-040) and store codes are stable.
          {
            accountCode: DUE_FROM_STORE_CODE, storeId: order.storeId, debit: order.totalAmount,
            partyType: 'store' as const, partyId: toCode, lineMemo: `Due from ${toCode} — ${memo}`,
          },
          // ⭐ The buyer expenses what it received, into the account v1 already uses for exactly
          // this — so a commissary transfer reads the same on Malvar's P&L either way.
          { accountCode: COMMISSARY_COGS_CODE, storeId: toStoreId, debit: order.totalAmount, lineMemo: memo },
          // ...and the buyer owes for them. Equal and opposite, so invariant 6's reciprocal check
          // holds by construction rather than by anyone remembering.
          {
            accountCode: DUE_TO_STORE_CODE, storeId: toStoreId, credit: order.totalAmount,
            partyType: 'store' as const, partyId: fromCode, lineMemo: `Due to ${fromCode} — ${memo}`,
          },
        ],
      });

      await tradeRepo.markDispatched(trx, actor.orgId, order.id, {
        arChargeId: null,
        journalEntryId: posted.entryId,
        dispatchedBy: actor.personId,
        creditOverrideBy: null,
        creditOverrideReason: null,
      });
      // ⛔ No credit gate. A branch is not extended credit, so a limit on an internal counterparty
      // is meaningless and is deliberately not consulted.
      return { orderId: order.id, chargeId: null, entryId: posted.entryId, creditOverridden: false, treatment: 'internal' };
    }

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
            `dispatchTradeOrder: ${customer.name} owes ₱${controlBalance} and this order is ` +
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

    await tradeRepo.markDispatched(trx, actor.orgId, order.id, {
      arChargeId: chargeId,
      journalEntryId: entryId,
      dispatchedBy: actor.personId,
      creditOverrideBy,
      creditOverrideReason,
    });

    return {
      orderId: order.id, chargeId, entryId,
      creditOverridden: creditOverrideReason !== null, treatment: 'external',
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Void an order. ⚠️ A dispatched order's receivable is **reversed**, never deleted — `voidCharge`
 * posts the mirror entry, so the ledger keeps both halves of what happened.
 */
export async function voidTradeOrder(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string; reason: string },
): Promise<{ reversedEntryId: string | null }> {
  const run = async (trx: Tx) => {
    const order = await tradeRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`voidTradeOrder: order ${input.orderId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    if (order.status === 'void') throw new Error('voidTradeOrder: this order is already void.');

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidTradeOrder: say why this order is being voided.');

    let reversedEntryId: string | null = null;
    if (order.status === 'dispatched' || order.status === 'received') {
      if (order.arChargeId) {
        // A sale: AR owns the money, so AR unwinds it.
        const { entryId } = await voidCharge(trx, actor, { chargeId: order.arChargeId, reason });
        reversedEntryId = entryId;
      } else {
        // ⭐ An internal transfer raised no receivable, so there is no charge to void — the
        // four-leg entry is reversed directly. ⚠️ reverseEntry, never a delete: the ledger keeps
        // both halves, and the reciprocal pair nets to zero again the honest way.
        if (!order.journalEntryId) {
          throw new Error('voidTradeOrder: order is dispatched but carries no entry — that is a bug.');
        }
        const reversal = await reverseEntry(trx, {
          entryId: order.journalEntryId,
          reason,
          reversedBy: actor.personId,
        });
        reversedEntryId = reversal.reversalEntryId;
      }
    }

    await tradeRepo.markVoided(trx, actor.orgId, order.id, {
      voidedBy: actor.personId,
      voidReason: reason,
    });
    return { reversedEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Who confirmed what actually landed.
 *
 * ⚠️ **For a same-org transfer this posts nothing**, and that is not an omission. The value
 * already moved in ONE entry at dispatch, because both stores are rows in one database (bible
 * landmine #27's fix). Receipt is a recorded fact — goods can arrive short or damaged, and knowing
 * who signed for them is a real control even when no leg follows.
 *
 * ⛔ It becomes a posting when the counterparty is another ORG, whose side cannot be written from
 * here at all. See `docs/tasks/133-inter-entity-trade.md` §4.
 */
export async function receiveTradeOrder(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string },
): Promise<{ receivedAt: Date }> {
  const run = async (trx: Tx) => {
    const order = await tradeRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`receiveTradeOrder: order ${input.orderId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    if (order.status !== 'dispatched') {
      throw new Error(`receiveTradeOrder: order is ${order.status}, not dispatched.`);
    }
    const receivedAt = await tradeRepo.markReceived(trx, actor.orgId, order.id, actor.personId);
    return { receivedAt };
  };
  if (tx) return run(tx);
  return transaction(run);
}
