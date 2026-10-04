/**
 * Customer returns — T-179, bible row 166. Sibling of T-170 (`../stock/supplier-returns.ts`),
 * same shape pointing the other way.
 *
 * ⭐ **Not symmetric with a supplier return, and the asymmetry is named, not hidden.** We
 * recognised revenue on the way out and did not on the way in — so this reverses THREE things
 * where T-170 reverses two: revenue (`4950`), cost (`5xxx`/inventory), and stock.
 *
 * ## `treatment` — DERIVED (ADR-008 §8), same fact `dispatchTradeOrder` already decides
 *
 * `external`/`franchise` reverses the SALE's own consumption via `reverseConsumption` — T-162
 * invariant 7's exact-layers-back rule, unchanged from what T-179's own spec names. `internal`
 * posts T-173 backwards in ONE entry: the branch's own layer (created at receipt) is consumed
 * fresh, and the commissary gets a new layer back — there is no PRIOR consumption to reverse for
 * a branch that never used what it received, so this is `consume()` + `createLayer()`, not
 * `reverseConsumption`.
 *
 * ## Two extensions the "received" concept needed, both named
 *
 * `trade_order_lines.received_quantity` is only ever set for an INTERNAL order (T-165's
 * `receiveTradeOrder` → `confirmReceipt`) — an external sale has no separate per-line receiving
 * step from our side; the wholesale customer's own receiving is outside this system. So
 * `returnableQuantity` caps an internal line at `receivedQuantity` and an external line at
 * `fulfilledQuantity`/`quantity` (what was actually sold) — reported here, not silently assumed.
 */
import {
  arRepo,
  commissaryRepo,
  customerReturnsRepo,
  customersRepo,
  itemsRepo,
  journalRepo,
  moneyAccountsRepo,
  moneyTransfersRepo,
  stockLayersRepo,
  stockLedgerRepo,
  stockLocationsRepo,
  tradeRepo,
  transaction,
  type Tx,
} from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import type {
  CustomerReturnSettlement,
  CustomerReturnTreatment,
  StockMovementKind,
} from '@shareat/db/schema';
import { add, compare, decimal, money, multiply, subtract, ZERO, type Money } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import { perBaseUnit } from '../deliveries/receive';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { consume, reverseConsumption } from '../stock/consume';
import { postWastage } from '../stock/consumption-posting';
import type { ConsumedLine } from '../stock/layers';
import { compareQuantity, isPositiveQuantity, quantity, subtractQuantity, type Quantity } from '../stock/quantity';
import { recordCollection } from '../ar';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../stock/receipt-posting';
import { closedStockPeriodSentence, closedStockPeriodSentenceToday } from '../stock/period-guard';

export const RETURN_REVENUE_CODE = '4950';
export const CUSTOMER_RETURN_UNSELLABLE_REASON = 'customer_return_unsellable' as const;

interface ReturnLineRecord {
  readonly lineNo: string;
  readonly tradeOrderLineId: string;
  readonly quantity: Quantity;
  readonly saleable: boolean;
  readonly amount: Money;
  readonly cost: Money;
  readonly itemId: string;
  readonly movementId: string;
}

// -----------------------------------------------------------------------------------------
// returnableQuantity — invariant 1's cap
// -----------------------------------------------------------------------------------------

async function loadOrderContext(tx: Tx, orgId: string, tradeOrderId: string) {
  const order = await tradeRepo.getOrderById(tx, orgId, tradeOrderId);
  if (!order) return null;
  const customer = await customersRepo.getById(tx, orgId, order.customerId);
  if (!customer) return null;
  const treatment = customersRepo.treatmentOf(customer);
  return { order, customer, treatment };
}

async function returnableCap(
  tx: Tx,
  orderLine: { id: string; quantity: string; fulfilledQuantity: string | null; receivedQuantity: string | null },
  treatment: CustomerReturnTreatment,
): Promise<Quantity> {
  const basis =
    treatment === 'internal'
      ? quantity(orderLine.receivedQuantity ?? '0')
      : quantity(orderLine.fulfilledQuantity ?? orderLine.quantity);
  const already = quantity(await customerReturnsRepo.returnedQuantityForOrderLine(tx, orderLine.id));
  const remaining = subtractQuantity(basis, already);
  return isPositiveQuantity(remaining) ? remaining : quantity('0');
}

