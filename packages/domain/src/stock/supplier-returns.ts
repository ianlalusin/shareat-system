/**
 * Supplier returns — T-170, bible row 166. The goods go back, and we hold a credit.
 *
 * ⭐ **Stock relief reuses `consume()` verbatim** (kind `return_out`, already in
 * `STOCK_MOVEMENT_KINDS`/`VALUE_MOVING_KINDS`) — a return is FIFO consumption like any other, and
 * invariant 3's "no negative on-hand, no override, not even admin" is `consume()`'s own refusal,
 * not a second copy of the rule here.
 *
 * ⭐ **`credit_basis` is derived PER LINE**, not once for the whole document — see
 * `packages/db/schema/supplier-returns.ts`'s header for why the task spec's two-value contract
 * needed a third, `mixed`, value at the header. `deriveLineCreditBasis` below is where the
 * per-line derivation actually happens: it reads the ORIGINAL layer the delivery created
 * (`stockLayersRepo.findByDeliveryItem`), never the layer `consume()` actually relieves — those
 * can differ once part of the lot has been used (invariant 4), and the question `credit_basis`
 * answers is about the RECEIPT's invoice status, not about which shelf the goods came off today.
 *
 * ⚠️ **An untraceable return (no `deliveryLineId`) defaults to `supplier_advance`.** Not in the
 * task spec's 15 tests — a judgement call for the case it left silent. Reasoning: with no receipt
 * to check, assuming the goods were already paid for is the safer business default (it gives a
 * spendable credit rather than crediting a GRNI balance nothing ever opened), and matches Ian's
 * own framing that a return should end up as something the business can use, not a number nobody
 * can explain.
 *
 * ⭐ **The return's own id is minted before anything else** (`supplierReturnsRepo.nextReturnId`) —
 * same reason `attendance-adjustments.ts`'s `nextAdjustmentId` mints early: the journal entry
 * that must reference this return (`sourceId`) has to exist before the row does, so the id is
 * fixed first and both the stock movements and the entry carry it from the start.
 */
