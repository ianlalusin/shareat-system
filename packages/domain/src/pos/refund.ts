/**
 * T-534 S4 - refund: money back to the customer for some (or all) of a paid receipt, the way it was paid. docs/tasks/534-pos-convert-correction-refund.md ("Refund"),
 * bible rows 272, 391, 402; ADR-015 A4.2; Ian, 19 Nov 2026 (2A): goes back the way it was paid, some items only, manager PIN, internet.
 *
 * ## What it is, and is not
 * The receipt NEVER changes (migrations 0238 / 0240). A refund is its own document: `pos_refunds` + its lines + its money-back rows, dated when it happens, collected into the
 * next Z (`day_close_id`, once). It is allowed before OR after the receipt's own Z (a refund after the Z lands in the CURRENT open day), at the receipt's own store only (row 402:
 * the cash comes from the refunding store's drawer). Online only (an API call, no outbox kind).
 *
 * ## The money of a line (DEF-590 must not repeat)
 * A receipt line stores its `net` = gross - its discounts (senior / PWD and presets are line discounts in release 1, so the bill's discounts are ALREADY spread over its lines: nothing to
 * allocate). A refund of q of Q units gives back round(net x q / Q), and the refund that brings a line's refunded quantity to Q takes the exact remainder, so the lines of a receipt
 * refunded in any number of pieces add up to exactly what the customer paid for it. The old design refunded gross (ignoring the discount); a test pins that this does not.
 *
 * ## Rules that are easy to get wrong
 *  - Caps are judged under the receipt's row lock, after the store's Z lock: sum of refunded qty per line <= sold; per route (`refundRoutes`) <= what the till kept of that paid row, less what
 *    corrections moved off it, less what was refunded (T-613 D1: a correction's TARGET method takes back what was moved to it); sum of the money-back rows = the refund total = the sum of its lines.
 *  - A refund and ALL its children are written in the TOP-LEVEL transaction (the 0240-style append guard compares the parent's xmin to the current transaction id; a savepoint would refuse them).
 *  - The refund number is per store (`refund_seq`, from 1) taken under the Z lock; printed as <store code>-R-<6 digits> by the app.
 *  - A wallet money-back row needs the reference of the money sent back (4 to 40 characters), as a wallet payment does.
 *  - Approval is the S3 pattern (`postSaleApprover`): a manager's PIN, a wrong one charged in its own committed transaction; a signed-in holder of `approve_pos_correction` needs none.
 */