/**
 * Contract: `returnableQuantity(tradeOrderLineId)`. Resolves treatment from the line's own order.
 * ⚠️ Named `customerReturnableQuantity` — T-170's own `returnableQuantity` (supplier returns,
 * against a delivery line) already claims the shorter name in this package's barrel.
 */
export async function customerReturnableQuantity(tx: Tx, orgId: string, tradeOrderLineId: string): Promise<Quantity> {
  const orderLine = await tradeRepo.getLineById(tx, orgId, tradeOrderLineId);
  if (!orderLine) return quantity('0');
  const ctx = await loadOrderContext(tx, orgId, orderLine.orderId);
  if (!ctx) return quantity('0');
  return returnableCap(tx, orderLine, ctx.treatment);
}

/** Contract: `customerCreditBalance(customerId)` — derived from `2140`, never stored (DEF-075). */
export async function customerCreditBalance(tx: Tx, orgId: string, customerId: string): Promise<Money> {
  // T-371 R4 — a database figure is re-minted, never cast.
  return money(await arRepo.creditBalanceOf(tx, orgId, customerId));
}

// -----------------------------------------------------------------------------------------
// recordCustomerReturn
// -----------------------------------------------------------------------------------------

export interface RecordCustomerReturnLineInput {
  readonly tradeOrderLineId: string;
  readonly quantity: string;
  /** Default true. false -> the goods reopen their layer and are then wasted (§5). */
  readonly saleable?: boolean;
}

export interface RecordCustomerReturnInput {
  /** ⛔ NO `orgId`. T-231/DEF-210: derived from `actor` at the entry point. */
  readonly tradeOrderId: string;
  readonly returnedOn: string;
  readonly reason: string;
  readonly lines: readonly RecordCustomerReturnLineInput[];
  /** The one human choice (§3) — cash now instead of the default reduce_ar/store_credit split. */
  readonly refund?: boolean;
  readonly moneyAccountId?: string | null;
  readonly actor: Actor;
}

export interface RecordCustomerReturnResult {
  readonly ok: true;
  readonly returnId: string;
  readonly journalEntryId: string;
  readonly settlement: CustomerReturnSettlement;
}
export type RecordCustomerReturnOutcome = RecordCustomerReturnResult | { readonly ok: false; readonly reason: string };

type TradeOrderLineRow = NonNullable<Awaited<ReturnType<typeof tradeRepo.getLineById>>>;
type TradeOrderRow = NonNullable<Awaited<ReturnType<typeof tradeRepo.getOrderById>>>;
type CustomerRow = NonNullable<Awaited<ReturnType<typeof customersRepo.getById>>>;

interface PreparedLine {
  readonly orderLine: TradeOrderLineRow;
  readonly quantity: Quantity;
  readonly saleable: boolean;
}

/**
 * ⛔ Internal only. The org is DERIVED from the actor at the entry point (T-231/DEF-210) and then
 * threaded to the two posting helpers unchanged — which is why they keep an `orgId` and the public
 * input does not. A caller must not be able to name a tenant; these helpers are not callable.
 */
type ScopedReturnInput = RecordCustomerReturnInput & { readonly orgId: string };