import { add, compare, money, ZERO, type Money } from '@shareat/core/money';
import { advisoryLocksRepo, apRepo, deliveriesRepo, moneyAccountsRepo, stockLayersRepo, supplierReturnsRepo, type Tx } from '@shareat/db';
import { parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';
import { authorize, type Actor } from '@shareat/auth';
import { consume, reverseConsumption } from './consume';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { GRNI_ACCOUNT, INVENTORY_ACCOUNT_BY_ITEM_KIND } from './receipt-posting';
import { perBaseUnit } from '../deliveries/receive';
import { closedStockPeriodSentence, closedStockPeriodSentenceToday } from './period-guard';
import { compareQuantity, isPositiveQuantity, quantity, subtractQuantity, type Quantity } from './quantity';

const ADVANCES_ACCOUNT = apRepo.ADVANCES_CODE;

export interface ReturnLineInput {
  readonly itemId: string;
  readonly itemKind: string;
  readonly locationId: string;
  readonly quantity: Quantity;
  readonly deliveryLineId: string | null;
}

export interface RecordReturnInput {
  /** ⛔ NO `orgId`. T-231/DEF-210: the organisation is derived from `actor`, never supplied —
   *  a caller that can name a tenant can name someone else's. */
  readonly storeId: string;
  readonly supplierId: string;
  readonly deliveryId: string | null;
  readonly returnedOn: string;
  readonly reason: string;
  readonly lines: readonly ReturnLineInput[];
  readonly actor: Actor;
}

export type RecordReturnOutcome =
  | { readonly ok: true; readonly returnId: string }
  | { readonly ok: false; readonly reason: string };

async function deriveLineCreditBasis(
  tx: Tx,
  deliveryId: string | null,
  itemId: string,
): Promise<'grni' | 'supplier_advance'> {
  if (!deliveryId) return 'supplier_advance';
  const layer = await stockLayersRepo.findByDeliveryItem(tx, deliveryId, itemId);
  if (!layer) return 'supplier_advance';
  return layer.isProvisional ? 'grni' : 'supplier_advance';
}

export async function recordReturn(tx: Tx, input: RecordReturnInput): Promise<RecordReturnOutcome> {
  await authorize(tx, input.actor, 'record_supplier_return', { storeId: input.storeId });
  // ⭐ The org comes from the session-resolved actor. `authorize` above has just proven the store
  // belongs to THIS org, so the two can no longer disagree (T-231/DEF-210).
  const orgId = input.actor.orgId;

  // T-369 S4a (DEF-528): the stock moves at NOW but the entry posts at `returnedOn`, so BOTH months have to
  // take it. Said in words, before the first write; the trigger stays the backstop.
  const closedReturnedOn = await closedStockPeriodSentence(tx, orgId, input.returnedOn, 'returned');
  if (closedReturnedOn) return { ok: false, reason: closedReturnedOn };
  const now = new Date(); // ONE instant: tested here, and stamped on every movement below
  const closedToday = await closedStockPeriodSentenceToday(tx, orgId, now, 'returned');
  if (closedToday) return { ok: false, reason: closedToday };

  if (input.lines.length === 0) {
    return { ok: false, reason: 'a return with no lines returns nothing' };
  }
  if (!input.reason.trim()) {
    return { ok: false, reason: 'a return needs a reason' };
  }
  for (const line of input.lines) {
    if (!isPositiveQuantity(line.quantity)) {
      return { ok: false, reason: `the quantity for item ${line.itemId} must be greater than zero` };
    }
    if (!INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind]) {
      return { ok: false, reason: `item kind "${line.itemKind}" has no inventory account in COA-ALIGNMENT §4.1` };
    }
  }

  // ⭐ `stock_movements` carries no composite FK tying `location_id` to `store_id` (unlike
  // T-167's `stock_transfers`, which added one) — so this is checked explicitly rather than
  // trusted to a constraint that does not exist. Invariant 15's cross-store analogue for returns.
  for (const line of input.lines) {
    const belongs = await supplierReturnsRepo.locationBelongsToStore(tx, line.locationId, input.storeId);
    if (!belongs) {
      return { ok: false, reason: `location ${line.locationId} does not belong to store ${input.storeId}` };
    }
  }

  // ⭐ Invariant 11 — a return may not name a supplier the linked delivery did not come from.
  if (input.deliveryId) {
    const delivery = await deliveriesRepo.getDelivery(tx, input.deliveryId);
    if (!delivery) return { ok: false, reason: `delivery ${input.deliveryId} does not exist` };
    if (delivery.supplierId !== input.supplierId) {
      return { ok: false, reason: `delivery ${input.deliveryId} was not from supplier ${input.supplierId}` };
    }
  }

  // ⭐ Invariant 2 — capped at received minus already returned, per delivery line. Checked BEFORE
  // any write, same "all preconditions first" discipline T-166 §7.2 named.
  for (const line of input.lines) {
    if (!line.deliveryLineId) continue;
    const deliveryLine = await deliveriesRepo.getDeliveryLine(tx, line.deliveryLineId);
    if (!deliveryLine) return { ok: false, reason: `delivery line ${line.deliveryLineId} does not exist` };
    if (deliveryLine.itemId !== line.itemId) {
      return { ok: false, reason: `delivery line ${line.deliveryLineId} is for a different item than ${line.itemId}` };
    }
    const received = quantity(deliveryLine.receivedQuantity ?? '0');
    const alreadyReturned = quantity(
      await supplierReturnsRepo.returnedQuantityForDeliveryLine(tx, line.deliveryLineId),
    );
    const cap = subtractQuantity(received, alreadyReturned);
    if (compareQuantity(line.quantity, cap) > 0) {
      return {
        ok: false,
        reason: `delivery line ${line.deliveryLineId}: only ${cap} is still returnable (received ${received}, already returned ${alreadyReturned})`,
      };
    }
  }

  const returnId = await supplierReturnsRepo.nextReturnId(tx);
  const returnLines: {
    lineNo: string;
    itemId: string;
    locationId: string;
    quantity: string;
    deliveryLineId: string | null;
    movementId: string;
    unitCost: string;
    creditBasis: 'grni' | 'supplier_advance';
    itemKind: string;
    cost: Money;
  }[] = [];

  // ⭐ Invariant 3 — no negative on-hand, NO override. `consume()` is the one place that rule is
  // enforced; a shortfall returns ok:false before anything is written for that line.
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i]!;
    const result = await consume(tx, {
      orgId,
      storeId: input.storeId,
      locationId: line.locationId,
      itemId: line.itemId,
      quantity: line.quantity,
      movedAt: now,
      kind: 'return_out',
      sourceType: 'supplier_return',
      sourceId: returnId,
      createdBy: input.actor.personId,
    });
    if (!result.ok) return result;

    const creditBasis = await deriveLineCreditBasis(tx, input.deliveryId, line.itemId);
    const unitCost = perBaseUnit(result.totalCost, line.quantity);

    returnLines.push({
      lineNo: String(i + 1),
      itemId: line.itemId,
      locationId: line.locationId,
      quantity: line.quantity,
      deliveryLineId: line.deliveryLineId,
      movementId: result.movementId,
      unitCost,
      creditBasis,
      itemKind: line.itemKind,
      cost: result.totalCost,
    });
  }

  // ⭐ Invariant 5 — grouped by (basis, inventory account) so a mixed return posts BOTH legs in
  // one entry, never one entry per line.
  const byGroup = new Map<string, { basis: 'grni' | 'supplier_advance'; account: string; total: Money }>();
  for (const line of returnLines) {
    const account = INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind]!;
    const key = `${line.creditBasis}:${account}`;
    const existing = byGroup.get(key);
    if (existing) byGroup.set(key, { ...existing, total: add(existing.total, line.cost) });
    else byGroup.set(key, { basis: line.creditBasis, account, total: line.cost });
  }

  const supplier = await apRepo.getSupplierById(tx, input.actor.orgId, input.supplierId);
  const supplierName = supplier?.name ?? input.supplierId;

  const journalLines = [];
  for (const { basis, account, total } of byGroup.values()) {
    const creditAccount = basis === 'grni' ? GRNI_ACCOUNT : ADVANCES_ACCOUNT;
    journalLines.push({
      accountCode: creditAccount,
      storeId: input.storeId,
      debit: total,
      ...(basis === 'supplier_advance' ? { partyType: 'supplier' as const, partyId: input.supplierId } : {}),
      lineMemo: basis === 'grni' ? `Supplier return — ${supplierName}` : `Return credit — ${supplierName}`,
    });
    journalLines.push({
      accountCode: account,
      storeId: input.storeId,
      credit: total,
      lineMemo: `Supplier return — ${supplierName}`,
    });
  }

  const totalGrni = sumWhere(byGroup, 'grni');
  const totalAdvance = sumWhere(byGroup, 'supplier_advance');
  const headerBasis =
    compare(totalGrni, ZERO) === 0 ? 'supplier_advance' : compare(totalAdvance, ZERO) === 0 ? 'grni' : 'mixed';

  const posted = await postEntry(tx, {
    orgId,
    entryDate: input.returnedOn,
    sourceType: 'supplier_return',
    sourceId: returnId,
    idempotencyKey: `supplier_return:${returnId}:post`,
    memo: `Supplier return — ${supplierName}`,
    postedBy: input.actor.personId,
    lines: journalLines,
  });

  await supplierReturnsRepo.createReturn(tx, {
    id: returnId,
    orgId,
    storeId: input.storeId,
    supplierId: input.supplierId,
    deliveryId: input.deliveryId,
    returnedOn: input.returnedOn,
    reason: input.reason.trim(),
    creditBasis: headerBasis,
    journalEntryId: posted.entryId,
    createdBy: input.actor.personId,
    lines: returnLines.map((l) => ({
      lineNo: l.lineNo,
      itemId: l.itemId,
      locationId: l.locationId,
      quantity: l.quantity,
      deliveryLineId: l.deliveryLineId,
      movementId: l.movementId,
      unitCost: l.unitCost,
      creditBasis: l.creditBasis,
    })),
  });

  return { ok: true, returnId };
}