import { authorize, type Actor } from '@shareat/auth';
import { compare, fromCentavos, money, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { advisoryLocksRepo, posV1Repo, posV2Repo, type Tx } from '@shareat/db';
import { assertFieldRules } from '../shared/field-rules-assert';
import { gone, refuse } from '../shared/refusal';
import { parseMoneyInput } from '../shared/money-input';
import { POS_PAYMENT_REFERENCE_RULES, POS_REASON_RULES } from '../field-rules/pos';
import { keptOf, postSaleApprover } from './tender-correction';
import { audit, recordedDifferently, requireContext, uuidInput } from './shared';

// ---------------------------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------------------------
export const REFUND_NO_LINES = 'Pick at least one item to refund.';
export const REFUND_LINE_ONCE = 'Each item can only be picked once.';
export const REFUND_PAYMENT_ONCE = 'Each payment can only be used once.';
export const REFUND_NOTHING_ON_LINE = 'That item has no money left to refund.';
const pad = (n: number, w: number) => String(n).padStart(w, '0');

// ---------------------------------------------------------------------------------------------------------------------
// The figures (pure)
// ---------------------------------------------------------------------------------------------------------------------
type LineRow = { id: string; qty: number; net: string };

/** The printed refund number: <store code>-R-<seq, 6 digits>. */
export const refundNoOf = (storeCode: string, seq: number): string => `${storeCode}-R-${pad(seq, 6)}`;

/**
 * What refunding `qty` more units of a line gives back, in centavos. `netCents` is the line's net after its discounts, `sold` its quantity, `refundedQty` / `refundedCents` what earlier
 * refunds already took. round-half-up of net x qty / sold; the refund that brings the refunded quantity to `sold` takes the exact remainder. Never more than what is left.
 */
export function refundLineCents(netCents: bigint, sold: number, refundedQty: number, refundedCents: bigint, qty: number): bigint {
  const left = netCents - refundedCents;
  if (refundedQty + qty >= sold) return left;
  const share = (2n * netCents * BigInt(qty) + BigInt(sold)) / (2n * BigInt(sold));
  return share > left ? left : share;
}

/** What each refundable quantity of a line would give back (index q-1 = q more units), for the screen: the server's numbers, never the tablet's arithmetic. */
export function refundAmountsOfLine(line: LineRow, refundedQty: number, refundedCents: bigint): string[] {
  const netCents = toCentavos(money(line.net));
  const out: string[] = [];
  for (let q = 1; q <= line.qty - refundedQty; q++) out.push(String(fromCentavos(refundLineCents(netCents, line.qty, refundedQty, refundedCents, q))));
  return out;
}

/** One way money can go back on a receipt: the paid row's own method, or (T-613 D1) a method a wrong-payment-method correction of that row moved money to. */
export interface RefundRoute {
  paymentId: string;
  tenderId: string;
  /** Centavos still free to give back by this route (never below zero). */
  left: bigint;
}

/**
 * What each way of refunding a receipt can still give back (T-613 D1). A paid row's OWN method: what the till kept (tendered - change given) - what corrections moved OFF it - what was
 * already refunded by it. Each correction's TARGET method, on the same paid row: what was moved to it - what was already refunded by it. So 1,000 cash with 300 corrected to GCash
 * refunds at most 700 cash and 300 GCash, and the drawer never pays out money it never took. Routes are in payment order, a row's own method first.
 */
export function refundRoutes(
  payments: readonly { id: string; tenderId: string; amount: string; changeGiven: string }[],
  corrections: readonly { paymentId: string; toTenderId: string; amount: string }[],
  refunded: readonly { paymentId: string; tenderId: string; amount: string }[],
): RefundRoute[] {
  const refundedBy = (paymentId: string, tenderId: string): bigint =>
    refunded.filter((r) => r.paymentId === paymentId && r.tenderId === tenderId).reduce((a, r) => a + toCentavos(money(r.amount)), 0n);
  const atLeastZero = (n: bigint): bigint => (n > 0n ? n : 0n);
  const routes: RefundRoute[] = [];
  for (const p of payments) {
    const mine = corrections.filter((c) => c.paymentId === p.id);
    const away = mine.reduce((a, c) => a + toCentavos(money(c.amount)), 0n);
    routes.push({ paymentId: p.id, tenderId: p.tenderId, left: atLeastZero(keptOf(p) - away - refundedBy(p.id, p.tenderId)) });
    for (const tenderId of [...new Set(mine.map((c) => c.toTenderId))]) {
      const moved = mine.filter((c) => c.toTenderId === tenderId).reduce((a, c) => a + toCentavos(money(c.amount)), 0n);
      routes.push({ paymentId: p.id, tenderId, left: atLeastZero(moved - refundedBy(p.id, tenderId)) });
    }
  }
  return routes;
}

/** What a Z, an X or a handover shows for refunds: the total, the part paid out of the drawer, and how many. */
export interface RefundBlock {
  total: Money;
  cash: Money;
  count: number;
}

/** Refund payments per tender, in centavos. */
export function refundCentsByTender(payments: readonly { tenderId: string; amount: string }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const p of payments) out.set(p.tenderId, (out.get(p.tenderId) ?? 0n) + toCentavos(money(p.amount)));
  return out;
}

