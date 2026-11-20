/**
 * T-534 S3 - wrong payment method: a correction entry that moves some of ONE paid row of a receipt to another payment method, before the Z.
 * docs/tasks/534-pos-convert-correction-refund.md ("Wrong payment method"), ADR-015 A4.2, bible row 272.
 *
 * ## What it is, and is not
 * The receipt NEVER changes (migrations 0238 / 0240 freeze it). A correction is its own row (`pos_tender_corrections`): "of this paid row, `amount` was really paid by
 * `to_tender`". The Z (`figuresOf`) then reads each method's sales AFTER the corrections - old method minus, new method plus - and the sales day it derives uses that split.
 * The Z collects the corrections of the receipts it takes (`day_close_id`, set once). After the Z a mistake is a refund plus a new sale (row 272), so a receipt already in a Z is refused.
 *
 * ## Rules that are easy to get wrong
 *  - The most one paid row can give up = amount tendered - change given (what the till actually kept) - what earlier corrections already moved off it.
 *  - Approval is a manager's PIN (`verifyPosManagerApproval`), unless the signed-in person already holds `approve_pos_correction` at the store. A wrong PIN is charged in
 *    its OWN committed transaction (as the Z and the line approvals do), so it counts toward the cap although this call is refused and rolls back.
 *  - A correction takes the Z's per-store lock and the receipt's row lock, so it can never slip in after the Z read the figures: the Z reads what it committed, or it is refused.
 *  - A wallet as the new method needs a reference number, as it did at payment. Online only (an API call, no outbox kind).
 */
import { authorize, can, verifyPosManagerApproval, POS_TERMINAL_NOT_REGISTERED, type Actor } from '@shareat/auth';
import { compare, fromCentavos, money, toCentavos, ZERO } from '@shareat/core/money';
import { advisoryLocksRepo, posV1Repo, posV2Repo, type Tx } from '@shareat/db';
import { assertFieldRules } from '../shared/field-rules-assert';
import { gone, refuse } from '../shared/refusal';
import { parseMoneyInput } from '../shared/money-input';
import { POS_PAYMENT_REFERENCE_RULES, POS_REASON_RULES } from '../field-rules/pos';
import { usableTender } from './convert';
import { audit, recordedDifferently, requireContext, uuidInput } from './shared';

// ---------------------------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------------------------
export const CORRECTION_CLOSED = 'Already in a closed day. Refund it and ring it again.';
export const CORRECTION_SAME_TENDER = 'Pick a different payment method from the one this was paid with.';
export const CORRECTION_NEEDS_PIN = 'A manager must approve this. Ask for a manager PIN.';
const NO_TX = null;

// ---------------------------------------------------------------------------------------------------------------------
// The figures (pure)
// ---------------------------------------------------------------------------------------------------------------------
type PaymentRow = { id: string; tenderId: string; amount: string; changeGiven: string };
type CorrectionRow = { paymentId: string; fromTenderId: string; toTenderId: string; amount: string };

/** What the till kept of a paid row: the amount tendered minus the change given. */
export const keptOf = (p: Pick<PaymentRow, 'amount' | 'changeGiven'>): bigint => toCentavos(money(p.amount)) - toCentavos(money(p.changeGiven));

/** How much of each paid row is still free to move: kept - already corrected off it (centavos, by payment id). */
export function availableByPayment(payments: readonly PaymentRow[], corrections: readonly Pick<CorrectionRow, 'paymentId' | 'amount'>[]): Map<string, bigint> {
  const left = new Map(payments.map((p) => [p.id, keptOf(p)]));
  for (const c of corrections) left.set(c.paymentId, (left.get(c.paymentId) ?? 0n) - toCentavos(money(c.amount)));
  return left;
}

/**
 * What each method really took, in centavos: the payments' kept money, then every correction moves its amount from the old method to the new. Methods that end at exactly
 * zero because of a correction are left out (a method nobody paid by is no row on the Z).
 */
export function tenderNetsAfterCorrections(payments: readonly { tenderId: string; net: bigint }[], corrections: readonly Pick<CorrectionRow, 'fromTenderId' | 'toTenderId' | 'amount'>[]): Map<string, bigint> {
  const nets = new Map<string, bigint>();
  for (const p of payments) nets.set(p.tenderId, (nets.get(p.tenderId) ?? 0n) + p.net);
  const touched = new Set<string>();
  for (const c of corrections) {
    const cents = toCentavos(money(c.amount));
    nets.set(c.fromTenderId, (nets.get(c.fromTenderId) ?? 0n) - cents);
    nets.set(c.toTenderId, (nets.get(c.toTenderId) ?? 0n) + cents);
    touched.add(c.fromTenderId);
    touched.add(c.toTenderId);
  }
  for (const id of touched) if (nets.get(id) === 0n) nets.delete(id);
  return nets;
}

/**
 * The approver of a post-sale document (a correction, a refund): the signed-in person when they may approve here, else a manager's PIN. A wrong PIN is charged in its OWN
 * committed transaction (NO_TX), so it counts although the calling transaction is refused and rolls back; the tablet's own terminal bucket takes it, never a value the device names.
 */
export async function postSaleApprover(tx: Tx, actor: Actor, storeId: string, pin: string | undefined): Promise<string> {
  if (await can(tx, actor, 'approve_pos_correction', { storeId })) return actor.personId;
  if (typeof pin !== 'string' || pin === '') throw refuse('pos: correction needs approval', CORRECTION_NEEDS_PIN);
  const terminalPersonId = await posV2Repo.getActiveTerminalPersonId(tx, actor.orgId, storeId);
  if (!terminalPersonId) throw refuse('pos: no terminal link for the store', POS_TERMINAL_NOT_REGISTERED);
  return (await verifyPosManagerApproval(NO_TX, { orgId: actor.orgId, erpStoreId: storeId, pin, terminalPersonId })).approverPersonId;
}

