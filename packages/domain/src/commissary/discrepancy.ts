/**
 * The three dispositions, and each is a different account — T-174.
 *
 * ⭐ **What is stranded and why.** T-173 posts a short receipt at what arrived and leaves the
 * difference in `1340 Inventory in transit` on the commissary's books. That is not an accounting
 * convenience: goods that visibly left one building and did not reach another are a real asset
 * until somebody says what happened to them. This module is where somebody says.
 *
 * ```
 * AUDIT ONLY     nothing               the gap stays in 1340 with a note, and STILL BLOCKS
 * LOSS           Dr 5300  Cr 1340      genuinely lost, damaged or spoiled in transit
 * CHARGE         Dr 1230  Cr 1340      recovered from a named staffer, at the transfer value
 * LATE RECEIPT   nothing here          the rest turned up; T-173's own path posts the balance
 * ```
 *
 * ⭐ **And the other direction (T-372 S6b / DEF-513).** A branch that COUNTED MORE than was sent books only what was
 * sent and the excess is an `over` row — never on either store's books until a manager decides:
 *
 * ```
 * AUDIT ONLY       nothing               waiting, and STILL BLOCKS
 * EXTRA DISPATCH   see below             the commissary confirms it really sent more: the extra is booked at both stores
 * RETURN           nothing               it went back, or the branch recounted — the excess was never booked, so a
 *                                        reversal would take the branch below what it holds
 * ```
 *
 * `extra_dispatch` is ONE entry with no `1340` leg (the goods were never in transit on the books):
 * `Dr` branch inventory at the line's `rate` · `Cr 2150` branch · `Dr 1250` commissary · `Cr` commissary inventory at
 * what `consume()` relieved (layer cost — dispatch relieves at layer cost, so any other figure splits the stock ledger
 * from `1310`) · the margin to `5175`. ⛔ The direction gate runs BEFORE any posting branch: the short dispositions would
 * otherwise try to post against an over row.
 *
 * ⚠️ **`5300` and not `5400`.** A count variance is a *correction* to the books; goods that left
 * one building and did not reach another are a *loss*. Different facts, different accounts — the
 * same distinction T-164 §2 draws, and the reason both accounts exist.
 *
 * ⭐ **`audit` is a decision to WAIT, not a resolution.** It records that a human looked and chose
 * to leave the value where it is, and the row stays `open`, so the day-open block keeps refusing.
 * ⛔ That is deliberate: an escape hatch that stopped the blocking would be a way to make the
 * dispute disappear without deciding it, which is the state this whole task exists to prevent.
 */
import { compare, decimal, money, subtract, ZERO, type Money } from '@shareat/core/money';
import {
  commissaryRepo,
  customersRepo,
  itemsRepo,
  moneyTransfersRepo,
  stockLayersRepo,
  stockLedgerRepo,
  stockLocationsRepo,
  tradeDiscrepanciesRepo,
  journalRepo,
  tradeRepo,
  type Tx,
} from '@shareat/db';
import { parseBusinessDate } from '@shareat/core/datetime';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { lineCost } from '../stock/layers';
import { consume } from '../stock/consume';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../stock/receipt-posting';
import { quantity, toThousandths } from '../stock/quantity';
import { humanDate, internalFault } from '../shared/refusal';
import type { Outcome } from './outcome';
import { DUE_FROM_ACCOUNT, DUE_TO_ACCOUNT, IN_TRANSIT_ACCOUNT, TRANSFER_OUT_ACCOUNT } from './transfer';

/** T-164's account for a real loss, as opposed to `5400`'s correction of a count. */
export const LOSS_ACCOUNT = '5300';
/** ⚠️ A receivable from the staffer, `party_type = 'employee'` — never a P&L account. */
export const STAFF_CHARGE_ACCOUNT = '1230';

export type Disposition = 'audit' | 'loss' | 'charge' | 'late_receipt' | 'extra_dispatch' | 'return';

/** ⭐ T-372 S6b — what an `over` row may NOT be resolved as, and why (Ian, 2026-10-01/02). */
const OVER_REFUSES_SHORT_DISPOSITIONS =
  "This is an over-receipt — the extra goods were never on either store's books, so there is nothing to write off or charge. Book it as an extra dispatch if the commissary sent more, or as a return if it went back or was a miscount.";
