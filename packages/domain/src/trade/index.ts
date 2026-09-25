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
  commissaryRepo,
  customersRepo,
  itemsRepo,
  journalRepo,
  moneyTransfersRepo,
  stockLedgerRepo,
  stockLocationsRepo,
  transaction,
  tradeRepo,
  type Tx,
} from '@shareat/db';
import { authorize, AuthorizationError, type Actor, type Capability } from '@shareat/auth';
import { parseMoneyInput } from '../shared/money-input';
import { assertFiguresReconcile } from '../shared/reconcile';
import { quantity as parseQuantity } from '../stock/quantity';
import { recordCharge, voidCharge } from '../ar';
import { branchPriceFor } from '../items';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import type { Money } from '@shareat/core/money';
import { confirmReceipt, dispatchOrder, type ReceiptLineInput } from '../commissary/transfer';
import { consume, reverseConsumption } from '../stock/consume';
import { postConsumption } from '../stock/consumption-posting';
import type { ConsumedLine } from '../stock/layers';
import { isPositiveQuantity, quantity, type Quantity } from '../stock/quantity';

/**
 * ⭐ T-172. A BRANCH order has two legitimate actors from two stores — the branch that asked and
 * the commissary that fills it — and some acts are either's (receiving: T-173 invariant 8;
 * withdrawing before anything moved). `authorize()` deliberately throws on the first failing axis
 * and answers for ONE store, so "either store" is tried in turn and the LAST refusal is what the
 * caller sees. ⚠️ Only an `AuthorizationError` moves on to the next attempt — a dead connection or
 * a missing person stays loud, exactly as the credit-override check below treats it.
 */
async function authorizeEither(
  tx: Tx,
  actor: Actor,
  attempts: readonly { capability: Capability; storeId: string }[],
): Promise<void> {
  let refused: AuthorizationError | undefined;
  for (const attempt of attempts) {
    try {
      await authorize(tx, actor, attempt.capability, { storeId: attempt.storeId });
      return;
    } catch (e) {
      if (!(e instanceof AuthorizationError)) throw e;
      refused = e;
    }
  }
  throw refused ?? new AuthorizationError('authorizeEither: nothing to try', attempts[0]!.capability);
}
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../stock/receipt-posting';
import type { StockMovementKind } from '@shareat/db/schema';

/** The account T-132 adds to the chart. Every 4xxx leaf before it was retail. */
export const WHOLESALE_REVENUE_CODE = '4300';

/**
 * ⭐ **RETIRED 2026-09-02 — T-165, the switch.** Until then this file posted the PERIODIC
 * internal-transfer shape itself (`Dr 1250 · Cr 5175` at the seller, `Dr 5170 · Cr 2150` at the
 * buyer, one entry, both stores, at DISPATCH). `dispatchOrder`/`confirmReceipt`
 * (`../commissary/transfer.ts`, T-172/173) were built alongside it and called by nothing — this
 * file now calls them instead: `dispatchTradeOrder`'s internal branch relieves the commissary's
 * real layers into `1340`, and `receiveTradeOrder` is where both stores' books move, keyed to
 * what actually arrived. `5170`/`5175` stay in the chart (ADR-008 §4 / bible row 111 — a
 * franchise dispatch, not built, still needs them) but nothing here posts to them any more; see
 * `commissary/transfer.ts`'s header for where `5175` is load-bearing now (the transfer MARGIN,
 * not the whole value). DEF-125 names why this rewiring was overdue.
 */

/** Decimal noise only, never a business allowance. Same value and reasoning as AP's and AR's. */
const EPSILON = 0.005;

/**
 * `quantity()` (`packages/domain/src/stock/quantity.ts`) is a `numeric(14,3)` value's own choke
 * point, the same relationship `money()` has to `parseMoneyInput` — it throws a raw `TypeError`,
 * never a sentence a cashier can act on. This is that wrapper, local to this file rather than a
 * new shared module: only this file currently needs a readable refusal for a typed quantity.
 */
function parseQuantityInput(raw: string, label: string): string {
  try {
    return parseQuantity(raw);
  } catch {
    throw new Error(`${label} — "${raw}" is not a valid quantity. Use at most three decimal places.`);
  }
}

