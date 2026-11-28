/**
 * T-524 R8 (void) and R9 (pay): docs/tasks/524-pos-v2-domain.md.
 *
 * `completeSale` is the one place a sale becomes a sales receipt: the server recomputes every figure from the DATABASE lines and discounts
 * (`priceSession`), writes ITS figures, records a mismatch with the tablet's (never refuses the sale for one, row 276, exact centavos, no
 * tolerance), takes the payments (change only from cash), writes one statutory row per senior/PWD diner, freezes lines / discounts / payments and
 * ends the session `paid` - all in the caller's ONE transaction (migration 0240 refuses a child appended under an earlier transaction's receipt).
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { readReceiptLookupDays } from '../business-rules/pos-rules';
import { add, compare, fromCentavos, money, subtract, toCentavos, type Money } from '@shareat/core/money';
import { authorize, can, verifyPosManagerApproval, POS_TERMINAL_NOT_REGISTERED, type Actor } from '@shareat/auth';
import { advisoryLocksRepo, posV1Repo, posV2Repo, statutoryDiscountsRepo, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { parseMoneyInput } from '../shared/money-input';
import { POS_PAYMENT_REFERENCE_RULES, POS_REASON_RULES, POS_STATUTORY_HOLDER_RULES } from '../field-rules/pos';
import { availableByPayment, keptOf, tenderNetsAfterCorrections } from './tender-correction';
import { refundRoutes, refundAmountsOfLine, refundNoOf } from './refund';
import { priceSession, type PricedSession } from './price';
import { isUniqueViolation, lockOpenSession } from './order';
import { earlierUsesOfCard } from './senior-repeat';
import { DEPOSIT_ALREADY_USED, DEPOSIT_MORE_THAN_BILL, DEPOSIT_MORE_THAN_HELD, DEPOSIT_NOT_SEATED, DEPOSIT_NOT_THIS_TABLE } from './reservations';
import {
  audit,
  billedHeads,
  businessDateAndRules,
  businessDateOf,
  deviceTime,
  loadLiveCharges,
  loadLiveLines,
  recordedDifferently,
  requireContext,
  requireStoreScope,
  snapshotOf,
  uuidInput,
  uuidv5,
  wholeNumber,
  type LoadedCharge,
  type LoadedLine,
  type PosDeps,
} from './shared';

// ---------------------------------------------------------------------------------------------------------------------
// R8 voidUnpaidSession
// ---------------------------------------------------------------------------------------------------------------------
export interface VoidInput {
  storeId: string;
  pairingId: string | null;
  sessionId: string;
  reason: string;
  voidedAtDevice: string | Date;
  offline: boolean;
  /** The manager's PIN. The terminal person is resolved here from the store's terminal link, never taken from the input (audit F8). */
  approval?: { pin: string };
}