// ---------------------------------------------------------------------------------------------------------------------
// recordTenderCorrection
// ---------------------------------------------------------------------------------------------------------------------
export interface RecordTenderCorrectionInput {
  storeId: string;
  /** The tablet; a correction is a till act. */
  pairingId: string | null;
  /** Device-made uuid: the row's idempotency key, so a retry is the same row. */
  requestId: string;
  receiptId: string;
  /** The paid row being moved. */
  paymentId: string;
  toTenderId: string;
  amount: string;
  /** Required when the new method is a wallet (4 to 40 characters), as at payment. */
  referenceNo?: string | null;
  reason: string;
  /** The manager's PIN. Not needed when the signed-in person already holds `approve_pos_correction` at the store. */
  approval?: { pin: string };
}

type Row = posV2Repo.PosTenderCorrectionRow;

export async function recordTenderCorrection(tx: Tx, actor: Actor, input: RecordTenderCorrectionInput): Promise<{ wrote: boolean; id: string }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = (await requireContext(tx, actor, storeId, input.pairingId, false))!;
  const requestId = uuidInput(input.requestId, 'The request id');
  const receiptId = uuidInput(input.receiptId, 'The receipt');
  const paymentId = uuidInput(input.paymentId, 'The payment');
  const toId = uuidInput(input.toTenderId, 'The new payment method');
  const amount = parseMoneyInput(String(input.amount ?? ''), 'recordTenderCorrection: amount', 'The amount');
  if (compare(amount, ZERO) <= 0) throw refuse('pos: correction amount not above zero', 'The amount must be above zero.');
  const { reason } = assertFieldRules(POS_REASON_RULES, { reason: input.reason });

  // A retry of the same request is answered before anything else is judged (and must be the same correction).
  const same = (r: Row) => r.storeId === storeId && r.receiptId === receiptId && r.paymentId === paymentId && r.toTenderId === toId && toCentavos(money(r.amount)) === toCentavos(amount);
  const prior = await posV2Repo.getTenderCorrectionByRequestId(tx, orgId, requestId);
  if (prior) {
    if (!same(prior)) throw recordedDifferently();
    return { wrote: false, id: prior.id };
  }

  const approverId = await postSaleApprover(tx, actor, storeId, input.approval?.pin);

  // The Z's own lock, then the receipt's: the Z never freezes figures a correction is about to change.
  await advisoryLocksRepo.lockPosDayClose(tx, storeId);
  const raced = await posV2Repo.getTenderCorrectionByRequestId(tx, orgId, requestId);
  if (raced) {
    if (!same(raced)) throw recordedDifferently();
    return { wrote: false, id: raced.id };
  }
  const receipt = await posV2Repo.getReceiptForUpdate(tx, orgId, storeId, receiptId);
  if (!receipt) throw gone(`pos: receipt ${receiptId} not found at store ${storeId}`, 'that receipt');
  if (receipt.dayCloseId) throw refuse('pos: correction after the Z', CORRECTION_CLOSED);
  const payments = await posV2Repo.listPaymentRowsOfReceipts(tx, orgId, [receiptId]);
  const payment = payments.find((p) => p.id === paymentId);
  if (!payment) throw gone(`pos: payment ${paymentId} not on receipt ${receiptId}`, 'that payment');
  if (payment.tenderId === toId) throw refuse('pos: correction to the same tender', CORRECTION_SAME_TENDER);
  // T-613: money already REFUNDED by this row's own method is no longer in the till to move (P1,000 cash, P600 refunded, P700 moved to GCash would leave the drawer short).
  const refundedOwn = (await posV2Repo.listRefundPaymentsOfReceipts(tx, orgId, [receiptId]))
    .filter((r) => r.paymentId === paymentId && r.tenderId === payment.tenderId)
    .reduce((a, r) => a + toCentavos(money(r.amount)), 0n);
  const left = (availableByPayment(payments, await posV2Repo.listTenderCorrectionsOfReceipts(tx, orgId, [receiptId])).get(paymentId) ?? 0n) - refundedOwn;
  if (toCentavos(amount) > left) {
    throw refuse(`pos: correction ${toCentavos(amount)} over the ${left} centavos left on payment ${paymentId}`, `Only ₱${fromCentavos(left > 0n ? left : 0n)} of this payment can still be moved to another method.`);
  }
  const to = usableTender(await posV1Repo.listTendersByStore(tx, orgId, storeId), toId);
  const referenceNo = to.kind === 'wallet' ? assertFieldRules(POS_PAYMENT_REFERENCE_RULES, { referenceNo: input.referenceNo ?? '' }).referenceNo! : null;

  const row = await posV2Repo.insertTenderCorrection(tx, {
    orgId, storeId, receiptId, paymentId, fromTenderId: payment.tenderId, toTenderId: toId, amount, referenceNo, reason: reason!, approvedBy: approverId, recordedBy: actor.personId, requestId,
  });
  await audit(tx, actor, 'pos.tender_corrected', {
    storeId, entityId: row.id, pairingId, at: row.recordedAt,
    before: { tenderId: payment.tenderId, receiptId, paymentId },
    after: { toTenderId: toId, amount: String(amount), hasReference: referenceNo !== null, reason, approvedBy: approverId },
  });
  return { wrote: true, id: row.id };
}