const SHORT_REFUSES_OVER_DISPOSITIONS =
  'This is a shortage — extra dispatch and return apply only to goods counted over what was sent.';
const RETURN_NEEDS_NOTE =
  'A return must say what happened — who carried the extra back and when, or that the branch recounted.';

/** "January 2026" - the month a fiscal period covers, for a sentence a person reads. */
function monthLabel(startsOn: string): string {
  return new Date(`${startsOn}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * T-379 S1 (DEF-575): the words for a posting disposition whose date falls in a closed or locked month, else `null`.
 * ⛔ A SENTENCE, not the enforcement: RULES section 6 item 3 - `postEntry` and the stock trigger still refuse; this asks the
 * same source (`findPeriodForDate`, the database's own period state) BEFORE the first write so nothing half-posts and the
 * manager reads a reason instead of a developer sentence with ids. No period rule is re-implemented: open, uncovered and
 * malformed dates return `null` and behave as before.
 */
async function closedMonthRefusal(tx: Tx, orgId: string, on: string): Promise<{ ok: false; reason: string; userReason: string } | null> {
  let day: ReturnType<typeof parseBusinessDate>;
  try {
    day = parseBusinessDate(on);
  } catch {
    return null;
  }
  const period = await journalRepo.findPeriodForDate(tx, orgId, on);
  if (!period || period.status === 'open') return null;
  return {
    ok: false,
    reason: `resolveDiscrepancy: the fiscal period covering ${on} is ${period.status}`,
    userReason: `${monthLabel(period.startsOn)} is ${period.status}, so this can't be booked on ${humanDate(day)}. Nothing was saved.`,
  };
}

export interface ResolveDiscrepancyInput {
  readonly orgId: string;
  readonly discrepancyId: string;
  readonly commissaryStoreId: string;
  readonly disposition: Disposition;
  /** Required for `charge`, refused for everything else. */
  readonly chargePersonId?: string | null;
  readonly note?: string | null;
  readonly resolvedOn: string;
  readonly resolvedBy: string;
}

/**
 * Resolve one discrepancy: the posting and the status change, in one transaction.
 *
 * ⭐ **The row is read `FOR UPDATE` first**, so two managers deciding the same dispute at the same
 * moment cannot both post — the second one finds it resolved and is refused by the terminality
 * trigger rather than double-relieving `1340`.
 */