export async function voidUnpaidSession(tx: Tx, actor: Actor, input: VoidInput): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const { reason } = assertFieldRules(POS_REASON_RULES, { reason: input.reason });
  const at = deviceTime(input.voidedAtDevice, 'The time of the void');
  const offline = input.offline === true;
  const sessionId = uuidInput(input.sessionId, 'The table id');
  // Audit F6: a replay of a void already written is answered before the table's state is judged.
  if ((await posV2Repo.getTableSession(tx, actor.orgId, input.storeId, sessionId))?.status === 'voided') return { wrote: false };
  const session = await lockOpenSession(tx, actor.orgId, input.storeId, sessionId);

  // The approver is the actor when the actor may approve a correction here, otherwise a manager's PIN (online only: offline the tablet already refused, row 356).
  let approverId = actor.personId;
  if (!(await can(tx, actor, 'approve_pos_correction', { storeId: input.storeId }))) {
    if (offline) throw refuse('pos: void needs approval online', 'A manager must approve voiding a table, and that needs the internet.');
    if (!input.approval) throw refuse('pos: void needs approval', 'A manager must approve voiding a table. Ask for a manager PIN.');
    // Audit F8: whose PIN bucket a wrong PIN charges is the store's own registered terminal (as pos-approval.ts resolves it), never a value the device names.
    const terminalPersonId = await posV2Repo.getActiveTerminalPersonId(tx, actor.orgId, input.storeId);
    if (!terminalPersonId) throw refuse('pos: no terminal link for the store', POS_TERMINAL_NOT_REGISTERED);
    approverId = (await verifyPosManagerApproval(tx, { orgId: actor.orgId, erpStoreId: input.storeId, pin: input.approval.pin, terminalPersonId })).approverPersonId;
  }

  // Lines and discounts first: the database refuses to change them once the session is closed.
  const lines = await posV2Repo.listSessionLines(tx, actor.orgId, input.storeId, session.id);
  const queued = lines.filter((l) => l.kitchenStatus === 'queued').map((l) => l.id);
  const discounts = (await posV2Repo.listLineDiscounts(tx, actor.orgId, input.storeId, lines.map((l) => l.id))).filter((d) => d.status === 'active');
  await posV2Repo.removeLineDiscounts(tx, actor.orgId, input.storeId, discounts.map((d) => d.id), actor.personId, at);
  // T-627: the table's store charges come off with it, for the same reason (the database refuses to change them once the session is closed).
  const charges = await loadLiveCharges(tx, actor.orgId, input.storeId, session.id);
  await posV2Repo.removeSessionCharges(tx, actor.orgId, input.storeId, charges.map((c) => c.id), actor.personId, at);
  await posV2Repo.markLinesCancelled(tx, actor.orgId, input.storeId, queued);
  await posV2Repo.markSessionVoided(tx, actor.orgId, input.storeId, session.id, { voidedBy: approverId, voidedAtDevice: at, voidReason: reason!, voidedOffline: offline });
  await audit(tx, actor, 'pos.session_voided', {
    storeId: input.storeId, entityId: session.id, pairingId, at,
    before: { status: 'open', linesCancelled: queued.length, discountsRemoved: discounts.length, chargesRemoved: charges.length },
    after: { status: 'voided', reason, offline, approvedBy: approverId },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// R9 completeSale
// ---------------------------------------------------------------------------------------------------------------------
export interface CompleteSaleInput {
  storeId: string;
  pairingId: string | null;
  sessionId: string;
  receiptId: string;
  terminalNo: number;
  terminalSeq: number;
  issuedAtDevice: string | Date;
  offline: boolean;
  device: { subtotal: string; discountTotal: string; total: string; /** T-627: absent on a sale queued before charges existed (= 0.00). */ chargeTotal?: string; lines: { lineId: string; gross: string; discountTotal: string; net: string }[] };
  payments: { tenderId: string; amount: string; referenceNo?: string; toCheck: boolean }[];
  /** T-628: the held deposit of the table's reservation applied as part of the payment (a payment line "Deposit"). Consume-once: one per reservation. Absent = none. */
  deposit?: { reservationId: string; amount: string };
  seniors: { dinerNo: number; kind: 'senior' | 'pwd'; idNumber: string; holderName: string }[];
}

const MAX_PAYMENTS = 20;
/** The mismatch audit row keeps at most this many lines per side (the totals are always there), with a `truncated` flag. */
const MISMATCH_LINE_CAP = 200;
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** What the bill is, priced from the database (the screen's figure and the receipt's figure are this one). */
async function priceFromDb(tx: Tx, actor: Actor, storeId: string, lines: LoadedLine[], charges: LoadedCharge[], deps: PosDeps | undefined, at?: Date): Promise<{ priced: PricedSession; rules: Awaited<ReturnType<typeof businessDateAndRules>> | undefined }> {
  const taxType = await posV2Repo.getOrgTaxType(tx, actor.orgId);
  // T-528: always the real rates, so `priced.vat` (the receipt's VAT split) is right for every bill, not only one with a senior/PWD discount.
  const resolved = await businessDateAndRules(tx, actor.orgId, storeId, deps, at);
  return { priced: priceSession(snapshotOf(lines, taxType === 'vat', resolved.rules, charges)), rules: resolved };
}

const sameCentavos = (a: string, b: Money) => {
  try {
    return toCentavos(money(a)) === toCentavos(b);
  } catch {
    return false;
  }
};

/** T-556 (audit P-001, R9): a replay is a no-op only when it carries what the frozen receipt recorded: the sale's flags, time and tablet total, its payments and its card holders. */
async function replayMatches(tx: Tx, actor: Actor, input: CompleteSaleInput, prior: posV2Repo.PosSalesReceiptRow, at: { issuedAt: Date; offline: boolean; printed: string }): Promise<boolean> {
  if (prior.offline !== at.offline || prior.issuedAtDevice.getTime() !== at.issuedAt.getTime() || !sameCentavos(String(input.device?.total ?? ''), money(prior.deviceTotal))) return false;
  const pays = input.payments;
  if (!Array.isArray(pays)) return false;
  const kinds = new Map((await posV2Repo.listTenders(tx, actor.orgId, pays.map((p) => String(p.tenderId)))).map((t) => [t.id, t.kind]));
  const payKey = (tenderId: string, amount: Money, ref: string, toCheck: boolean) => `${tenderId}|${toCentavos(amount)}|${ref}|${toCheck}`;
  const sent = pays.map((p) => {
    const ref = kinds.get(String(p.tenderId)) === 'wallet' ? assertFieldRules(POS_PAYMENT_REFERENCE_RULES, { referenceNo: p.referenceNo ?? '' }).referenceNo! : '';
    return payKey(String(p.tenderId), parseMoneyInput(String(p.amount ?? ''), 'pos: the payment amount', 'The payment amount'), ref, p.toCheck === true);
  });
  const stored = (await posV2Repo.listReceiptPayments(tx, actor.orgId, prior.id)).map((r) => payKey(r.tenderId, money(r.amount), r.referenceNo ?? '', r.toCheck));
  if (JSON.stringify(sent.sort()) !== JSON.stringify(stored.sort())) return false;
  if (!sameCentavos(String(input.deposit?.amount ?? '0'), money(prior.depositApplied))) return false;
  // and the same reservation: the amount alone could match a different one
  const appliedRow = await posV2Repo.getAppliedDepositOfReceipt(tx, actor.orgId, prior.storeId, prior.id);
  if ((appliedRow?.reservationId ?? '') !== String(input.deposit?.reservationId ?? '').toLowerCase()) return false;

  const holders = (Array.isArray(input.seniors) ? input.seniors : []).map((e) => {
    const h = assertFieldRules(POS_STATUTORY_HOLDER_RULES, { holderName: e.holderName ?? '', idNumber: e.idNumber ?? '' });
    return { dinerNo: e.dinerNo, kind: e.kind, idNumber: h.idNumber!, holderName: h.holderName! };
  });
  const card = (x: { kind: string; idNumber: string; holderName: string }) => `${x.kind}|${x.idNumber}|${x.holderName}`;
  const recorded = await posV2Repo.listReceiptStatutory(tx, actor.orgId, prior.storeId, prior.id, at.printed);
  if (JSON.stringify(holders.map(card).sort()) !== JSON.stringify(recorded.map(card).sort())) return false;
  // shortcut: a diner's number is checked only where its discount left a receipt row (one that rounded to nothing leaves none), the card details always.
  return recorded.every((r) => r.dinerNo === null || holders.some((h) => h.dinerNo === r.dinerNo && card(h) === card(r)));
}

export async function completeSale(tx: Tx, actor: Actor, input: CompleteSaleInput, deps?: PosDeps): Promise<{ wrote: boolean; receiptId: string }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const { storeId } = input;
  const sessionId = uuidInput(input.sessionId, 'The table id');
  const receiptId = uuidInput(input.receiptId, 'The receipt id');
  const terminalNo = wholeNumber(input.terminalNo, { what: 'The terminal number', min: 1, max: 99 });
  const terminalSeq = wholeNumber(input.terminalSeq, { what: 'The receipt number', min: 1, max: 2_147_483_647 });
  const issuedAt = deviceTime(input.issuedAtDevice, 'The time of the sale');
  const offline = input.offline === true;

  // 1. The session, locked. A replay of a sale already recorded is answered before the table's state is judged.
  const session = await posV2Repo.lockSession(tx, actor.orgId, storeId, sessionId);
  if (!session) throw gone(`pos: table session ${sessionId} not found`, 'table');
  const terminal = await posV2Repo.getTerminalByNo(tx, actor.orgId, storeId, terminalNo);
  const prior = await posV2Repo.getReceiptBySession(tx, actor.orgId, storeId, sessionId);
  if (prior) {
    if (prior.id === receiptId && prior.terminalSeq === terminalSeq && terminal?.id === prior.terminalId) {
      if (!(await replayMatches(tx, actor, input, prior, { issuedAt, offline, printed: `${await posV2Repo.getStoreCode(tx, actor.orgId, storeId)}-${pad(terminalNo, 2)}-${pad(terminalSeq, 6)}` }))) throw recordedDifferently();
      return { wrote: false, receiptId };
    }
    if (prior.id === receiptId) throw recordedDifferently();
    throw refuse('pos: table already paid', 'This table is already paid.');
  }
  if (await posV2Repo.getSalesReceipt(tx, actor.orgId, storeId, receiptId)) throw recordedDifferently();
  if (session.status !== 'open') throw refuse(`pos: session is ${session.status}`, session.status === 'voided' ? 'This table was voided.' : 'This table is already paid.');
  const lines = await loadLiveLines(tx, actor.orgId, storeId, sessionId);
  if (lines.length === 0) throw refuse('pos: nothing to pay', 'There is nothing on this table to pay for.');
  // Audit F2: a rule breach, not a total mismatch: the senior/PWD guests on the package can never outnumber the billed heads.
  const statutoryOnPackage = lines.filter((l) => l.kind === 'package').flatMap((l) => l.discounts).filter((d) => d.kind === 'senior' || d.kind === 'pwd').reduce((a, d) => a + d.qty, 0);
  if (statutoryOnPackage > billedHeads(session.headsCashier, session.headsServer)) {
    throw refuse('pos: more seniors than heads', 'There are more senior or PWD discounts than guests at this table. Remove one before paying.');
  }
  if (!terminal || terminal.pairingId !== pairingId) throw refuse('pos: terminal mismatch', 'This tablet is not set up as that till. Ask a manager.');
  if (await posV2Repo.terminalSeqUsed(tx, actor.orgId, terminal.id, terminalSeq)) throw refuse('pos: receipt number reused', 'That receipt number is already used on this till.');

  // 2. Recompute from the database; the server's figures are the receipt's.
  const charges = await loadLiveCharges(tx, actor.orgId, storeId, sessionId); // T-627
  const { priced, rules } = await priceFromDb(tx, actor, storeId, lines, charges, deps, issuedAt); // the day is the sale's own (its device time), not the replay's
  const dev = input.device;
  const devLines = new Map((dev?.lines ?? []).map((l) => [l.lineId, l]));
  const matches =
    sameCentavos(dev?.subtotal ?? '', money(priced.subtotal)) &&
    sameCentavos(dev?.discountTotal ?? '', money(priced.discountTotal)) &&
    sameCentavos(dev?.total ?? '', money(priced.total)) &&
    sameCentavos(dev?.chargeTotal ?? '0.00', money(priced.chargeTotal)) &&
    (dev?.lines ?? []).length === priced.lines.length &&
    priced.lines.every((l) => {
      const d = devLines.get(l.lineId);
      return d !== undefined && sameCentavos(d.gross, l.gross) && sameCentavos(d.discountTotal, l.discountTotal) && sameCentavos(d.net, l.net);
    });
  // `device_total` on the receipt stays the tablet's GOODS total (as before 0275, beside `total`). The shortfall audit compares the amount due with the amount due: device goods + device charges.
  const deviceTotal = parseMoneyInput(String(dev?.total ?? ''), 'pos: the tablet total', 'The tablet total');
  const deviceCharges = ((): Money => {
    try {
      return parseMoneyInput(String(dev?.chargeTotal ?? '0.00'), 'pos: the tablet charge total', 'The tablet charge total');
    } catch {
      return money('0');
    }
  })();

  // 2b. T-628: a held reservation deposit paying part of the bill. The reservation row is locked (after the session's, the order every writer of a sale uses); one deposit per reservation, ever.
  let depositApplied = money('0');
  let depositReservation: posV2Repo.PosReservationRow | undefined;
  if (input.deposit !== undefined && input.deposit !== null) {
    const reservationId = uuidInput(input.deposit.reservationId, 'The reservation');
    depositApplied = parseMoneyInput(String(input.deposit.amount ?? ''), 'pos: the deposit amount', 'The deposit amount');
    if (compare(depositApplied, money('0')) <= 0) throw refuse('pos: deposit not positive', 'The deposit applied must be more than zero.');
    depositReservation = await posV2Repo.getReservation(tx, actor.orgId, storeId, reservationId, { forUpdate: true });
    if (!depositReservation) throw gone(`pos: reservation ${reservationId} not found`, 'that reservation');
    if (depositReservation.sessionId !== sessionId) throw refuse('pos: deposit of another table', DEPOSIT_NOT_THIS_TABLE);
    // cancelled after seating (or closed): its money is a manager's to settle, not the till's to spend (the database refuses an apply on a non-seated reservation too, but in a code, not in words)
    if (depositReservation.status !== 'seated') throw refuse(`pos: reservation is ${depositReservation.status}, not seated`, DEPOSIT_NOT_SEATED);
    if ((await posV2Repo.listDepositsOfReservation(tx, actor.orgId, storeId, reservationId)).some((e) => e.kind === 'applied')) throw refuse('pos: deposit already used', DEPOSIT_ALREADY_USED);
    if (compare(depositApplied, money(await posV2Repo.heldOfReservation(tx, actor.orgId, storeId, reservationId))) > 0) throw refuse('pos: deposit over what is held', DEPOSIT_MORE_THAN_HELD);
    if (compare(depositApplied, money(priced.amountDue)) > 0) throw refuse('pos: deposit over the bill', DEPOSIT_MORE_THAN_BILL);
  }

  // 3. Payments (row 438).
  const pays = input.payments;
  if (!Array.isArray(pays) || pays.length < (depositReservation ? 0 : 1) || pays.length > MAX_PAYMENTS) throw refuse('pos: payment count', `Take between 1 and ${MAX_PAYMENTS} payments.`);
  const tenders = new Map((await posV2Repo.listTenders(tx, actor.orgId, pays.map((p) => String(p.tenderId)))).map((t) => [t.id, t]));
  const rows = pays.map((p) => {
    const t = tenders.get(String(p.tenderId));
    if (!t || t.storeId !== storeId || !t.isActive) throw refuse('pos: tender not usable', 'That way of paying is not available at this store.');
    const amount = parseMoneyInput(String(p.amount ?? ''), 'pos: the payment amount', 'The payment amount');
    if (compare(amount, money('0')) <= 0) throw refuse('pos: payment not positive', 'Each payment must be more than zero.');
    const wallet = t.kind === 'wallet';
    // Ruling 5: every wallet payment needs its reference; offline it is "to check" against the statement, online never.
    const referenceNo = wallet ? assertFieldRules(POS_PAYMENT_REFERENCE_RULES, { referenceNo: p.referenceNo ?? '' }).referenceNo! : null;
    if (p.toCheck !== (offline && wallet)) {
      throw refuse('pos: to-check flag wrong', wallet ? 'A wallet payment taken without the internet must be marked to check; online it must not.' : 'Only a wallet payment taken without the internet is marked to check.');
    }
    return { tenderId: t.id, kind: t.kind, amount, referenceNo, toCheck: p.toCheck };
  });
  const paid = add(rows.reduce((a, r) => add(a, r.amount), money('0')), depositApplied);
  // T-627: what the customer owes is the goods plus the store charges (charges sit outside `total`, so the receipt's total identity is untouched).
  const total = money(priced.amountDue);
  // T-558 (row 453): a short payment is RECORDED, never refused (the customer has already left). gap > 0 means no change; it is a routine variance up to the
  // tolerance in force on the sale's business date, a finding above it. Overpayment keeps the change-only-from-cash rule below.
  const gap = compare(paid, total) < 0 ? subtract(total, paid) : money('0');
  const change = compare(paid, total) < 0 ? money('0') : subtract(paid, total);
  let changeRow = -1;
  if (compare(change, money('0')) > 0) {
    const cash = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'cash').sort((a, b) => compare(b.r.amount, a.r.amount));
    if (cash.length === 0 || compare(change, cash[0]!.r.amount) > 0) throw refuse('pos: change not from cash', 'Change can only be given in cash.');
    changeRow = cash[0]!.i;
  }

  // 4. Senior / PWD (rows 437, 439): one statutory row per diner, the card details written only there (row 353).
  const diners = new Map<number, { kind: 'senior' | 'pwd'; gross: bigint; discount: bigint }>();
  const dinerOf = new Map<string, number>();
  for (const l of lines) for (const d of l.discounts) if (d.kind === 'senior' || d.kind === 'pwd') dinerOf.set(d.id, d.dinerNo!);
  for (const pl of priced.lines) {
    for (const pd of pl.discounts) {
      const dn = dinerOf.get(pd.discountId);
      if (dn === undefined) continue;
      const kind = lines.flatMap((l) => l.discounts).find((d) => d.id === pd.discountId)!.kind as 'senior' | 'pwd';
      const cur = diners.get(dn) ?? { kind, gross: 0n, discount: 0n };
      cur.gross += toCentavos(pd.coveredGross);
      cur.discount += toCentavos(pd.vatRemoved) + toCentavos(pd.discountAmount);
      diners.set(dn, cur);
    }
  }
  const entries = Array.isArray(input.seniors) ? input.seniors : [];
  if (new Set(entries.map((e) => e.dinerNo)).size !== entries.length) throw refuse('pos: diner listed twice', 'A senior or PWD diner is listed twice.');
  if (entries.length !== diners.size || entries.some((e) => !diners.has(e.dinerNo))) {
    throw refuse('pos: senior details do not match the discounts', 'Every senior or PWD discount needs that diner\'s card details, and no one else\'s.');
  }
  const holders = entries.map((e) => {
    if (diners.get(e.dinerNo)!.kind !== e.kind) throw refuse('pos: card kind differs', `Diner ${e.dinerNo}'s card does not match their discount.`);
    const h = assertFieldRules(POS_STATUTORY_HOLDER_RULES, { holderName: e.holderName ?? '', idNumber: e.idNumber ?? '' });
    return { dinerNo: e.dinerNo, kind: e.kind, holderName: h.holderName!, idNumber: h.idNumber! };
  });

  // 5. Write: the receipt first, then its children, then the session.
  const storeCode = await posV2Repo.getStoreCode(tx, actor.orgId, storeId);
  const printed = `${storeCode}-${pad(terminalNo, 2)}-${pad(terminalSeq, 6)}`;
  const recordIds = new Map<number, string>();
  // T-575 follow-up: one card used by two tills at once - each would miss the other's uncommitted register row below; queue per card (sorted, so two multi-card sales cannot deadlock).
  for (const id of [...new Set(holders.map((h) => h.idNumber.trim().toLowerCase()))].sort()) await advisoryLocksRepo.lockSeniorCard(tx, actor.orgId, storeId, id);
  for (const h of holders) {
    const g = diners.get(h.dinerNo)!;
    const rec = await statutoryDiscountsRepo.create(tx, {
      orgId: actor.orgId, storeId, businessDate: rules!.businessDate, invoiceNumber: printed, kind: h.kind, idNumber: h.idNumber, holderName: h.holderName,
      grossAmount: fromCentavos(g.gross), discountAmount: fromCentavos(g.discount), source: 'pos', recordedBy: actor.personId,
    });
    recordIds.set(h.dinerNo, rec.id);
  }
  // T-575 (row 462): a card already used at this store in the window is flagged for a manager below (never refused). Our own rows are left out by the printed number.
  const earlierReceipts = new Set<string>();
  let repeatedCard = false;
  for (const h of holders) {
    const uses = await earlierUsesOfCard(tx, actor.orgId, storeId, h.idNumber, rules!.businessDate, printed);
    if (uses.length > 0) repeatedCard = true;
    for (const u of uses) if (u.receiptId) earlierReceipts.add(u.receiptId);
  }
  try {
    await posV2Repo.insertReceipt(tx, {
      id: receiptId, orgId: actor.orgId, storeId, terminalId: terminal.id, terminalSeq, tableSessionId: sessionId, cashierId: actor.personId, issuedAtDevice: issuedAt,
      subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total, deviceTotal, offline, chargeTotal: priced.chargeTotal, depositApplied,
    });
  } catch (err) {
    if (isUniqueViolation(err, 'pos_sales_receipts_terminal_seq_unique')) throw refuse('pos: receipt number reused (race)', 'That receipt number is already used on this till.');
    throw err;
  }
  const receiptLineIds = new Map<string, string>();
  const lineRows = lines.map((l, i) => {
    const p = priced.lines[i]!;
    const id = globalThis.crypto.randomUUID();
    receiptLineIds.set(l.id, id);
    return { id, orgId: actor.orgId, receiptId, lineNo: i + 1, sessionLineId: l.id, kind: l.kind, name: l.name, qty: l.qty, unitPrice: money(l.unitPrice), optionValueIds: l.optionValueIds, gross: p.gross, discountTotal: p.discountTotal, net: p.net };
  });
  await posV2Repo.insertReceiptLines(tx, lineRows);
  const presetNames = new Map<string, string>();
  const discountRows: posV2Repo.NewReceiptLineDiscount[] = [];
  for (const [i, l] of lines.entries()) {
    for (const d of l.discounts) {
      const pd = priced.lines[i]!.discounts.find((x) => x.discountId === d.id)!;
      if (toCentavos(pd.discountAmount) <= 0n) continue; // a discount that rounds to nothing leaves no row (the table forbids a zero amount)
      let label = d.kind === 'senior' ? 'Senior' : d.kind === 'pwd' ? 'PWD' : 'Discount';
      if (d.kind === 'preset') {
        if (!presetNames.has(d.presetId!)) presetNames.set(d.presetId!, (await posV2Repo.getPreset(tx, actor.orgId, storeId, d.presetId!))!.name);
        label = presetNames.get(d.presetId!)!;
      }
      discountRows.push({
        orgId: actor.orgId, receiptLineId: receiptLineIds.get(l.id)!, kind: d.kind, presetId: d.presetId, label, valueType: d.valueType, value: money(d.value), qty: d.qty,
        dinerNo: d.dinerNo, vatRemoved: pd.vatRemoved, discountAmount: pd.discountAmount, statutoryRecordId: d.dinerNo === null ? null : recordIds.get(d.dinerNo) ?? null,
      });
    }
  }
  await posV2Repo.insertReceiptLineDiscounts(tx, discountRows);
  await posV2Repo.insertReceiptCharges(
    tx,
    charges.map((c, i) => ({ orgId: actor.orgId, receiptId, chargeNo: i + 1, sessionChargeId: c.id, presetId: c.presetId, name: c.name, unitAmount: money(c.unitAmount), qty: c.qty, amount: priced.charges[i]!.amount })),
  );
  await posV2Repo.insertReceiptPayments(
    tx,
    rows.map((r, i) => ({ orgId: actor.orgId, receiptId, tenderId: r.tenderId, amount: r.amount, changeGiven: i === changeRow ? change : money('0'), referenceNo: r.referenceNo, toCheck: r.toCheck })),
  );
  await posV2Repo.markSessionPaid(tx, actor.orgId, storeId, sessionId);
  // T-628: the deposit event, written in the sale's own transaction (consume-once: the partial uniques refuse a second one, a race included), then the reservation closes when nothing is left held.
  const linked = depositReservation ?? (await posV2Repo.getReservationBySession(tx, actor.orgId, storeId, sessionId));
  if (depositReservation) {
    try {
      await posV2Repo.insertDeposit(tx, {
        id: uuidv5('deposit.applied', receiptId), orgId: actor.orgId, storeId, reservationId: depositReservation.id, kind: 'applied', amount: depositApplied, tenderId: null, referenceNo: null,
        terminalId: null, receiptId, voidsDepositId: null, reason: null, recordedBy: actor.personId, approvedBy: null, occurredAtDevice: issuedAt,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'pos_reservation_deposits_applied_once_key') || isUniqueViolation(err, 'pos_reservation_deposits_receipt_once_key')) throw refuse('pos: deposit already used (race)', DEPOSIT_ALREADY_USED);
      throw err;
    }
    await audit(tx, actor, 'pos.deposit_applied', { storeId, entityId: receiptId, pairingId, at: issuedAt, before: null, after: { reservationId: depositReservation.id, receiptId, amount: String(depositApplied) } });
  }
  if (linked && linked.status === 'seated' && compare(money(await posV2Repo.heldOfReservation(tx, actor.orgId, storeId, linked.id)), money('0')) === 0) {
    await posV2Repo.updateReservation(tx, actor.orgId, storeId, linked.id, { status: 'closed', updatedAt: issuedAt, closedAt: issuedAt });
  }

  if (!matches) {
    await audit(tx, actor, 'pos.sale_recompute_mismatch', {
      storeId, entityId: receiptId, pairingId, at: issuedAt,
      before: { subtotal: dev.subtotal, discountTotal: dev.discountTotal, total: dev.total, chargeTotal: dev.chargeTotal ?? '0.00', lines: (dev.lines ?? []).slice(0, MISMATCH_LINE_CAP).map((l) => ({ lineId: l.lineId, net: l.net })), truncated: (dev.lines ?? []).length > MISMATCH_LINE_CAP },
      after: {
        subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total, chargeTotal: priced.chargeTotal,
        lines: priced.lines.slice(0, MISMATCH_LINE_CAP).map((l, i) => ({ lineId: l.lineId, qty: lines[i]!.qty, unitPrice: lines[i]!.unitPrice, net: l.net })),
        truncated: priced.lines.length > MISMATCH_LINE_CAP,
      },
    });
  }
  if (compare(gap, money('0')) > 0) {
    const tolerance = rules!.rules.saleVarianceToleranceCentavos;
    const o = {
      storeId, entityId: receiptId, pairingId, at: issuedAt,
      after: {
        gap: gap.toString(), tolerance: fromCentavos(tolerance).toString(), deviceTotal: add(deviceTotal, deviceCharges).toString(), serverTotal: priced.amountDue,
        payments: rows.map((r) => ({ tenderId: r.tenderId, amount: r.amount.toString() })),
      },
    };
    // Literal action names so the build's audit scan sees both.
    if (toCentavos(gap) > tolerance) await audit(tx, actor, 'pos.sale_payment_shortfall', o);
    else await audit(tx, actor, 'pos.sale_payment_variance', o);
  }
  // The manager's trail: this receipt and the earlier ones. No card number and no name (the earlier receipts lead to them). shortcut: at most 50 earlier receipts are listed.
  if (repeatedCard) await audit(tx, actor, 'pos.senior_id_repeat', { storeId, entityId: receiptId, pairingId, at: issuedAt, after: { receiptId, earlierReceiptIds: [...earlierReceipts].slice(0, 50) } });
  await audit(tx, actor, 'pos.sale_completed', {
    storeId, entityId: receiptId, pairingId, at: issuedAt,
    after: { sessionId, receiptNo: printed, offline, subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total, chargeTotal: priced.chargeTotal, depositApplied: String(depositApplied), payments: rows.length, statutoryDiners: holders.length },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, storeId);
  return { wrote: true, receiptId };
}

// ---------------------------------------------------------------------------------------------------------------------
// R1 currentBusinessDate, R10 reads
// ---------------------------------------------------------------------------------------------------------------------
/** The business date of the open Z window (T-531 reuses it). Before the first Z it needs the business-day start hour, through the injected reader. */
export async function currentBusinessDate(tx: Tx, storeId: string, deps?: PosDeps): Promise<string> {
  const orgId = await posV2Repo.getStoreOrgId(tx, storeId);
  if (!orgId) throw gone(`pos: store ${storeId} not found`, 'store');
  return businessDateOf(tx, orgId, storeId, deps);
}

export async function getSessionBill(tx: Tx, actor: Actor, input: { storeId: string; sessionId: string }, deps?: PosDeps) {
  await requireStoreScope(tx, actor, input.storeId);
  const session = await posV2Repo.getTableSession(tx, actor.orgId, input.storeId, uuidInput(input.sessionId, 'The table id'));
  if (!session) throw gone('pos: table session not found', 'table');
  const lines = await loadLiveLines(tx, actor.orgId, input.storeId, session.id);
  const charges = await loadLiveCharges(tx, actor.orgId, input.storeId, session.id);
  const { priced } = await priceFromDb(tx, actor, input.storeId, lines, charges, deps);
  const store = await posV2Repo.getPosStore(tx, actor.orgId, input.storeId);
  return {
    stateVersion: store?.stateVersion ?? 0,
    session: { id: session.id, mode: session.mode, standId: session.standId, status: session.status, headsCashier: session.headsCashier, headsServer: session.headsServer },
    lines: lines.map((l) => ({
      id: l.id, kind: l.kind, name: l.name, qty: l.qty, unitPrice: l.unitPrice, kitchenStatus: l.kitchenStatus, bundleHeads: l.bundleHeads,
      menuItemId: l.menuItemId, note: l.note, addedAtDevice: l.addedAtDevice,
      discounts: l.discounts.map((d) => ({ id: d.id, kind: d.kind, valueType: d.valueType, value: money(d.value), qty: d.qty, dinerNo: d.dinerNo, presetId: d.presetId })),
    })),
    // T-627: the table's ACTIVE store charges (an older tablet body has none).
    charges: charges.map((c) => ({ id: c.id, presetId: c.presetId, name: c.name, unitAmount: money(c.unitAmount), qty: c.qty })),
    pricing: priced,
  };
}

async function stateVersionOf(tx: Tx, actor: Actor, storeId: string): Promise<number> {
  return (await posV2Repo.getPosStore(tx, actor.orgId, storeId))?.stateVersion ?? 0;
}

export async function listOpenStands(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const rows = await posV2Repo.listOpenSessionsWithStand(tx, actor.orgId, input.storeId);
  return {
    stateVersion: await stateVersionOf(tx, actor, input.storeId),
    stands: rows.map((r) => ({ sessionId: r.session.id, standId: r.session.standId, standNumber: r.standNumber, mode: r.session.mode, headsCashier: r.session.headsCashier, headsServer: r.session.headsServer, openedAtDevice: r.session.openedAtDevice })),
  };
}

const ticket = (r: Awaited<ReturnType<typeof posV2Repo.listQueuedLines>>[number]) => ({
  lineId: r.line.id, sessionId: r.line.sessionId, standNumber: r.standNumber, sessionMode: r.sessionMode, kind: r.line.kind, name: r.line.name, qty: r.line.qty,
  note: r.line.note, stationId: r.line.kitchenStationId, addedAtDevice: r.line.addedAtDevice, askedBy: r.askedBy,
});

/** T-643: append the names not already in `into`, ignoring case and spaces ("Garlic" and " garlic " are one flavour); the first spelling seen wins. */
const flavourKey = (n: string) => n.replace(/\s+/g, '').toLowerCase();
function addFlavours(into: string[], names: string[]): string[] {
  for (const n of names) if (!into.some((x) => flavourKey(x) === flavourKey(n))) into.push(n);
  return into;
}

/**
 * T-529: the open dine-in tables that hold a package (the refill stand picker and the heads list), one row per table, by stand number.
 * Needs `request_pos_refill` OR `confirm_pos_heads` at the store: a phone that may do either needs to see the tables.
 */
export async function listRefillableTables(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const at = { storeId: input.storeId };
  if (!(await can(tx, actor, 'request_pos_refill', at)) && !(await can(tx, actor, 'confirm_pos_heads', at))) await authorize(tx, actor, 'request_pos_refill', at);
  // One row per table. A table may hold more than one package variant: `packageVariantIds` has every one (first line first), `packageVariantId` is the first.
  const byTable = new Map<string, { sessionId: string; standNumber: number; packageVariantId: string; packageVariantIds: string[]; seatFlavours: string[]; seatFlavourIds: string[]; headsCashier: number; headsServer: number | null }>();
  for (const r of await posV2Repo.listRefillableTables(tx, actor.orgId, input.storeId)) {
    if (r.packageVariantId === null) continue;
    const have = byTable.get(r.sessionId);
    if (!have) byTable.set(r.sessionId, { sessionId: r.sessionId, standNumber: r.standNumber, packageVariantId: r.packageVariantId, packageVariantIds: [r.packageVariantId], seatFlavours: addFlavours([], r.seatFlavours), seatFlavourIds: [...new Set(r.seatFlavourIds)], headsCashier: r.headsCashier, headsServer: r.headsServer });
    else {
      if (!have.packageVariantIds.includes(r.packageVariantId)) have.packageVariantIds.push(r.packageVariantId);
      addFlavours(have.seatFlavours, r.seatFlavours);
      for (const id of r.seatFlavourIds) if (!have.seatFlavourIds.includes(id)) have.seatFlavourIds.push(id);
    }
  }
  return { tables: [...byTable.values()] };
}

export async function listKitchenQueue(tx: Tx, actor: Actor, input: { storeId: string; stationId?: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const rows = await posV2Repo.listQueuedLines(tx, actor.orgId, input.storeId, input.stationId ? { stationId: uuidInput(input.stationId, 'The station') } : {});
  return { stateVersion: await stateVersionOf(tx, actor, input.storeId), tickets: rows.map(ticket) };
}

export async function listRefillQueue(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const rows = await posV2Repo.listQueuedLines(tx, actor.orgId, input.storeId, { refillsOnly: true });
  return { stateVersion: await stateVersionOf(tx, actor, input.storeId), tickets: rows.map(ticket) };
}

/** The sales receipts of the open Z window (before the first Z, all of them), newest first. */
export async function listTodaysSalesReceipts(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const since = await posV2Repo.lastDayCloseEnd(tx, actor.orgId, input.storeId);
  // T-601 S2: one query, every existing field plus the table, the till number and the tenders (additive).
  return receiptsView(tx, actor, input.storeId, await posV2Repo.listReceiptsSinceForList(tx, actor.orgId, input.storeId, since));
}

/**
 * T-613 D4 (DEF-937): "Find a receipt" - one receipt by its printed number (<store code>-<till, 2 digits>-<6 digits>; the store code may be left off), among the store's last
 * `pos.receipt_lookup_days` days, in the SAME shape as the list so the Refund dialog opens on it unchanged. A number that is not found (or is older) answers an empty list, not an error.
 * T-614 S2: the window is the business rule `pos.receipt_lookup_days` (default 30, set on Settings > Business rules); the Receipts screen reads the same rule to say it.
 */
export async function findSalesReceiptByNo(tx: Tx, actor: Actor, input: { storeId: string; receiptNo: string; now?: Date }) {
  await requireStoreScope(tx, actor, input.storeId);
  const lookupDays = await readReceiptLookupDays(tx, actor.orgId, toBusinessDate(input.now ?? new Date()));
  const parts = String(input.receiptNo ?? '').trim().toUpperCase().split('-');
  const seq = /^\d{1,6}$/.test(parts.at(-1) ?? '') ? Number(parts.at(-1)) : null;
  const till = /^\d{1,2}$/.test(parts.at(-2) ?? '') ? Number(parts.at(-2)) : null;
  const code = parts.slice(0, -2).join('-');
  const storeCode = ((await posV2Repo.getStoreCode(tx, actor.orgId, input.storeId)) ?? '').toUpperCase();
  const since = new Date((input.now ?? new Date()).getTime() - lookupDays * 86_400_000);
  const rows = seq === null || till === null || (code !== '' && code !== storeCode)
    ? []
    : await posV2Repo.listReceiptsSinceForList(tx, actor.orgId, input.storeId, since, { terminalNo: till, terminalSeq: seq });
  return receiptsView(tx, actor, input.storeId, rows);
}

async function receiptsView(tx: Tx, actor: Actor, storeId: string, rows: Awaited<ReturnType<typeof posV2Repo.listReceiptsSinceForList>>) {
  const input = { storeId };
  const storeCode = (await posV2Repo.getStoreCode(tx, actor.orgId, input.storeId)) ?? '';
  // T-534 S3: what each receipt was REALLY paid by after its wrong-payment-method corrections, and which paid rows can still give some up.
  const ids = rows.map((r) => r.receiptId);
  const payments = await posV2Repo.listPaymentRowsOfReceipts(tx, actor.orgId, ids);
  const corrections = await posV2Repo.listTenderCorrectionsOfReceipts(tx, actor.orgId, ids);
  const tenderRows = await posV1Repo.listTendersByStore(tx, actor.orgId, input.storeId);
  const tenderName = new Map(tenderRows.map((t) => [t.id, t.name]));
  const left = availableByPayment(payments, corrections);
  // T-534 S4: what each receipt still has to refund (items, then the money by paid row) and what was already refunded.
  const lines = await posV2Repo.listReceiptLines(tx, actor.orgId, ids);
  const refunds = await posV2Repo.listRefundsOfReceipts(tx, actor.orgId, ids);
  const refundLines = await posV2Repo.listRefundLinesOfReceipts(tx, actor.orgId, ids);
  const refundPays = await posV2Repo.listRefundPaymentsOfReceipts(tx, actor.orgId, ids);
  const receiptCharges = await posV2Repo.listReceiptCharges(tx, actor.orgId, ids); // T-627
  const refundRoutesOf = refundRoutes(payments, corrections, refundPays);
  const kindOf = new Map(tenderRows.map((t) => [t.id, t.kind as 'cash' | 'wallet']));
  return {
    stateVersion: await stateVersionOf(tx, actor, input.storeId),
    /** The store's active payment methods: what a correction can move money to. */
    tenders: tenderRows.filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, kind: t.kind as 'cash' | 'wallet' })),
    /** The signed-in person may approve a correction without a PIN. */
    canApprove: await can(tx, actor, 'approve_pos_correction', { storeId: input.storeId }),
    receipts: rows.map((r) => {
      const mine = corrections.filter((c) => c.receiptId === r.receiptId);
      const nets = tenderNetsAfterCorrections(
        payments.filter((p) => p.receiptId === r.receiptId).map((p) => ({ tenderId: p.tenderId, net: keptOf(p) })),
        mine,
      );
      return {
        receiptId: r.receiptId, sessionId: r.sessionId, terminalId: r.terminalId, terminalSeq: r.terminalSeq, issuedAtDevice: r.issuedAtDevice, subtotal: r.subtotal, discountTotal: r.discountTotal, total: r.total, offline: r.offline,
        /** T-627: the store charges on this receipt (outside `total`; the amount due was total + chargeTotal), and how much of them can still be refunded (worked out here). */
        chargeTotal: r.chargeTotal,
        charges: receiptCharges.filter((c) => c.receiptId === r.receiptId).map((c) => ({ name: c.name, qty: c.qty, amount: c.amount })),
        chargesLeft: String(fromCentavos(toCentavos(money(r.chargeTotal)) - refunds.filter((x) => x.parentReceiptId === r.receiptId).reduce((a, x) => a + toCentavos(money(x.chargesAmount)), 0n))),
        terminalNo: r.terminalNo,
        receiptNo: `${storeCode}-${pad(r.terminalNo, 2)}-${pad(r.terminalSeq, 6)}`,
        table: r.standNumber === null ? 'Take-out' : `Stand ${r.standNumber}`,
        // With corrections, the methods now holding money; otherwise the receipt's own methods, as before.
        tenders: mine.length === 0 ? (r.tenders ?? '') : [...nets.keys()].map((id) => tenderName.get(id) ?? 'Unknown tender').sort().join(' + '),
        corrected: mine.length > 0,
        /** Not yet in a Z: a wrong payment method can still be corrected. */
        canCorrect: r.dayCloseId === null,
        /** T-534 S4: the refunds of this receipt so far (newest last) and their total. */
        refunds: refunds.filter((x) => x.parentReceiptId === r.receiptId).map((x) => ({ refundNo: refundNoOf(storeCode, x.refundSeq), total: x.total })),
        refundedTotal: String(fromCentavos(refunds.filter((x) => x.parentReceiptId === r.receiptId).reduce((a, x) => a + toCentavos(money(x.total)), 0n))),
        /** The items, with how many can still be refunded and what each extra unit gives back (`amounts[q-1]` for q units), worked out here, never by the tablet. */
        lines: lines
          .filter((l) => l.receiptId === r.receiptId)
          .map((l) => {
            const done = refundLines.filter((x) => x.receiptLineId === l.id);
            const doneQty = done.reduce((a, x) => a + x.qty, 0);
            const amounts = refundAmountsOfLine(l, doneQty, done.reduce((a, x) => a + toCentavos(money(x.amount)), 0n));
            return { lineId: l.id, name: l.name, qty: l.qty, net: l.net, left: l.qty - doneQty, amounts };
          }),
        /** The ways the money can go back, in payment order (T-613 D1: a paid row's own method, then each method a correction moved part of it to), with what each can still take. `slotId` tells two ways of one paid row apart. */
        refundPayments: refundRoutesOf
          .filter((x) => payments.some((p) => p.receiptId === r.receiptId && p.id === x.paymentId))
          .map((x) => ({ slotId: `${x.paymentId}:${x.tenderId}`, paymentId: x.paymentId, tenderId: x.tenderId, tenderName: tenderName.get(x.tenderId) ?? 'Unknown tender', kind: kindOf.get(x.tenderId) ?? 'wallet', left: String(fromCentavos(x.left)) })),
        payments: payments
          .filter((p) => p.receiptId === r.receiptId)
          .map((p) => ({ paymentId: p.id, tenderId: p.tenderId, tenderName: tenderName.get(p.tenderId) ?? 'Unknown tender', left: String(fromCentavos(left.get(p.id) ?? 0n)) })),
      };
    }),
  };
}