export function refundBlockOf(refunds: readonly { total: string }[], payments: readonly { tenderId: string; amount: string }[], kind: ReadonlyMap<string, 'cash' | 'wallet'>): RefundBlock {
  let cash = 0n;
  for (const p of payments) if (kind.get(p.tenderId) === 'cash') cash += toCentavos(money(p.amount));
  return { total: fromCentavos(refunds.reduce((a, r) => a + toCentavos(money(r.total)), 0n)), cash: fromCentavos(cash), count: refunds.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// recordRefund
// ---------------------------------------------------------------------------------------------------------------------
export interface RecordRefundInput {
  storeId: string;
  /** The tablet; a refund is a till act (its cash comes out of this till's drawer). */
  pairingId: string | null;
  /** Device-made uuid: the row's idempotency key, so a retry is the same refund. */
  requestId: string;
  receiptId: string;
  lines: { receiptLineId: string; qty: number }[];
  /** The original paid rows the money goes back to. `referenceNo` is required for a wallet. */
  payments: { paymentId: string; amount: string; referenceNo?: string | null; /** Omitted: the paid row's own method. T-613 D1: the method a correction moved money to. */ tenderId?: string }[];
  reason: string;
  /** The manager's PIN. Not needed when the signed-in person already holds `approve_pos_correction` at the store. */
  approval?: { pin: string };
}

/** What the refund slip prints, already worked out (nothing on the paper is computed). */
export interface RefundSlipData {
  refundNo: string;
  receiptNo: string;
  recordedAt: Date;
  reason: string;
  total: string;
  lines: { name: string; qty: number; amount: string }[];
  payments: { tenderName: string; amount: string; referenceNo: string | null }[];
  approvedByName: string;
  recordedByName: string;
}
export interface RecordRefundResult {
  wrote: boolean;
  id: string;
  refundNo: string;
  total: string;
  slip: RefundSlipData;
}

type Refund = posV2Repo.PosRefundRow;

async function slipOf(tx: Tx, orgId: string, refund: Refund, storeCode: string): Promise<RefundSlipData> {
  const lines = await posV2Repo.listRefundLines(tx, orgId, refund.id);
  const pays = await posV2Repo.listRefundPayments(tx, orgId, refund.id);
  const receiptLines = new Map((await posV2Repo.listReceiptLines(tx, orgId, [refund.parentReceiptId])).map((l) => [l.id, l]));
  const tenders = new Map((await posV1Repo.listTendersByStore(tx, orgId, refund.storeId)).map((t) => [t.id, t.name]));
  const receipt = await posV2Repo.getSalesReceipt(tx, orgId, refund.storeId, refund.parentReceiptId);
  const terminalNo = receipt ? ((await posV2Repo.getTerminalNoById(tx, orgId, receipt.terminalId)) ?? 0) : 0;
  const names = await posV2Repo.listPersonNames(tx, orgId, [refund.approvedBy, refund.recordedBy]);
  return {
    refundNo: refundNoOf(storeCode, refund.refundSeq),
    receiptNo: receipt ? `${storeCode}-${pad(terminalNo, 2)}-${pad(receipt.terminalSeq, 6)}` : '',
    recordedAt: refund.recordedAt,
    reason: refund.reason,
    total: refund.total,
    lines: lines.map((l) => ({ name: receiptLines.get(l.receiptLineId)?.name ?? 'Item', qty: l.qty, amount: l.amount })),
    payments: pays.map((p) => ({ tenderName: tenders.get(p.tenderId) ?? 'Unknown tender', amount: p.amount, referenceNo: p.referenceNo })),
    approvedByName: names.get(refund.approvedBy) ?? '',
    recordedByName: names.get(refund.recordedBy) ?? '',
  };
}

export async function recordRefund(tx: Tx, actor: Actor, input: RecordRefundInput): Promise<RecordRefundResult> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = (await requireContext(tx, actor, storeId, input.pairingId, false))!;
  const requestId = uuidInput(input.requestId, 'The request id');
  const receiptId = uuidInput(input.receiptId, 'The receipt');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw refuse('pos: refund without lines', REFUND_NO_LINES);
  const wantLines = input.lines.map((l) => ({ lineId: uuidInput(l.receiptLineId, 'The item'), qty: l.qty }));
  for (const l of wantLines) if (!Number.isInteger(l.qty) || l.qty <= 0) throw refuse('pos: refund quantity not a whole number above zero', 'The quantity must be a whole number above zero.');
  if (new Set(wantLines.map((l) => l.lineId)).size !== wantLines.length) throw refuse('pos: refund names a line twice', REFUND_LINE_ONCE);
  if (!Array.isArray(input.payments) || input.payments.length === 0) throw refuse('pos: refund without payments', 'Say how the money goes back.');
  const wantPays = input.payments.map((p) => {
    const amount = parseMoneyInput(String(p.amount ?? ''), 'recordRefund: payment amount', 'The amount');
    if (compare(amount, ZERO) <= 0) throw refuse('pos: refund payment not above zero', 'The amount must be above zero.');
    return { paymentId: uuidInput(p.paymentId, 'The payment'), tenderId: p.tenderId === undefined ? null : uuidInput(p.tenderId, 'The payment method'), cents: toCentavos(amount), amount, referenceNo: p.referenceNo ?? null };
  });
  if (new Set(wantPays.map((p) => `${p.paymentId}:${p.tenderId ?? ''}`)).size !== wantPays.length) throw refuse('pos: refund names a payment twice', REFUND_PAYMENT_ONCE);
  const { reason } = assertFieldRules(POS_REASON_RULES, { reason: input.reason });

  const storeCode = (await posV2Repo.getStoreCode(tx, orgId, storeId)) ?? '';
  // A retry of the same request is answered before anything else is judged (and must be the same refund).
  const same = async (r: Refund): Promise<boolean> => {
    if (r.storeId !== storeId || r.parentReceiptId !== receiptId) return false;
    const ls = await posV2Repo.listRefundLines(tx, orgId, r.id);
    const ps = await posV2Repo.listRefundPayments(tx, orgId, r.id);
    return ls.length === wantLines.length && ls.every((l) => wantLines.some((w) => w.lineId === l.receiptLineId && w.qty === l.qty))
      && ps.length === wantPays.length && ps.every((p) => wantPays.some((w) => w.paymentId === p.paymentId && (w.tenderId ?? p.tenderId) === p.tenderId && w.cents === toCentavos(money(p.amount))));
  };
  const replay = async (r: Refund): Promise<RecordRefundResult> => {
    if (!(await same(r))) throw recordedDifferently();
    return { wrote: false, id: r.id, refundNo: refundNoOf(storeCode, r.refundSeq), total: r.total, slip: await slipOf(tx, orgId, r, storeCode) };
  };
  const prior = await posV2Repo.getRefundByRequestId(tx, orgId, requestId);
  if (prior) return replay(prior);

  const approverId = await postSaleApprover(tx, actor, storeId, input.approval?.pin);

  // The Z's own lock, then the receipt's: a refund can never slip into a Z that already read its figures, and two refunds of one receipt take turns. Then the request id again.
  await advisoryLocksRepo.lockPosDayClose(tx, storeId);
  const raced = await posV2Repo.getRefundByRequestId(tx, orgId, requestId);
  if (raced) return replay(raced);
  const receipt = await posV2Repo.getReceiptForUpdate(tx, orgId, storeId, receiptId);
  if (!receipt) throw gone(`pos: receipt ${receiptId} not found at store ${storeId}`, 'that receipt');
  const terminal = await posV2Repo.getTerminalForPairing(tx, orgId, storeId, pairingId);
  if (!terminal) throw refuse('pos: no till for this tablet', 'This tablet is not set up as a till yet. Ask a manager.');

  // Quantity and money caps, read under the lock.
  const receiptLines = await posV2Repo.listReceiptLines(tx, orgId, [receiptId]);
  const earlierLines = await posV2Repo.listRefundLinesOfReceipts(tx, orgId, [receiptId]);
  const refundedOf = (lineId: string): { qty: number; cents: bigint } =>
    earlierLines.filter((l) => l.receiptLineId === lineId).reduce((a, l) => ({ qty: a.qty + l.qty, cents: a.cents + toCentavos(money(l.amount)) }), { qty: 0, cents: 0n });
  const refundLines: posV2Repo.NewRefundLine[] = [];
  let total = 0n;
  for (const w of wantLines) {
    const line = receiptLines.find((l) => l.id === w.lineId);
    if (!line) throw gone(`pos: line ${w.lineId} not on receipt ${receiptId}`, 'that item');
    const done = refundedOf(line.id);
    if (done.qty + w.qty > line.qty) {
      throw refuse(`pos: refund ${w.qty} of ${line.id} over the ${line.qty - done.qty} left`, `Only ${line.qty - done.qty} of ${line.name} can still be refunded.`);
    }
    const cents = refundLineCents(toCentavos(money(line.net)), line.qty, done.qty, done.cents, w.qty);
    if (cents <= 0n) throw refuse(`pos: refund of line ${line.id} is zero`, REFUND_NOTHING_ON_LINE);
    refundLines.push({ orgId, refundId: '', receiptId, receiptLineId: line.id, qty: w.qty, amount: fromCentavos(cents) });
    total += cents;
  }
  const payments = await posV2Repo.listPaymentRowsOfReceipts(tx, orgId, [receiptId]);
  const routes = refundRoutes(payments, await posV2Repo.listTenderCorrectionsOfReceipts(tx, orgId, [receiptId]), await posV2Repo.listRefundPaymentsOfReceipts(tx, orgId, [receiptId]));
  const tenders = new Map((await posV1Repo.listTendersByStore(tx, orgId, storeId)).map((t) => [t.id, t]));
  const refundPayments: posV2Repo.NewRefundPayment[] = [];
  let paid = 0n;
  for (const w of wantPays) {
    const pay = payments.find((p) => p.id === w.paymentId);
    if (!pay) throw gone(`pos: payment ${w.paymentId} not on receipt ${receiptId}`, 'that payment');
    const tenderId = w.tenderId ?? pay.tenderId;
    const route = routes.find((r) => r.paymentId === pay.id && r.tenderId === tenderId);
    if (!route) throw refuse(`pos: payment ${pay.id} was not paid or corrected to tender ${tenderId}`, 'The money can only go back by the way it was paid.');
    if (w.cents > route.left) {
      throw refuse(`pos: refund ${w.cents} over the ${route.left} centavos left on payment ${pay.id} by tender ${tenderId}`, `Only ₱${fromCentavos(route.left)} can still be refunded to ${tenders.get(tenderId)?.name ?? 'that payment method'}.`);
    }
    const wallet = tenders.get(tenderId)?.kind === 'wallet';
    const referenceNo = wallet ? assertFieldRules(POS_PAYMENT_REFERENCE_RULES, { referenceNo: w.referenceNo ?? '' }).referenceNo! : null;
    refundPayments.push({ orgId, refundId: '', receiptId, paymentId: pay.id, tenderId, amount: w.amount, referenceNo });
    paid += w.cents;
  }
  if (paid !== total) throw refuse(`pos: refund payments ${paid} != lines ${total} centavos`, `The money going back (₱${fromCentavos(paid)}) must equal the refund total (₱${fromCentavos(total)}).`);

  // Written in the TOP-LEVEL transaction, parent first: the append guard refuses a child under another transaction's refund (and under a savepoint).
  const seq = await posV2Repo.nextRefundSeq(tx, orgId, storeId);
  const row = await posV2Repo.insertRefund(tx, {
    orgId, storeId, terminalId: terminal.id, parentReceiptId: receiptId, refundSeq: seq, total: fromCentavos(total), reason: reason!, approvedBy: approverId, recordedBy: actor.personId, requestId,
  });
  await posV2Repo.insertRefundLines(tx, refundLines.map((l) => ({ ...l, refundId: row.id })));
  await posV2Repo.insertRefundPayments(tx, refundPayments.map((p) => ({ ...p, refundId: row.id })));
  await audit(tx, actor, 'pos.refund_recorded', {
    storeId, entityId: row.id, pairingId, at: row.recordedAt, before: null,
    after: {
      receiptId, refundNo: refundNoOf(storeCode, seq), total: String(fromCentavos(total)), reason, approvedBy: approverId, afterZ: receipt.dayCloseId !== null,
      lines: refundLines.map((l) => ({ lineId: l.receiptLineId, qty: l.qty, amount: String(l.amount) })),
      payments: refundPayments.map((p) => ({ paymentId: p.paymentId, tenderId: p.tenderId, amount: String(p.amount), hasReference: p.referenceNo !== null })),
    },
  });
  return { wrote: true, id: row.id, refundNo: refundNoOf(storeCode, seq), total: row.total, slip: await slipOf(tx, orgId, row, storeCode) };
}