export async function recordCustomerReturn(
  tx: Tx | null,
  publicInput: RecordCustomerReturnInput,
): Promise<RecordCustomerReturnOutcome> {
  const input: ScopedReturnInput = { ...publicInput, orgId: publicInput.actor.orgId };
  const run = async (trx: Tx): Promise<RecordCustomerReturnOutcome> => {
    const order = await tradeRepo.getOrderById(trx, input.orgId, input.tradeOrderId);
    if (!order) return { ok: false, reason: `trade order ${input.tradeOrderId} does not exist.` };
    await authorize(trx, input.actor, 'record_customer_return', { storeId: order.storeId });
    const closed = await closedStockPeriodSentence(trx, input.orgId, input.returnedOn, 'returned');
    if (closed) return { ok: false, reason: closed };

    const customer = await customersRepo.getById(trx, input.orgId, order.customerId);
    if (!customer) return { ok: false, reason: 'the order names a customer that no longer exists.' };
    const treatment = customersRepo.treatmentOf(customer);
    if (treatment === 'inter_entity') {
      return {
        ok: false,
        reason:
          `${customer.name} belongs to another organisation — their side of this return cannot ` +
          'be posted from here. See docs/tasks/133-inter-entity-trade.md §4.',
      };
    }

    if (treatment === 'internal') {
      if (order.status !== 'received') {
        return { ok: false, reason: 'this internal transfer has not been received at the branch yet.' };
      }
    } else if (order.status !== 'dispatched' && order.status !== 'received') {
      return { ok: false, reason: `order is ${order.status}, so nothing has shipped to return.` };
    }

    const reason = input.reason.trim();
    if (!reason) return { ok: false, reason: 'say why the goods are coming back.' };
    if (input.lines.length === 0) return { ok: false, reason: 'a return with no lines is nothing.' };

    // ⭐ EVERY refusal decided before the first write — the T-166 lesson.
    const prepared: PreparedLine[] = [];
    for (const l of input.lines) {
      const orderLine = await tradeRepo.getLineById(trx, input.orgId, l.tradeOrderLineId);
      if (!orderLine || orderLine.orderId !== order.id) {
        return { ok: false, reason: `line ${l.tradeOrderLineId} does not belong to this order.` };
      }
      const cap = await returnableCap(trx, orderLine, treatment);
      const qty = quantity(l.quantity);
      if (!isPositiveQuantity(qty)) return { ok: false, reason: 'a return line must be a positive quantity.' };
      if (compareQuantity(qty, cap) > 0) {
        return { ok: false, reason: `only ${cap} of this line is left to return.` };
      }
      prepared.push({ orderLine, quantity: qty, saleable: l.saleable ?? true });
    }

    if (treatment === 'internal') {
      if (prepared.some((p) => !p.saleable)) {
        return { ok: false, reason: 'an internal transfer has no wastage concept — return it, then waste it at the branch separately if it is bad.' };
      }
      return recordInternalReturn(trx, input, order, customer, prepared);
    }
    return recordExternalReturn(trx, input, order, customer, prepared);
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -----------------------------------------------------------------------------------------
// External / franchise — §3
// -----------------------------------------------------------------------------------------

async function recordExternalReturn(
  tx: Tx,
  input: ScopedReturnInput,
  order: TradeOrderRow,
  customer: CustomerRow,
  prepared: readonly PreparedLine[],
): Promise<RecordCustomerReturnOutcome> {
  if (!order.arChargeId) {
    return { ok: false, reason: 'this order raised no receivable — that is a bug for an external sale.' };
  }

  const movements = await stockLedgerRepo.movementsBySource(tx, 'trade_order_dispatch', order.id);
  const returnId = await customerReturnsRepo.nextReturnId(tx);
  const movedAt = new Date(`${input.returnedOn}T00:00:00Z`);

  const lineInputs: ReturnLineRecord[] = [];
  const cogsGroups = new Map<string, { inventoryAccount: string; lines: ConsumedLine[] }>();
  const wastageGroups = new Map<string, { inventoryAccount: string; lines: ConsumedLine[] }>();
  let totalAmount: Money = ZERO;
  let lineNo = 0;

  for (const p of prepared) {
    lineNo += 1;
    const item = await itemsRepo.getItemById(tx, input.orgId, p.orderLine.itemId);
    if (!item) return { ok: false, reason: 'a line names an item that no longer exists.' };
    const inventoryAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
    if (!inventoryAccount) {
      return { ok: false, reason: `item kind "${item.kind}" has no inventory account in COA-ALIGNMENT §4.1.` };
    }
    const original = movements.find((m) => m.itemId === p.orderLine.itemId);
    if (!original) {
      return { ok: false, reason: `no dispatch movement found for ${item.name} on this order — that is a bug.` };
    }

    // ⭐ Invariant 4 — the rate CAPTURED on the order line, never today's price list.
    // T-371 — exact (scaled bigint, half-up once at the centavo), never a float product.
    const amount = multiply(money(p.orderLine.rate), p.quantity);
    totalAmount = add(totalAmount, amount);

    // ⭐ Invariant 5/6 — the exact layers the sale relieved, reversed in reverse order of
    // consumption. Already built for exactly this call (T-162's own doc comment on
    // outstandingConsumptions names T-179 by number).
    const reversed = await reverseConsumption(tx, {
      orgId: input.orgId, storeId: order.storeId, locationId: original.locationId, itemId: p.orderLine.itemId,
      originalMovementId: original.id, quantity: p.quantity, movedAt,
      kind: 'usage', sourceType: 'customer_return', sourceId: returnId, createdBy: input.actor.personId,
    });
    if (!reversed.ok) return reversed;

    lineInputs.push({
      lineNo: String(lineNo), tradeOrderLineId: p.orderLine.id, quantity: p.quantity, saleable: p.saleable,
      amount, cost: reversed.totalCost, itemId: p.orderLine.itemId, movementId: reversed.movementId,
    });

    const group = cogsGroups.get(inventoryAccount);
    if (group) group.lines.push(...reversed.lines);
    else cogsGroups.set(inventoryAccount, { inventoryAccount, lines: [...reversed.lines] });

    if (!p.saleable) {
      // ⭐ §5 — NOT a bespoke posting. Reverse normally (above), then waste the same quantity —
      // two events, because two things happened. FIFO naturally picks the reopened layer back up
      // first (it resumed its ORIGINAL, older position), so a plain consume() is correct here.
      // ⚠️ A DIFFERENT sourceType, not a suffixed sourceId — `stock_movements.source_id` is
      // `uuid`, unlike `journal_entries.source_id` (text), so it cannot carry a compound key.
      const rewasted = await consume(tx, {
        orgId: input.orgId, storeId: order.storeId, locationId: original.locationId, itemId: p.orderLine.itemId,
        quantity: p.quantity, movedAt, kind: 'wastage',
        sourceType: 'customer_return_unsellable', sourceId: returnId, createdBy: input.actor.personId,
      });
      if (!rewasted.ok) return rewasted;
      const wgroup = wastageGroups.get(inventoryAccount);
      if (wgroup) wgroup.lines.push(...rewasted.lines);
      else wastageGroups.set(inventoryAccount, { inventoryAccount, lines: [...rewasted.lines] });
    }
  }

  // ---- Settlement — §3's table, invariant 9's split ---------------------------------------
  const creditLines: PostEntryLine[] = [];
  let settlement: CustomerReturnSettlement;

  if (input.refund) {
    if (!input.moneyAccountId) return { ok: false, reason: 'a cash refund needs a money account.' };
    const account = await moneyAccountsRepo.getById(tx, input.orgId, input.moneyAccountId);
    if (!account) return { ok: false, reason: 'that money account does not exist.' };
    settlement = 'cash_refund';
    creditLines.push({
      accountCode: account.glAccountCode, storeId: order.storeId, credit: totalAmount,
      ...(account.glAccountCode === '1140' ? { partyType: 'money_account' as const, partyId: account.id } : {}),
      lineMemo: `Return refunded — ${customer.name}`,
    });
  } else {
    // T-371 C4 — the split is decided in scaled bigint on minted figures, never as floats.
    const outstanding = money(await arRepo.outstandingForCharge(tx, input.orgId, order.arChargeId));
    const reduceAr = compare(totalAmount, outstanding) <= 0 ? totalAmount : outstanding;
    const storeCredit = subtract(totalAmount, reduceAr);
    const reducesAr = compare(reduceAr, ZERO) > 0;
    const leavesCredit = compare(storeCredit, ZERO) > 0;
    if (reducesAr) {
      creditLines.push({
        accountCode: arRepo.AR_CONTROL_CODE, storeId: order.storeId, credit: reduceAr,
        partyType: 'customer' as const, partyId: order.customerId, lineMemo: `Return — ${customer.name}`,
      });
    }
    if (leavesCredit) {
      creditLines.push({
        accountCode: arRepo.STORE_CREDIT_CODE, storeId: order.storeId, credit: storeCredit,
        partyType: 'customer' as const, partyId: order.customerId, lineMemo: `Return credit — ${customer.name}`,
      });
    }
    settlement = reducesAr && leavesCredit ? 'mixed' : leavesCredit ? 'store_credit' : 'reduce_ar';
  }

  const totalCost = add(...[...cogsGroups.values()].flatMap((g) => g.lines.map((l) => l.cost)));

  // ⭐ §3, ONE entry: revenue reversal, settlement, and cost reversal together — never split,
  // never by debiting 4300 directly (invariant 3).
  const lines: PostEntryLine[] = [
    { accountCode: RETURN_REVENUE_CODE, storeId: order.storeId, debit: totalAmount, lineMemo: `Return — ${customer.name}` },
    ...creditLines,
    ...[...cogsGroups.values()].map((g) => ({
      accountCode: g.inventoryAccount, storeId: order.storeId,
      debit: add(...g.lines.map((l) => l.cost)),
      lineMemo: `Return — inventory reopened`,
    })),
    // ⚠️ All lines here booked 'food' at dispatch (T-165 — no per-item COGS category exists
    // yet), so the reversal targets the same single account, summed once.
    { accountCode: '5100', storeId: order.storeId, credit: totalCost, lineMemo: `Return — cost reversed` },
  ];

  const posted = await postEntry(tx, {
    orgId: input.orgId, entryDate: input.returnedOn, sourceType: 'customer_return', sourceId: returnId,
    idempotencyKey: `customer_return:${returnId}:post`, memo: `Customer return — ${customer.name}`,
    postedBy: input.actor.personId, lines,
  });

  for (const [key, group] of wastageGroups) {
    const posted2 = await postWastage(tx, {
      orgId: input.orgId, storeId: order.storeId, inventoryAccount: group.inventoryAccount,
      movedOn: input.returnedOn, sourceType: 'customer_return', sourceId: `${returnId}:${key}:unsellable`,
      costLines: group.lines, reason: CUSTOMER_RETURN_UNSELLABLE_REASON, postedBy: input.actor.personId,
    });
    if (!posted2.ok) throw new Error(`recordCustomerReturn: wastage posting refused after stock moved — ${posted2.reason}`);
  }

  await customerReturnsRepo.createReturn(tx, {
    id: returnId, orgId: input.orgId, storeId: order.storeId, tradeOrderId: order.id, customerId: order.customerId,
    treatment: 'external', returnedOn: input.returnedOn, reason: input.reason.trim(), settlement,
    journalEntryId: posted.entryId, createdBy: input.actor.personId, lines: lineInputs,
  });

  return { ok: true, returnId, journalEntryId: posted.entryId, settlement };
}

// -----------------------------------------------------------------------------------------
// Internal — §4, T-173 backwards, ONE entry
// -----------------------------------------------------------------------------------------

async function recordInternalReturn(
  tx: Tx,
  input: ScopedReturnInput,
  order: TradeOrderRow,
  customer: CustomerRow,
  prepared: readonly PreparedLine[],
): Promise<RecordCustomerReturnOutcome> {
  const branchStoreId = customer.counterpartyStoreId!;
  const commissaryStoreId = order.storeId;
  const branchLocation = await stockLocationsRepo.defaultLocationFor(tx, branchStoreId);
  const commissaryLocation = await stockLocationsRepo.defaultLocationFor(tx, commissaryStoreId);
  if (!branchLocation || !commissaryLocation) {
    return { ok: false, reason: 'both stores need a default stock location for an internal return.' };
  }
  const codes = await moneyTransfersRepo.storeCodes(tx, input.orgId, [commissaryStoreId, branchStoreId]);
  const commissaryCode = codes.get(commissaryStoreId);
  const branchCode = codes.get(branchStoreId);
  if (!commissaryCode || !branchCode) {
    return { ok: false, reason: 'could not resolve both store codes for the return.' };
  }

  const returnId = await customerReturnsRepo.nextReturnId(tx);
  const movedAt = new Date(`${input.returnedOn}T00:00:00Z`);

  const lineInputs: ReturnLineRecord[] = [];
  const branchGroups = new Map<string, { inventoryAccount: string; amount: string }>();
  const commissaryGroups = new Map<string, { inventoryAccount: string; amount: string }>();
  let totalValue: Money = ZERO;
  let lineNo = 0;

  for (const p of prepared) {
    lineNo += 1;
    const item = await itemsRepo.getItemById(tx, input.orgId, p.orderLine.itemId);
    if (!item) return { ok: false, reason: 'a line names an item that no longer exists.' };

    // ⭐ T-171 — the mapped branch item is what the branch's own layer is actually keyed to.
    const map = await commissaryRepo.mapItem(tx, commissaryStoreId, branchStoreId, item.id);
    const branchItemId = map?.branchItemId ?? item.id;
    const branchItem = map ? await itemsRepo.getItemById(tx, input.orgId, branchItemId) : item;
    if (!branchItem) return { ok: false, reason: 'the mapped branch item no longer exists.' };
    const branchAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[branchItem.kind];
    const commissaryAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
    if (!branchAccount || !commissaryAccount) {
      return { ok: false, reason: `item kind has no inventory account in COA-ALIGNMENT §4.1.` };
    }

    // The branch gives back what it holds — FIFO, oldest-first. There is nothing to REVERSE
    // (the branch never consumed this; it just received it and is handing it back), so this is
    // a plain consume(), the same mechanism every other outbound branch movement already uses.
    const consumed = await consume(tx, {
      orgId: input.orgId, storeId: branchStoreId, locationId: branchLocation.id, itemId: branchItemId,
      quantity: p.quantity, movedAt, kind: 'transfer_out', sourceType: 'customer_return', sourceId: returnId,
      createdBy: input.actor.personId,
    });
    if (!consumed.ok) return consumed;

    const value = consumed.totalCost;
    totalValue = add(totalValue, value);

    // The commissary receives a fresh layer back, at the same value — a straight return has no
    // margin to carry (unlike a T-133 dispatch, this is not a sale of processing work).
    const movement = await stockLedgerRepo.insertMovement(tx, {
      orgId: input.orgId, storeId: commissaryStoreId, locationId: commissaryLocation.id, itemId: item.id,
      movedAt, quantity: p.quantity, kind: 'transfer_in', sourceType: 'customer_return', sourceId: returnId,
      createdBy: input.actor.personId,
    });
    await stockLayersRepo.createLayer(tx, {
      orgId: input.orgId, storeId: commissaryStoreId, itemId: item.id, receivedAt: movedAt, quantity: p.quantity,
      unitCost: perBaseUnit(value, p.quantity), source: 'transfer_in', sourceId: returnId,
      movementId: movement.id,
    });

    lineInputs.push({
      lineNo: String(lineNo), tradeOrderLineId: p.orderLine.id, quantity: p.quantity, saleable: true,
      amount: value, cost: value, itemId: item.id, movementId: movement.id,
    });

    const bGroup = branchGroups.get(branchAccount);
    branchGroups.set(branchAccount, { inventoryAccount: branchAccount, amount: add(bGroup ? money(bGroup.amount) : ZERO, value) });
    const cGroup = commissaryGroups.get(commissaryAccount);
    commissaryGroups.set(commissaryAccount, { inventoryAccount: commissaryAccount, amount: add(cGroup ? money(cGroup.amount) : ZERO, value) });
  }

  // ⭐ §4/invariant 12 — ONE entry, four legs (or more, if the return spans several inventory
  // kinds), the reciprocal pair equal and opposite by construction, exactly as T-173.
  const memo = `Return ${branchCode} → ${commissaryCode} — ${input.reason.trim()}`;
  const lines: PostEntryLine[] = [
    {
      accountCode: '2150', storeId: branchStoreId, debit: totalValue,
      partyType: 'store' as const, partyId: commissaryCode, lineMemo: memo,
    },
    ...[...branchGroups.values()].map((g) => ({ accountCode: g.inventoryAccount, storeId: branchStoreId, credit: g.amount, lineMemo: memo })),
    ...[...commissaryGroups.values()].map((g) => ({ accountCode: g.inventoryAccount, storeId: commissaryStoreId, debit: g.amount, lineMemo: memo })),
    {
      accountCode: '1250', storeId: commissaryStoreId, credit: totalValue,
      partyType: 'store' as const, partyId: branchCode, lineMemo: memo,
    },
  ];

  const posted = await postEntry(tx, {
    orgId: input.orgId, entryDate: input.returnedOn, sourceType: 'customer_return', sourceId: returnId,
    idempotencyKey: `customer_return:${returnId}:post`, memo, postedBy: input.actor.personId, lines,
  });

  await customerReturnsRepo.createReturn(tx, {
    id: returnId, orgId: input.orgId, storeId: branchStoreId, tradeOrderId: order.id, customerId: order.customerId,
    treatment: 'internal', returnedOn: input.returnedOn, reason: input.reason.trim(), settlement: 'reverse_transfer',
    journalEntryId: posted.entryId, createdBy: input.actor.personId, lines: lineInputs,
  });

  return { ok: true, returnId, journalEntryId: posted.entryId, settlement: 'reverse_transfer' };
}

// -----------------------------------------------------------------------------------------
// voidCustomerReturn
// -----------------------------------------------------------------------------------------

export interface VoidCustomerReturnOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * ⭐ Invariant 13 — reverses every leg in one transaction, refused once the credit has been
 * redeemed or refunded. ⚠️ "Redeemed" is checked the same way T-170's `voidReturn` checks it:
 * the return's own store-credit contribution must still be present in the customer's live
 * balance, since credit is pooled and fungible, not tracked per-return.
 */
export async function voidCustomerReturn(
  tx: Tx | null,
  actor: Actor,
  returnId: string,
  reason: string,
): Promise<VoidCustomerReturnOutcome> {
  const run = async (trx: Tx): Promise<VoidCustomerReturnOutcome> => {
    const ret = await customerReturnsRepo.getReturn(trx, returnId);
    if (!ret) return { ok: false, reason: `return ${returnId} does not exist.` };
    await authorize(trx, actor, 'void_customer_return', { storeId: ret.storeId });
    if (ret.status === 'void') return { ok: false, reason: 'this return is already void.' };

    const trimmed = reason.trim();
    if (!trimmed) return { ok: false, reason: 'say why this return is being voided.' };

    // T-369 S4: the void reverses stock and the entry at the return's own date; a closed month's stock stays as it was.
    // The stock gives back at NOW too, so today's month has to take it (the trigger sees the UTC date).
    const now = new Date(); // ONE instant: tested here, and stamped on every reversal and on the void below
    const closedToday = await closedStockPeriodSentenceToday(trx, actor.orgId, now, 'voided');
    if (closedToday) return { ok: false, reason: closedToday };
    const closedVoid = await closedStockPeriodSentence(trx, actor.orgId, ret.returnedOn, 'voided');
    if (closedVoid) return { ok: false, reason: closedVoid };

    if (ret.settlement === 'store_credit' || ret.settlement === 'mixed') {
      // T-371 R4/C4 — both sides minted from the database and compared in scaled bigint.
      const balance = money(await arRepo.creditBalanceOf(trx, ret.orgId, ret.customerId));
      const lines = await customerReturnsRepo.getReturnLines(trx, returnId);
      const contribution = add(...lines.map((l) => money(l.amount)));
      // ⚠️ A rough but honest check, matching T-170's own: if the live balance is already below
      // what this return alone would have contributed, some of it is provably gone. ⚠️ For
      // `mixed`, `contribution` over-counts (part of it reduced AR, not 2140) — a deliberately
      // CONSERVATIVE check: it may refuse a few valid voids it cannot prove safe, never the
      // reverse, since the split between the two legs is not stored separately.
      if (compare(balance, contribution) < 0) {
        return { ok: false, reason: 'this return\'s credit looks partly spent — unwind that first.' };
      }
    }

    // ⚠️ TWO source TYPES on the same return id: the return itself, and (only for a
    // saleable=false line) the SEPARATE wastage re-relief — §5's "two events" means two things
    // to give back, not one.
    const movements = [
      ...(await stockLedgerRepo.movementsBySource(trx, 'customer_return', returnId)),
      ...(await stockLedgerRepo.movementsBySource(trx, 'customer_return_unsellable', returnId)),
    ];

    for (const m of movements) {
      const original = await stockLedgerRepo.findMovement(trx, m.id);
      if (!original) continue;
      // ⭐ Which action undoes a movement depends on how it was CREATED, not its `kind` label:
      // a movement `consume()` made (real `stock_layer_consumptions` rows behind it — the
      // branch's own transfer_out, or the unsaleable re-relief) is undone by `reverseConsumption`;
      // a movement `reverseConsumption()` or a raw `createLayer()` made (the saleable give-back,
      // or the commissary's fresh internal layer — nothing was EVER consumed FROM it) is undone
      // by a fresh `consume()`. Checked against the DB, not guessed from the kind.
      const outstanding = await stockLayersRepo.outstandingConsumptions(trx, m.id);
      if (outstanding.length > 0) {
        const reversed = await reverseConsumption(trx, {
          orgId: ret.orgId, storeId: m.storeId, locationId: m.locationId, itemId: m.itemId,
          originalMovementId: m.id, quantity: absQty(original.quantity), movedAt: now,
          kind: original.kind as StockMovementKind,
          sourceType: 'customer_return_void', sourceId: returnId, createdBy: actor.personId,
        });
        if (!reversed.ok) throw new Error(`voidCustomerReturn: ${reversed.reason}`);
      } else {
        const consumedBack = await consume(trx, {
          orgId: ret.orgId, storeId: m.storeId, locationId: m.locationId, itemId: m.itemId,
          quantity: absQty(original.quantity), movedAt: now, kind: original.kind as StockMovementKind,
          sourceType: 'customer_return_void', sourceId: returnId, createdBy: actor.personId,
        });
        if (!consumedBack.ok) throw new Error(`voidCustomerReturn: ${consumedBack.reason}`);
      }
    }

    // ⚠️ Up to TWO entries: the main return entry, and (only for an unsaleable line) the
    // separate wastage entry — found by their own idempotency keys, not assumed to be one.
    const mainEntry = await journalRepo.findEntryByIdempotencyKey(trx, ret.orgId, `customer_return:${returnId}:post`);
    if (mainEntry) await reverseEntry(trx, { entryId: mainEntry.id, reason: trimmed, reversedBy: actor.personId });
    if (ret.journalEntryId && ret.journalEntryId !== mainEntry?.id) {
      await reverseEntry(trx, { entryId: ret.journalEntryId, reason: trimmed, reversedBy: actor.personId });
    }
    const wastedAccounts = new Set<string>();
    for (const l of await customerReturnsRepo.getReturnLines(trx, returnId)) {
      if (l.saleable) continue;
      const item = await itemsRepo.getItemById(trx, ret.orgId, l.itemId);
      const account = item && INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
      if (account) wastedAccounts.add(account);
    }
    for (const account of wastedAccounts) {
      const entry = await journalRepo.findEntryByIdempotencyKey(
        trx, ret.orgId, `customer_return:${returnId}:${account}:unsellable:wastage`,
      );
      if (entry) await reverseEntry(trx, { entryId: entry.id, reason: trimmed, reversedBy: actor.personId });
    }

    await customerReturnsRepo.markVoid(trx, returnId, actor.personId, trimmed, now);
    return { ok: true };
  };
  if (tx) return run(tx);
  return transaction(run);
}

function absQty(q: string): Quantity {
  return quantity(q.startsWith('-') ? q.slice(1) : q);
}

// -----------------------------------------------------------------------------------------
// applyCredit — §7, spending 2140 against a later trade order
// -----------------------------------------------------------------------------------------

export interface ApplyCreditOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly collectionId?: string;
}

/**
 * ⭐ §7 — T-131's out-of-scope line superseded, for TRADE ORDERS only (the retail/POS path
 * stays out of scope, T-131's sentence still stands there). Routes through the real AR
 * subledger (`recordCollection`'s own `creditApplied` extension) rather than a bare journal
 * entry — a bypass would drift `ar_collection_allocations` from the raw ledger, the exact
 * 13.3% class of bug `repo/ar.ts`'s own header exists to prevent.
 */
export async function applyCredit(
  tx: Tx | null,
  actor: Actor,
  /** ⛔ NO `orgId` — T-231/DEF-210. It comes from `actor`. */
  input: { tradeOrderId: string; amount: string; collectionDate: string; moneyAccountId: string },
): Promise<ApplyCreditOutcome> {
  const run = async (trx: Tx): Promise<ApplyCreditOutcome> => {
    const orgId = actor.orgId;
    const order = await tradeRepo.getOrderById(trx, orgId, input.tradeOrderId);
    if (!order) return { ok: false, reason: `trade order ${input.tradeOrderId} does not exist.` };
    if (!order.arChargeId) return { ok: false, reason: 'this order has no receivable to apply credit against.' };
    await authorize(trx, actor, 'apply_customer_credit', { storeId: order.storeId });

    // T-371 — parsed AFTER authorize() (R5), so a typo is refused in a sentence that QUOTES what was typed; it was
    // `Number(input.amount)`, which turned 'abc' into NaN, slipped past both guards and was forwarded as the text "NaN".
    const amount = parseMoneyInput(input.amount, 'applyCredit: the amount', 'The amount');
    const outstanding = money(await arRepo.outstandingForCharge(trx, orgId, order.arChargeId));
    if (compare(amount, ZERO) <= 0) return { ok: false, reason: 'the amount must be greater than zero.' };
    if (compare(amount, outstanding) > 0) {
      return { ok: false, reason: `only ₱${outstanding} is outstanding on this order.` };
    }

    const result = await recordCollection(trx, actor, {
      storeId: order.storeId, customerId: order.customerId, collectionDate: input.collectionDate,
      amount, moneyAccountId: input.moneyAccountId, creditApplied: amount,
      allocations: [{ chargeId: order.arChargeId, amountApplied: amount }],
    });
    return { ok: true, collectionId: result.collectionId };
  };
  if (tx) return run(tx);
  return transaction(run);
}