export interface VoidReturnOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/** What the loser of a double void reads — no id (I7); said above the lock and again below it. */
const ALREADY_VOIDED = 'This return has already been voided.';

export async function voidReturn(
  tx: Tx,
  actor: Actor,
  returnId: string,
  reason: string,
): Promise<VoidReturnOutcome> {
  const ret = await supplierReturnsRepo.getReturn(tx, returnId);
  if (!ret) return { ok: false, reason: `return ${returnId} does not exist` };
  await authorize(tx, actor, 'void_supplier_return', { storeId: ret.storeId });

  if (ret.status === 'void') return { ok: false, reason: ALREADY_VOIDED };
  if (!reason.trim()) return { ok: false, reason: 'a void needs a reason' };

  // T-369 S4a (DEF-528): the reversal posts at the return's own date AND moves stock at NOW, so both months
  // have to take it. Said in words, before the first write. (Both are tested below, once the lock is ours.)

  // Serialise on the supplier's credit, then read the status AGAIN with the lock ours: a double submit
  // queued behind the first void must be told "already void" whether or not this return carried credit.
  await advisoryLocksRepo.lockSupplierCredit(tx, ret.supplierId);
  const fresh = await supplierReturnsRepo.getReturn(tx, returnId);
  if (!fresh || fresh.status === 'void') return { ok: false, reason: ALREADY_VOIDED };

  // ONE instant, taken only now the lock is ours: a void that queued behind another must not be stamped with
  // the moment it started waiting. Tested here, and stamped on every reversal and on the void below.
  const now = new Date();
  const closedToday = await closedStockPeriodSentenceToday(tx, actor.orgId, now, 'voided');
  if (closedToday) return { ok: false, reason: closedToday };
  const closedReturnedOn = await closedStockPeriodSentence(tx, actor.orgId, ret.returnedOn, 'voided');
  if (closedReturnedOn) return { ok: false, reason: closedReturnedOn };

  const lines = await supplierReturnsRepo.getReturnLines(tx, returnId);

  // ⭐ Invariant 9. The credit this return contributed to 1240 is not tracked per-return — it is
  // a pooled, fungible balance (invariant 6: a query, never a stored column) — so "has THIS
  // return's credit been spent" is answered the only way a pooled balance can answer it: would
  // reversing this return's own 1240 contribution take the supplier's CURRENT balance negative?
  // If yes, some of what this return credited has already been drawn down elsewhere, and voiding
  // would leave that spend backed by nothing — the exact orphan the invariant exists to prevent.
  const advanceContribution = lines
    .filter((l) => l.creditBasis === 'supplier_advance')
    .reduce((sum, l) => add(sum, money((Number(l.quantity) * Number(l.unitCost)).toFixed(2))), ZERO);
  if (compare(advanceContribution, ZERO) > 0) {
    const balance = money(await apRepo.advancesPositionOf(tx, actor.orgId, ret.supplierId));
    if (compare(balance, advanceContribution) < 0) {
      return {
        ok: false,
        reason:
          `cannot void — the ₱${advanceContribution} credit this return holds has already been ` +
          `partly or fully spent (current balance ₱${balance}). Unwind the allocation first.`,
      };
    }
  }

  for (const line of lines) {
    const result = await reverseConsumption(tx, {
      orgId: ret.orgId,
      storeId: ret.storeId,
      locationId: line.locationId,
      itemId: line.itemId,
      originalMovementId: line.movementId,
      quantity: quantity(line.quantity),
      movedAt: now,
      kind: 'return_out',
      sourceType: 'supplier_return_void',
      sourceId: returnId,
      createdBy: actor.personId,
    });
    // DEF-560: THROWN, not returned. By now earlier lines have already written their reversal movements in this
    // transaction, and a returned `{ok:false}` would let the caller commit them with the return still active.
    // The throw rolls the whole void back; the person reads the same sentence.
    if (!result.ok) throw refuse(`voidReturn: ${result.reason}`, result.reason);
  }

  await reverseEntry(tx, { entryId: ret.journalEntryId, reason: reason.trim(), reversedBy: actor.personId });
  await supplierReturnsRepo.markVoid(tx, returnId, actor.personId, reason.trim(), now);

  return { ok: true };
}