export async function resolveDiscrepancy(
  tx: Tx,
  input: ResolveDiscrepancyInput,
): Promise<Outcome<{ entryId: string | null; value: Money }>> {
  const row = await tradeDiscrepanciesRepo.findById(tx, input.discrepancyId);
  if (!row) return { ok: false, reason: `discrepancy ${input.discrepancyId} does not exist` };
  if (row.storeId !== input.commissaryStoreId) {
    // ⚠️ Invariant 11: the goods are the COMMISSARY's asset. The branch reports what arrived and
    // does not decide what the difference was.
    //
    // ⭐ ONE exception (Ian, 2026-10-02): the recount return is initiated by the manager of the store that is RETURNING
    // — the BRANCH that miscounted. It admits the branch for `return` on an `over` row only (it posts nothing); the
    // commissary keeps every resolution right it had, and the branch still cannot book an extra dispatch.
    const branchRecount =
      row.direction === 'over' &&
      input.disposition === 'return' &&
      (await branchStoreOfOrder(tx, input.orgId, row.orderId)) === input.commissaryStoreId;
    if (!branchRecount) {
      return {
        ok: false,
        reason: 'only the dispatching commissary may resolve this — the branch reports, it does not decide',
      };
    }
  }
  if (row.status === 'resolved') {
    return {
      ok: false,
      reason: `discrepancy ${row.id} is already resolved as ${row.disposition} — reverse it and resolve again`,
    };
  }

  // ⛔ T-372 S6b — the DIRECTION GATE, before any posting branch and before every other rule.
  if (row.direction === 'over' && ['loss', 'charge', 'late_receipt'].includes(input.disposition)) {
    return { ok: false, reason: OVER_REFUSES_SHORT_DISPOSITIONS };
  }
  if (row.direction === 'short' && (input.disposition === 'extra_dispatch' || input.disposition === 'return')) {
    return { ok: false, reason: SHORT_REFUSES_OVER_DISPOSITIONS };
  }

  if (input.disposition === 'charge' && !input.chargePersonId) {
    return { ok: false, reason: 'a charge must name the person it is recovered from' };
  }
  if (input.disposition !== 'charge' && input.chargePersonId) {
    return { ok: false, reason: `a ${input.disposition} disposition cannot name a person to charge` };
  }

  // ⭐ T-379 S1 (DEF-575): below the direction gate (an over row asking for `loss` still gets that answer), above every write.
  // `audit`, `late_receipt` and `return` post nothing dated, so a closed month does not stop them.
  if (input.disposition === 'loss' || input.disposition === 'charge' || input.disposition === 'extra_dispatch') {
    const closed = await closedMonthRefusal(tx, input.orgId, input.resolvedOn);
    if (closed) return closed;
  }

  const value = money(row.value);

  // ⛔ None of these three posts a thing from here except `extra_dispatch`. `audit` leaves the value where it is on
  // purpose; `late_receipt` is closed by T-173's second confirm, which posts the balance itself — posting here as well
  // would relieve `1340` twice for one lot of goods; `return` posts nothing because the excess was never booked.
  if (input.disposition === 'audit' || input.disposition === 'late_receipt') {
    await tradeDiscrepanciesRepo.resolve(tx, {
      id: row.id,
      disposition: input.disposition,
      note: input.note ?? null,
      resolvedBy: input.resolvedBy,
    });
    return { ok: true, entryId: null, value };
  }
  if (input.disposition === 'return') {
    if (!input.note?.trim()) return { ok: false, reason: RETURN_NEEDS_NOTE };
    await tradeDiscrepanciesRepo.resolve(tx, {
      id: row.id,
      disposition: 'return',
      note: input.note.trim(),
      resolvedBy: input.resolvedBy,
    });
    return { ok: true, entryId: null, value };
  }
  if (input.disposition === 'extra_dispatch') {
    return resolveAsExtraDispatch(tx, input, row);
  }

  // The remaining dispositions post against `1340`, which only a SHORT row's value ever sat in.
  if (compare(value, ZERO) <= 0) {
    return { ok: false, reason: `discrepancy ${row.id} has no value to dispose of` };
  }

  const posted = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.resolvedOn,
    sourceType: 'trade_discrepancy',
    sourceId: row.id,
    idempotencyKey: `trade_discrepancy:${row.id}:${input.disposition}`,
    memo:
      input.disposition === 'loss'
        ? 'Goods lost in transit to branch'
        : 'Transit shortfall charged to staff',
    postedBy: input.resolvedBy,
    lines:
      input.disposition === 'loss'
        ? [
            { accountCode: LOSS_ACCOUNT, storeId: input.commissaryStoreId, debit: value },
            { accountCode: IN_TRANSIT_ACCOUNT, storeId: input.commissaryStoreId, credit: value },
          ]
        : [
            {
              accountCode: STAFF_CHARGE_ACCOUNT,
              storeId: input.commissaryStoreId,
              debit: value,
              partyType: 'employee',
              partyId: input.chargePersonId!,
            },
            { accountCode: IN_TRANSIT_ACCOUNT, storeId: input.commissaryStoreId, credit: value },
          ],
  });

  await tradeDiscrepanciesRepo.resolve(tx, {
    id: row.id,
    disposition: input.disposition,
    chargePersonId: input.chargePersonId ?? null,
    note: input.note ?? null,
    journalEntryId: posted.entryId,
    resolvedBy: input.resolvedBy,
  });

  return { ok: true, entryId: posted.entryId, value };
}

/** The branch store an order was dispatched TO — its internal customer's counterparty store. */
async function branchStoreOfOrder(tx: Tx, orgId: string, orderId: string): Promise<string | null> {
  const order = await tradeRepo.getOrderById(tx, orgId, orderId);
  if (!order) return null;
  const customer = await customersRepo.getById(tx, orgId, order.customerId);
  return customer?.counterpartyStoreId ?? null;
}

/**
 * ⭐ T-372 S6b, amendment 2 — "Commissary sent more": the commissary manager confirms it really sent `quantity` more
 * than it dispatched, so the extra is booked at BOTH stores in one transaction (see this file's header for the legs).
 *
 * The commissary's side is `consume()` at the line's source room, resolved exactly as dispatch resolves it
 * (`line.sourceLocationId ?? the commissary's default room`); the branch's side is the mapped branch item at the branch's
 * default room, at the line's `rate`, resolved exactly as `receiveTradeOrder` resolves it. `trade_order_lines` is NOT
 * touched (`received_quantity` stays the capped booked figure). Every refusal is decided before the first write.
 */