/**
 * T-328 Contract §4b — the reconciliation check as a pure, exported, directly-callable function,
 * so a fabricated non-finite operand can prove the refusal without going through `createTradeOrder`
 * at all (bible §15.11 — a second layer nothing can test is decoration). `createTradeOrder`'s own
 * guard below delegates to this for the check itself; its richer, figure-quoting message on an
 * ordinary mismatch is unchanged and stays at that call site — a pre-existing regression test
 * (`packages/domain/tests/integration/trade.test.ts`) pins that exact wording, and this function
 * has no access to the goods/fees breakdown needed to reproduce it.
 *
 * T-340 — the finiteness-then-tolerance check itself now lives in `shared/reconcile.ts`'s
 * `assertFiguresReconcile`, shared with `items/index.ts`'s line/header checks; this function is a
 * thin, byte-identical-message wrapper so its name, export and signature never change.
 */
export function assertTradeTotalReconciles(stated: number, computed: number): void {
  assertFiguresReconcile('assertTradeTotalReconciles', stated, computed, EPSILON);
}

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
      const rawRate = draft.rate ?? derived ?? quoted?.rate;
      if (rawRate === undefined || rawRate === null) {
        throw new Error(
          treatment === 'internal'
            ? `createTradeOrder: line ${i + 1} names ${item.name}, and nothing can price it — it ` +
              'has no branch price rule, or no purchase history to base one on. Set a pricing ' +
              'rule, or state a rate on the line.'
            : `createTradeOrder: line ${i + 1} names ${item.name}, and ${customer.name}'s price ` +
              'list does not quote it. Add a rate to the price list, or state one on the line.',
        );
      }
      // T-328 — `rate` and `quantity` each parsed and blamed by their OWN name before they are
      // ever multiplied together. Previously `Number(rate) < 0` / `Number(draft.quantity) <= 0`
      // were each NaN-blind (`NaN < 0` and `NaN <= 0` are both `false`), so a typo in either one
      // survived both guards, and only the DERIVED `lineTotal` below caught it — blaming "line
      // N's total" on whichever box the operator actually mistyped. `rate` is `numeric(14,2)`
      // (packages/db/schema/trade.ts:201), the same shape `parseMoneyInput` enforces; `quantity`
      // is `numeric(14,3)`, a different axis (`parseQuantityInput`, defined above).
      const rate = parseMoneyInput(rawRate, `createTradeOrder: line ${i + 1}'s rate`);
      if (Number(rate) < 0) throw new Error(`createTradeOrder: line ${i + 1} has a negative rate.`);
      const parsedQuantity = parseQuantityInput(draft.quantity, `createTradeOrder: line ${i + 1}'s quantity`);
      if (Number(parsedQuantity) <= 0) {
        throw new Error(`createTradeOrder: line ${i + 1} has a quantity of ${draft.quantity}.`);
      }

      // T-328/DEF-272 — this call now STANDS BETWEEN a non-finite `quantity`/`rate` pair and two
      // `numeric` columns (`trade_order_lines.rate`, `.line_total`): rate and quantity are parsed
      // above, but that parses each FIELD on its own — the PRODUCT of two valid numbers still
      // needs its own finite check before `.toFixed(2)` can turn a stray `Infinity` into a string
      // Postgres would otherwise have to refuse. Do not delete this call as decoration; the two
      // guards above and this one are not redundant with each other.
      const lineTotal = parseMoneyInput(
        (Number(parsedQuantity) * Number(rate)).toFixed(2),
        `createTradeOrder: line ${i + 1}'s total`,
      );
      if (Number(lineTotal) <= 0) {
        throw new Error(`createTradeOrder: line ${i + 1} comes to zero, so it bills nothing.`);
      }
      total += Number(lineTotal);
      lines.push({
        itemId: draft.itemId,
        quantity: parsedQuantity,
        unit: draft.unit?.trim() || quoted?.unit || item.baseUnit,
        rate: Number(rate).toFixed(2),
        lineTotal,
      });
    }

    const deliveryFee = Number(parseMoneyInput(input.deliveryFee ?? '0', 'createTradeOrder: the delivery fee'));
    const otherFees = Number(parseMoneyInput(input.otherFees ?? '0', 'createTradeOrder: other fees'));
    if (deliveryFee < 0 || otherFees < 0) {
      throw new Error('createTradeOrder: a fee cannot be negative.');
    }
    const goodsTotal = total;
    total += deliveryFee + otherFees;

    const totalAmount = total.toFixed(2);
    if (input.totalAmount != null) {
      const statedTotal = Number(parseMoneyInput(input.totalAmount, 'createTradeOrder: the total'));
      // T-328 Contract §4b — delegates to the extracted, independently-testable guard. Its own
      // message (either refusal reason) is not what the operator sees here: this call site keeps
      // its pre-existing, figure-quoting message on an ORDINARY MISMATCH, unchanged (a regression
      // test, packages/domain/tests/integration/trade.test.ts, pins its exact wording, and that
      // test predates this task). `statedTotal`/`total` are both already parsed by this point, so
      // the guard's own finiteness branch cannot fire from here TODAY — proven directly by the
      // unit test instead (T-328 Test 2(b)), which is the whole reason it was extracted (bible
      // §15.11) — but "cannot fire today" is not "will never fire", and a bare `catch` would trust
      // that unreachability forever rather than for now: it would flatten a future finiteness
      // refusal (a parser weakened, a new caller, a third operand) into this mismatch sentence,
      // destroying the exact distinction the tester's two non-overlapping matchers exist to keep.
      // So re-throw anything that is not the ordinary-mismatch case unchanged, rather than
      // assuming every refusal here means the same thing.
      try {
        assertTradeTotalReconciles(statedTotal, total);
      } catch (err) {
        if (!Number.isFinite(statedTotal) || !Number.isFinite(total)) throw err;
        throw new Error(
          `createTradeOrder: the lines come to ₱${goodsTotal.toFixed(2)} plus ₱${(deliveryFee + otherFees).toFixed(2)} ` +
            `of fees, so ₱${totalAmount} — but the order says ₱${input.totalAmount}. One of the two is wrong.`,
        );
      }
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
    // ⭐ T-172. A BRANCH order's dispatch is its own capability — the posting event on the
    // commissary's side, manager+ — and never `approve_buyer`, which is about extending credit to
    // a buyer. A branch is not a buyer.
    if (order.requestedByStoreId) {
      await authorize(trx, actor, 'dispatch_branch_order', { storeId: order.storeId });
    } else {
      await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    }

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
    // ⭐ T-172. A branch order goes out READY or not at all — "ready" is the commissary's statement
    // that the list is final, after the branch has answered every proposal. The trigger (0121)
    // refuses this at the database too; this names the reason.
    if (order.requestedByStoreId && !order.readyAt) {
      throw new Error(
        'dispatchTradeOrder: a branch order is dispatched only after the commissary marks it ready ' +
          `(it is ${order.status === 'draft' ? 'still a draft' : order.acceptedAt ? 'being packed' : 'awaiting acceptance'}).`,
      );
    }

    const customer = await customersRepo.getById(trx, actor.orgId, order.customerId);
    if (!customer) throw new Error('dispatchTradeOrder: the order names a customer that no longer exists.');

    // -----------------------------------------------------------------------------------------
    // ⭐ T-165. The INTERNAL transfer, on the REAL perpetual shape — `dispatchOrder`
    // (`../commissary/transfer.ts`, T-172/173), not the periodic `5170`/`5175`/`1250`/`2150`
    // four-leg entry this branch posted before. That old shape moved COST with no stock ledger
    // effect at all; this one relieves the commissary's actual layers into `1340`, and the
    // cross-store legs post at CONFIRM RECEIPT (`receiveTradeOrder` below), not here — see
    // `commissary/transfer.ts`'s header for why running both would count one transfer twice.
    // ⛔ NO REVENUE: a branch is not a customer of its own company.
    // -----------------------------------------------------------------------------------------
    if (customersRepo.treatmentOf(customer) === 'internal') {
      const allLines = await tradeRepo.linesFor(trx, actor.orgId, order.id);
      if (allLines.length === 0) {
        throw new Error('dispatchTradeOrder: order has no lines — that is a bug, createTradeOrder refuses this.');
      }
      // ⭐ T-172 invariant 5. A line the commissary PROPOSED counts toward nothing until the branch
      // approves it — not the total, not this gate, not the truck — and a rejected one never does.
      // `lineCounts` is the ONE predicate the total, the dispatch and the receipt all read. And a
      // line fulfilled at ZERO ("we couldn't fill this") has nothing to relieve.
      if (allLines.some((l) => l.approval === 'pending')) {
        throw new Error('dispatchTradeOrder: a proposed line still awaits the branch\'s decision.');
      }
      const lines = allLines.filter(
        (l) => tradeRepo.lineCounts(l) && isPositiveQuantity(quantity(l.fulfilledQuantity ?? l.quantity)),
      );
      if (lines.length === 0) {
        throw new Error('dispatchTradeOrder: nothing would be sent — every line is at zero or declined.');
      }
      // ⭐ T-172's `fulfilLine` sets the source room per line since 2026-09-03; a line that has none
      // — every commissary-initiated transfer, and a branch line the packer left at the default —
      // falls back to the store's one default room, the same "optional override, else the obvious
      // default" shape rate capture and unit fallback already use elsewhere in this file.
      const commissaryDefault = await stockLocationsRepo.defaultLocationFor(trx, order.storeId);

      const dispatchLines: {
        lineId: string; itemId: string; itemKind: string; sourceLocationId: string; fulfilledQuantity: Quantity;
      }[] = [];
      const onHandByItem: Record<string, Quantity> = {};
      for (const line of lines) {
        const item = await itemsRepo.getItemById(trx, actor.orgId, line.itemId);
        if (!item) throw new Error('dispatchTradeOrder: a line names an item that no longer exists.');
        const sourceLocationId = line.sourceLocationId ?? commissaryDefault?.id;
        if (!sourceLocationId) {
          throw new Error(
            `dispatchTradeOrder: ${item.name} has no source room, and ${customer.name}'s commissary ` +
              'has no default location either — set one before dispatching.',
          );
        }
        dispatchLines.push({
          lineId: line.id, itemId: line.itemId, itemKind: item.kind, sourceLocationId,
          fulfilledQuantity: quantity(line.fulfilledQuantity ?? line.quantity),
        });
        if (!(line.itemId in onHandByItem)) {
          // ⚠️ An item the commissary has NEVER moved stays ABSENT from the map — that is how
          // `dispatchOrder` tells "untracked" from "zero on hand", and the two get different
          // refusals on purpose (T-172 §9.1: an untracked item is the commissary's data problem).
          const onHand = await stockLedgerRepo.onHandByItemInStore(trx, order.storeId, line.itemId);
          if (onHand !== null) onHandByItem[line.itemId] = quantity(onHand);
        }
      }

      const dispatched = await dispatchOrder(trx, {
        orgId: actor.orgId,
        commissaryStoreId: order.storeId,
        orderId: order.id,
        dispatchedOn: order.orderDate,
        dispatchedBy: actor.personId,
        onHandByItem,
        lines: dispatchLines,
      });
      if (!dispatched.ok) throw new Error(`dispatchTradeOrder: ${dispatched.reason}`);

      // ⭐ Persisted so `receiveTradeOrder` can relieve `1340` at what the goods actually COST,
      // never at `rate` — the mechanism `commissary/transfer.ts`'s header names as load-bearing.
      for (const [lineId, cost] of Object.entries(dispatched.costByLineId)) {
        await tradeRepo.setLineDispatchCost(trx, lineId, cost);
      }

      await tradeRepo.markDispatched(trx, actor.orgId, order.id, {
        arChargeId: null,
        journalEntryId: dispatched.entryId,
        dispatchedBy: actor.personId,
        creditOverrideBy: null,
        creditOverrideReason: null,
      });
      // ⛔ No credit gate. A branch is not extended credit, so a limit on an internal counterparty
      // is meaningless and is deliberately not consulted.
      return { orderId: order.id, chargeId: null, entryId: dispatched.entryId, creditOverridden: false, treatment: 'internal' };
    }

    // ⭐ Bills by calling AR, never by posting its own legs. One owner of the 1210/4200 entry —
    // and DEF-158, the credit-limit gate itself now lives inside `recordCharge`, the one place
    // every AR-charging caller goes through, rather than a copy kept here.
    const { chargeId, entryId, creditOverrideBy, creditOverrideReason } = await recordCharge(trx, actor, {
      storeId: order.storeId,
      customerId: order.customerId,
      chargeDate: order.orderDate,
      totalAmount: order.totalAmount,
      revenueAccountCode: WHOLESALE_REVENUE_CODE,
      referenceNo: order.referenceNo,
      notes: `Wholesale order ${order.referenceNo ?? order.id}`,
      creditOverrideReason: input.creditOverrideReason,
    });

    // ---------------------------------------------------------------------------------------
    // ⭐ T-165 / DEF-125. COGS and inventory relief — T-132's own header called this a "stated
    // omission" back when no inventory module existed; Phase 3 shipped one and this dispatch
    // never gained the leg that goes with it, so every wholesale sale silently overstated its
    // margin. Posted as its OWN entry, the same separation `postConsumption`/`recordCharge`
    // already keep everywhere else — one document for the sale, a second for what it cost.
    // ⚠️ `cogsCategory` has no per-item source of truth anywhere in the schema yet (T-164's own
    // callers take it as a caller-supplied field with nothing behind it either) — every line
    // here books through the `food` catch-all COA-ALIGNMENT §4.1 names for exactly this case,
    // flagged rather than invented as a real classification.
    // ---------------------------------------------------------------------------------------
    const sellingLocation = await stockLocationsRepo.defaultLocationFor(trx, order.storeId);
    if (!sellingLocation) {
      throw new Error(`dispatchTradeOrder: ${order.storeId} has no default stock location to sell from.`);
    }
    const soldLines = await tradeRepo.linesFor(trx, actor.orgId, order.id);

    // ⭐ EVERY refusal decided before the first write — the T-166 lesson, applied here exactly as
    // `dispatchOrder` applies it for the internal path. Validating inside the write loop leaves
    // line 1's stock moved when line 2 is the one with no inventory account.
    const cogsLines: { itemId: string; quantity: Quantity; inventoryAccount: string }[] = [];
    for (const line of soldLines) {
      const item = await itemsRepo.getItemById(trx, actor.orgId, line.itemId);
      if (!item) throw new Error('dispatchTradeOrder: a line names an item that no longer exists.');
      const inventoryAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
      if (!inventoryAccount) {
        throw new Error(`dispatchTradeOrder: item kind "${item.kind}" has no inventory account in COA-ALIGNMENT §4.1.`);
      }
      cogsLines.push({ itemId: line.itemId, quantity: quantity(line.quantity), inventoryAccount });
    }

    const cogsGroups = new Map<string, { inventoryAccount: string; lines: ConsumedLine[] }>();
    for (const line of cogsLines) {
      const consumed = await consume(trx, {
        orgId: actor.orgId, storeId: order.storeId, locationId: sellingLocation.id,
        itemId: line.itemId, quantity: line.quantity,
        movedAt: new Date(`${order.orderDate}T00:00:00Z`),
        kind: 'usage', sourceType: 'trade_order_dispatch', sourceId: order.id,
        createdBy: actor.personId,
      });
      // ⛔ Validated above, so a refusal here is a real shortfall, not a data problem — thrown
      // rather than returned, since the AR charge above has already posted (T-166 §7.2).
      if (!consumed.ok) throw new Error(`dispatchTradeOrder: posting refused after billing — ${consumed.reason}`);
      const group = cogsGroups.get(line.inventoryAccount);
      if (group) group.lines.push(...consumed.lines);
      else cogsGroups.set(line.inventoryAccount, { inventoryAccount: line.inventoryAccount, lines: [...consumed.lines] });
    }
    for (const [inventoryAccount, group] of cogsGroups) {
      const posted = await postConsumption(trx, {
        orgId: actor.orgId, storeId: order.storeId, inventoryAccount,
        movedOn: order.orderDate, sourceType: 'trade_order_dispatch',
        sourceId: `${order.id}:${inventoryAccount}`, costLines: group.lines,
        cogsCategory: 'food', postedBy: actor.personId,
      });
      // ⛔ Stock is already written. Throw so the transaction unwinds — T-166 §7.2's lesson.
      if (!posted.ok) throw new Error(`dispatchTradeOrder: posting refused after stock moved — ${posted.reason}`);
    }

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

/** `-3.500` → `3.500`. `Quantity` carries no arithmetic of its own — this is string trimming. */
function absQuantity(q: string): Quantity {
  return (q.startsWith('-') ? q.slice(1) : q) as Quantity;
}

/**
 * ⭐ T-165. Give back whatever a dispatch moved — the stock, either treatment, and (for an
 * EXTERNAL sale only) the COGS entries that came with it; an internal transfer's ONE entry is
 * already reversed by `voidTradeOrder` itself just above this call. ⚠️ Movements are found BY
 * SOURCE, not remembered on the order line — `stock_movements_source_pair_key` guarantees at
 * most one non-reversed movement per (item, location), so this is safe rather than a workaround.
 */
async function reverseDispatchStock(
  tx: Tx,
  actor: Actor,
  order: { id: string },
  reason: string,
): Promise<void> {
  const movements = await stockLedgerRepo.movementsBySource(tx, 'trade_order_dispatch', order.id);
  const cogsAccounts = new Set<string>();

  for (const m of movements) {
    const original = await stockLedgerRepo.findMovement(tx, m.id);
    if (!original) continue;

    const reversed = await reverseConsumption(tx, {
      orgId: actor.orgId, storeId: m.storeId, locationId: m.locationId, itemId: m.itemId,
      originalMovementId: m.id, quantity: absQuantity(original.quantity), movedAt: new Date(),
      kind: original.kind as StockMovementKind,
      sourceType: 'trade_order_dispatch_void', sourceId: order.id, createdBy: actor.personId,
    });
    if (!reversed.ok) throw new Error(`voidTradeOrder: ${reversed.reason}`);

    if (original.kind === 'usage') {
      const item = await itemsRepo.getItemById(tx, actor.orgId, m.itemId);
      const account = item && INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
      if (account) cogsAccounts.add(account);
    }
  }

  // ⭐ Reconstructed, not stored: the same deterministic (item kind → account) map the dispatch
  // used to key the entry, so the same key finds it again.
  for (const account of cogsAccounts) {
    const entry = await journalRepo.findEntryByIdempotencyKey(
      tx, actor.orgId, `trade_order_dispatch:${order.id}:${account}:consumption`,
    );
    if (!entry) continue;
    await reverseEntry(tx, { entryId: entry.id, reason, reversedBy: actor.personId });
  }
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
    if (order.requestedByStoreId) {
      // ⭐ T-172. Before anything moved, EITHER side may withdraw — the branch its own request, the
      // commissary an order it will not fill (rejectOrder is the same act with a reason column).
      // After dispatch it reverses a posting, which is the dispatcher's capability, manager+.
      if (order.status === 'dispatched' || order.status === 'received') {
        await authorize(trx, actor, 'dispatch_branch_order', { storeId: order.storeId });
      } else {
        await authorizeEither(trx, actor, [
          { capability: 'place_branch_order', storeId: order.requestedByStoreId },
          { capability: 'fulfil_branch_order', storeId: order.storeId },
        ]);
      }
    } else {
      await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    }
    if (order.status === 'void') throw new Error('voidTradeOrder: this order is already void.');

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidTradeOrder: say why this order is being voided.');

    // ⭐ T-165. Voiding an already-RECEIVED internal transfer needs a real reverse-transfer —
    // BOTH stores' layers unwound, T-174's discrepancy rows accounted for — which is a
    // materially bigger problem than this task, reported rather than attempted blind. Voiding
    // before receipt (the common case — an order dispatched in error) is single-store and safe,
    // and is what this function builds.
    if (order.status === 'received' && !order.arChargeId) {
      throw new Error(
        'voidTradeOrder: this internal transfer has already been received at the other store — ' +
          'voiding it needs a two-store reverse-transfer that is not built yet. Correct it with a ' +
          'new transfer the other way instead.',
      );
    }

    let reversedEntryId: string | null = null;
    if (order.status === 'dispatched' || order.status === 'received') {
      if (order.arChargeId) {
        // A sale: AR owns the money, so AR unwinds it.
        const { entryId } = await voidCharge(trx, actor, { chargeId: order.arChargeId, reason });
        reversedEntryId = entryId;

        // ⭐ T-165/DEF-125. `voidCharge` only unwinds the revenue/AR leg — give the goods and the
        // COGS entry back too, or a voided sale permanently loses the stock it never delivered.
        await reverseDispatchStock(trx, actor, order, reason);
      } else {
        // ⭐ T-165. The internal dispatch's `1340`/inventory entry, reversed directly — ⚠️
        // reverseEntry, never a delete: the ledger keeps both halves, and the reciprocal pair
        // nets to zero again the honest way.
        if (!order.journalEntryId) {
          throw new Error('voidTradeOrder: order is dispatched but carries no entry — that is a bug.');
        }
        const reversal = await reverseEntry(trx, {
          entryId: order.journalEntryId,
          reason,
          reversedBy: actor.personId,
        });
        reversedEntryId = reversal.reversalEntryId;
        await reverseDispatchStock(trx, actor, order, reason);
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
export interface ReceiveTradeOrderLineInput {
  readonly lineId: string;
  /** Omit for a full receipt — what was dispatched. T-174's short-receipt input. */
  readonly receivedQuantity?: string | null;
  readonly shortageReason?: ReceiptLineInput['shortageReason'];
}

export interface ReceiveTradeOrderInput {
  readonly orderId: string;
  readonly lines?: readonly ReceiveTradeOrderLineInput[];
  /** YYYY-MM-DD. Defaults to today — this is a real-time signing event, not backdated. */
  readonly receivedOn?: string;
}

export interface ReceiveTradeOrderResult {
  readonly receivedAt: Date;
  /** `null` for an EXTERNAL order (nothing posts here) or an all-ledger-only internal receipt. */
  readonly entryId: string | null;
}

/**
 * ⭐ T-165/T-173. For an INTERNAL transfer this is now the one event where BOTH stores' books
 * move — `confirmReceipt`, keyed to what was actually received, never to what was dispatched
 * (`commissary/transfer.ts`'s header rule). For an EXTERNAL sale this still posts nothing: the
 * value moved at dispatch, and receipt is a recorded fact about who signed for it.
 */
export async function receiveTradeOrder(
  tx: Tx | null,
  actor: Actor,
  input: ReceiveTradeOrderInput,
): Promise<ReceiveTradeOrderResult> {
  const run = async (trx: Tx): Promise<ReceiveTradeOrderResult> => {
    const order = await tradeRepo.getOrderById(trx, actor.orgId, input.orderId);
    if (!order) throw new Error(`receiveTradeOrder: order ${input.orderId} does not exist.`);
    if (order.requestedByStoreId) {
      // ⭐ T-173 invariant 8, finally wired: BOTH stores are legitimate callers of a branch order's
      // receipt, from opposite grants — the branch cook who signs for the crates, or the commissary
      // side on the branch's behalf. `confirm_receipt` is staff-open precisely because the real
      // control is this two-sided store check, not the role (CAPABILITY-MATRIX.md).
      await authorizeEither(trx, actor, [
        { capability: 'confirm_receipt', storeId: order.requestedByStoreId },
        { capability: 'confirm_receipt', storeId: order.storeId },
      ]);
    } else {
      await authorize(trx, actor, 'approve_buyer', { storeId: order.storeId });
    }
    if (order.status !== 'dispatched') {
      throw new Error(`receiveTradeOrder: order is ${order.status}, not dispatched.`);
    }

    const customer = await customersRepo.getById(trx, actor.orgId, order.customerId);
    if (!customer) throw new Error('receiveTradeOrder: the order names a customer that no longer exists.');

    let entryId: string | null = null;

    if (customersRepo.treatmentOf(customer) === 'internal') {
      const branchStoreId = customer.counterpartyStoreId!;
      const receivedOn = input.receivedOn ?? new Date().toISOString().slice(0, 10);
      const orderLines = await tradeRepo.linesFor(trx, actor.orgId, order.id);
      const overrides = new Map((input.lines ?? []).map((l) => [l.lineId, l]));
      const codes = await moneyTransfersRepo.storeCodes(trx, actor.orgId, [order.storeId, branchStoreId]);
      const commissaryStoreCode = codes.get(order.storeId);
      const branchStoreCode = codes.get(branchStoreId);
      if (!commissaryStoreCode || !branchStoreCode) {
        throw new Error('receiveTradeOrder: could not resolve both store codes for the receipt.');
      }
      const branchLocation = await stockLocationsRepo.defaultLocationFor(trx, branchStoreId);

      const receiptLines: ReceiptLineInput[] = [];
      const orderLineIdByLineId: Record<string, string> = {};
      for (const line of orderLines) {
        // ⭐ T-172. A declined proposal never arrives, and a line fulfilled at zero was never packed
        // — neither was dispatched, neither carries a dispatch cost, neither is received. The same
        // `lineCounts` predicate the dispatch used decides it here.
        if (!tradeRepo.lineCounts(line)) continue;
        const dispatchedQuantity = quantity(line.fulfilledQuantity ?? line.quantity);
        if (!isPositiveQuantity(dispatchedQuantity)) continue;

        const item = await itemsRepo.getItemById(trx, actor.orgId, line.itemId);
        if (!item) throw new Error('receiveTradeOrder: a line names an item that no longer exists.');

        // ⭐ T-172 invariant 12. A BRANCH order captured its ledger-only decision onto the line at
        // submit (or at approval), and THAT is what the receipt honours — a map edited while the
        // goods were on the truck does not reach it. A commissary-initiated transfer has no
        // capture, so the map decides.
        if (order.requestedByStoreId && line.isLedgerOnly) continue;

        // ⭐ T-171. Required — commissary_item_map.branch_item_id is NOT NULL by design (the
        // schema's own comment: an overloaded null cannot tell "unmapped" from "deliberately
        // ledger-only"), so a missing row is refused rather than guessed at receipt time.
        const map = await commissaryRepo.mapItem(trx, order.storeId, branchStoreId, line.itemId);
        if (!map) {
          throw new Error(
            `receiveTradeOrder: ${item.name} has no commissary_item_map row for this store pair — ` +
              'map it (T-171) before confirming receipt.',
          );
        }
        if (!order.requestedByStoreId && map.isLedgerOnly) continue;

        const branchItem = await itemsRepo.getItemById(trx, actor.orgId, map.branchItemId);
        if (!branchItem) throw new Error('receiveTradeOrder: the mapped branch item no longer exists.');
        if (!line.dispatchCost) {
          throw new Error(`receiveTradeOrder: ${item.name} carries no dispatch cost — that is a bug.`);
        }
        if (!branchLocation) {
          throw new Error(`receiveTradeOrder: the branch has no default location to receive into.`);
        }

        const override = overrides.get(line.id);
        const receivedQuantity =
          override?.receivedQuantity != null ? quantity(override.receivedQuantity) : dispatchedQuantity;

        receiptLines.push({
          lineId: line.id,
          itemId: line.itemId,
          branchItemId: map.branchItemId,
          branchLocationId: branchLocation.id,
          dispatchedQuantity,
          receivedQuantity,
          branchBaseUnit: branchItem.baseUnit,
          commissaryBaseUnit: item.baseUnit,
          rate: line.rate,
          dispatchCost: line.dispatchCost as Money,
          branchItemKind: branchItem.kind,
          shortageReason: override?.shortageReason ?? null,
        });
        orderLineIdByLineId[line.id] = line.id;
        await tradeRepo.setLineReceivedQuantity(trx, line.id, receivedQuantity);
      }

      if (receiptLines.length > 0) {
        const confirmed = await confirmReceipt(trx, {
          orgId: actor.orgId,
          commissaryStoreId: order.storeId,
          branchStoreId,
          commissaryStoreCode,
          branchStoreCode,
          orderId: order.id,
          receivedOn,
          lines: receiptLines,
          receivedBy: actor.personId,
          orderLineIdByLineId,
        });
        if (!confirmed.ok) throw new Error(`receiveTradeOrder: ${confirmed.reason}`);
        entryId = confirmed.entryId;
      }
    }

    const receivedAt = await tradeRepo.markReceived(trx, actor.orgId, order.id, actor.personId);
    return { receivedAt, entryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}