/** How much of a delivery line is still returnable — `received − already returned`. */
export async function returnableQuantity(tx: Tx, deliveryLineId: string): Promise<Quantity> {
  const line = await deliveriesRepo.getDeliveryLine(tx, deliveryLineId);
  if (!line) return quantity('0');
  const received = quantity(line.receivedQuantity ?? '0');
  const alreadyReturned = quantity(await supplierReturnsRepo.returnedQuantityForDeliveryLine(tx, deliveryLineId));
  return subtractQuantity(received, alreadyReturned);
}

/** ⭐ Derived from `1240`, never stored (invariant 6). */
export async function supplierCreditBalance(tx: Tx, orgId: string, supplierId: string): Promise<Money> {
  return money(await apRepo.advancesPositionOf(tx, orgId, supplierId));
}

export interface RefundCreditInput {
  /** ⛔ NO `orgId` — see `RecordReturnInput`. T-231/DEF-210. */
  readonly storeId: string;
  readonly supplierId: string;
  readonly moneyAccountId: string;
  readonly amount: string;
  readonly businessDate: string;
  readonly actor: Actor;
}

export type RefundCreditOutcome =
  | { readonly ok: true; readonly entryId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * ⭐ Invariant 8: "a cash refund from the supplier draws 1240 down and is not a new document
 * type." Not named in the task spec's own Contract §"ts block — only `recordPayment`'s
 * allocation-side extension is (§5) — but invariant 8 and test 9 both require the posting to
 * exist somewhere, and a REFUND (cash coming IN because of a credit) is not shaped like an
 * ALLOCATION (an open AP item being settled), so it does not fit inside `recordPayment` the way
 * spending the credit against an invoice does. Reported as a small necessary addition beyond the
 * contract's function list, not a silent scope expansion — see the task report.
 */
export async function refundSupplierCredit(tx: Tx, input: RefundCreditInput): Promise<RefundCreditOutcome> {
  await authorize(tx, input.actor, 'apply_supplier_credit', { storeId: input.storeId });
  const orgId = input.actor.orgId; // T-231/DEF-210 — see recordReturn.

  const amount = parseMoneyInput(input.amount, 'refundSupplierCredit: the amount', 'The refund amount');
  if (compare(amount, ZERO) <= 0) {
    return { ok: false, reason: 'a refund must be for a positive amount' };
  }
  // T-369 S0·N3: the same per-supplier lock `recordPayment` / `voidPayment` take, before the balance read.
  await advisoryLocksRepo.lockSupplierCredit(tx, input.supplierId);
  const balance = money(await apRepo.advancesPositionOf(tx, orgId, input.supplierId));
  if (compare(amount, balance) > 0) {
    return { ok: false, reason: `only ${balance} of credit is available — ${amount} does not fit` };
  }

  const supplier = await apRepo.getSupplierById(tx, orgId, input.supplierId);
  const supplierName = supplier?.name ?? input.supplierId;
  const account = await moneyAccountsRepo.getById(tx, orgId, input.moneyAccountId);
  if (!account) return { ok: false, reason: `money account ${input.moneyAccountId} does not exist` };

  const posted = await postEntry(tx, {
    orgId,
    entryDate: input.businessDate,
    sourceType: 'supplier_credit_refund',
    sourceId: input.supplierId,
    idempotencyKey: `supplier_credit_refund:${input.supplierId}:${input.businessDate}:${input.amount}`,
    memo: `Return credit refunded — ${supplierName}`,
    postedBy: input.actor.personId,
    lines: [
      {
        accountCode: account.glAccountCode,
        storeId: input.storeId,
        debit: amount,
        ...(account.glAccountCode === '1140' ? { partyType: 'money_account' as const, partyId: account.id } : {}),
        lineMemo: `Refund received — ${supplierName}`,
      },
      {
        accountCode: ADVANCES_ACCOUNT,
        storeId: input.storeId,
        credit: amount,
        partyType: 'supplier',
        partyId: input.supplierId,
        lineMemo: `Return credit refunded — ${supplierName}`,
      },
    ],
  });

  return { ok: true, entryId: posted.entryId };
}

function sumWhere(
  groups: Map<string, { basis: 'grni' | 'supplier_advance'; account: string; total: Money }>,
  basis: 'grni' | 'supplier_advance',
): Money {
  let sum = ZERO;
  for (const g of groups.values()) if (g.basis === basis) sum = add(sum, g.total);
  return sum;
}