async function resolveAsExtraDispatch(
  tx: Tx,
  input: ResolveDiscrepancyInput,
  row: NonNullable<Awaited<ReturnType<typeof tradeDiscrepanciesRepo.findById>>>,
): Promise<Outcome<{ entryId: string | null; value: Money }>> {
  const value = money(row.value);
  const order = await tradeRepo.getOrderById(tx, input.orgId, row.orderId);
  const line = await tradeRepo.getLineById(tx, input.orgId, row.orderLineId);
  if (!order || !line) throw internalFault(`resolveDiscrepancy: discrepancy ${row.id} names an order or line that does not exist`);
  const customer = await customersRepo.getById(tx, input.orgId, order.customerId);
  const branchStoreId = customer?.counterpartyStoreId;
  if (!branchStoreId) throw internalFault(`resolveDiscrepancy: order ${order.id} has no branch store to receive the extra`);

  const item = await itemsRepo.getItemById(tx, input.orgId, line.itemId);
  const map = await commissaryRepo.mapItem(tx, row.storeId, branchStoreId, line.itemId);
  if (!item || !map) throw internalFault(`resolveDiscrepancy: line ${line.id} has no item or no commissary_item_map row for this store pair`);
  const branchItem = await itemsRepo.getItemById(tx, input.orgId, map.branchItemId);
  if (!branchItem) throw internalFault(`resolveDiscrepancy: the mapped branch item for line ${line.id} no longer exists`);
  const commissaryAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
  const branchAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[branchItem.kind];
  if (!commissaryAccount || !branchAccount) {
    return { ok: false, reason: `item kind "${commissaryAccount ? branchItem.kind : item.kind}" has no inventory account in COA-ALIGNMENT §4.1` };
  }
  const sourceLocationId = line.sourceLocationId ?? (await stockLocationsRepo.defaultLocationFor(tx, row.storeId))?.id;
  const branchLocation = await stockLocationsRepo.defaultLocationFor(tx, branchStoreId);
  if (!sourceLocationId || !branchLocation) {
    throw internalFault(`resolveDiscrepancy: ${!sourceLocationId ? 'the commissary' : 'the branch'} has no room to move the extra through`);
  }

  // ⛔ If the commissary's books do not hold the quantity, it cannot have sent it. Checked FIRST, so nothing is written.
  const extra = quantity(row.quantity);
  const onHand = (await stockLedgerRepo.onHandByItemInStore(tx, row.storeId, line.itemId)) ?? '0';
  if (toThousandths(quantity(onHand)) < toThousandths(extra)) {
    return {
      ok: false,
      reason:
        `${item.name} — the commissary's books hold only ${onHand}, so it cannot have sent ${row.quantity} more. ` +
        "Correct the commissary's count first, or resolve this as a return.",
    };
  }

  // ⚠️ And in the ROOM `consume` will draw from: its OUT movement is written at `sourceLocationId` and the per-room
  // non-negative trigger would otherwise refuse it with a raw "stock would go negative" carrying two ids. The check
  // above is store-wide (layers are per store), so stock held only in ANOTHER room passes it.
  const atRoom = await stockLedgerRepo.onHand(tx, line.itemId, sourceLocationId);
  if (toThousandths(quantity(atRoom)) < toThousandths(extra)) {
    const room = (await stockLocationsRepo.getLocation(tx, sourceLocationId))?.name ?? 'the packing room';
    return {
      ok: false,
      reason:
        `${item.name} — the commissary's books hold ${onHand} in all, but only ${atRoom} in ${room}, which is where ` +
        `this was packed from, so ${row.quantity} more cannot have left it. Move the stock into that room or correct ` +
        'its count first, or resolve this as a return.',
    };
  }

  const movedAt = new Date(`${input.resolvedOn}T00:00:00Z`);
  const consumed = await consume(tx, {
    orgId: input.orgId, storeId: row.storeId, locationId: sourceLocationId, itemId: line.itemId,
    quantity: extra, movedAt, kind: 'transfer_out', sourceType: 'trade_discrepancy', sourceId: row.id,
    createdBy: input.resolvedBy,
  });
  if (!consumed.ok) return { ok: false, reason: consumed.reason };

  const movement = await stockLedgerRepo.insertMovement(tx, {
    orgId: input.orgId, storeId: branchStoreId, locationId: branchLocation.id, itemId: map.branchItemId,
    movedAt, quantity: extra, kind: 'transfer_in', sourceType: 'trade_discrepancy', sourceId: row.id,
    createdBy: input.resolvedBy,
  });
  // The branch's layer is at the TRANSFER RATE (the mechanism that carries the commissary's processing cost to the
  // branch's books), exactly as the receipt does it — never the commissary's layer cost.
  await stockLayersRepo.createLayer(tx, {
    orgId: input.orgId, storeId: branchStoreId, itemId: map.branchItemId, receivedAt: movedAt,
    quantity: extra, unitCost: decimal(line.rate, '14,4'), source: 'transfer_in', sourceId: row.id, movementId: movement.id,
  });

  const codes = await moneyTransfersRepo.storeCodes(tx, input.orgId, [row.storeId, branchStoreId]);
  const commissaryCode = codes.get(row.storeId);
  const branchCode = codes.get(branchStoreId);
  if (!commissaryCode || !branchCode) throw internalFault('resolveDiscrepancy: could not resolve both store codes for the extra dispatch');

  const branchValue = lineCost(extra, line.rate);
  const cost = consumed.totalCost;
  const margin = subtract(branchValue, cost);
  // Zero-value legs are omitted (`journal_lines_exactly_one_side_check` rejects them); if every leg is zero there is no entry.
  const lines: PostEntryLine[] = [];
  if (compare(branchValue, ZERO) > 0) {
    lines.push(
      { accountCode: branchAccount, storeId: branchStoreId, debit: branchValue },
      { accountCode: DUE_TO_ACCOUNT, storeId: branchStoreId, credit: branchValue, partyType: 'store', partyId: commissaryCode },
      { accountCode: DUE_FROM_ACCOUNT, storeId: row.storeId, debit: branchValue, partyType: 'store', partyId: branchCode },
    );
  }
  if (compare(cost, ZERO) > 0) lines.push({ accountCode: commissaryAccount, storeId: row.storeId, credit: cost });
  // Margin: positive → `Cr 5175`; a transfer priced below cost → `Dr 5175` (a real subsidy, on the face of the books).
  if (compare(margin, ZERO) > 0) lines.push({ accountCode: TRANSFER_OUT_ACCOUNT, storeId: row.storeId, credit: margin });
  else if (compare(margin, ZERO) < 0) lines.push({ accountCode: TRANSFER_OUT_ACCOUNT, storeId: row.storeId, debit: subtract(ZERO, margin) });

  const posted =
    lines.length > 0
      ? await postEntry(tx, {
          orgId: input.orgId,
          entryDate: input.resolvedOn,
          sourceType: 'trade_discrepancy',
          sourceId: row.id,
          idempotencyKey: `trade_discrepancy:${row.id}:extra_dispatch`,
          memo: 'Commissary confirmed it sent more than dispatched',
          postedBy: input.resolvedBy,
          lines,
        })
      : null;

  await tradeDiscrepanciesRepo.resolve(tx, {
    id: row.id,
    disposition: 'extra_dispatch',
    note: input.note ?? null,
    journalEntryId: posted?.entryId ?? null,
    resolvedBy: input.resolvedBy,
  });
  return { ok: true, entryId: posted?.entryId ?? null, value };
}

/**
 * Push the decision to a date. ⛔ **Once.** The second attempt is refused by the database
 * (`trade_discrepancies_defer_once_trg`), not by this function — a rule that lives in a service is
 * a rule the next caller routes around.
 */
export async function deferDiscrepancy(
  tx: Tx,
  input: { orgId: string; discrepancyId: string; commissaryStoreId: string; toDate: string },
): Promise<Outcome<{ deferredTo: string }>> {
  const row = await tradeDiscrepanciesRepo.findById(tx, input.discrepancyId);
  if (!row) return { ok: false, reason: `discrepancy ${input.discrepancyId} does not exist` };
  if (row.storeId !== input.commissaryStoreId) {
    return { ok: false, reason: 'only the dispatching commissary may defer this' };
  }
  if (row.status === 'resolved') {
    return { ok: false, reason: `discrepancy ${row.id} is already resolved — it cannot be deferred` };
  }
  await tradeDiscrepanciesRepo.defer(tx, row.id, input.toDate);
  return { ok: true, deferredTo: input.toDate };
}
