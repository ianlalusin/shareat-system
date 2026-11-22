/**
 * T-628 - table reservations with deposits on POS v2. docs/tasks/628-pos-reservations-deposits.md; bible row 463 (Ian, 13 Nov: voiding a deposit needs the manager PIN and
 * is refused once applied) and Ian's 22 Nov ruling (on a cancel or a no-show the MANAGER decides each time: refund or keep).
 *
 * ## What it is
 * A reservation holds a table for a customer (name, phone, party size, time, optional stand). Money taken in advance is a stream of APPEND-ONLY events
 * (`pos_reservation_deposits`: taken / voided / applied / refunded / kept); the held balance is derived from them, never stored. The books:
 *   taken     Dr the money place (cash 1110 / a wallet's 1140) / Cr 2170 Customer deposits payable           (at the Z of the till that took it)
 *   voided    Dr 2170 / Cr the money place it was taken into                                                  (same Z path)
 *   refunded  Dr 2170 / Cr the money place it goes back by                                                    (same Z path)
 *   kept      Dr 2170 / Cr 4500 other income                                                                  (same Z path)
 *   applied   Dr 2170 through the SALES DAY of the Z (a tender of the sale: `sales_days.deposits_applied`, routed by `routeSalesDay`)
 * No separate journal flow: the cash-moving kinds post beside the Z exactly as a Convert does (`postDepositsForZ`), the applied one rides the day's own entry.
 *
 * ## The rules that are easy to get wrong
 *  - Who: creating a reservation, taking a deposit, seating, cancelling and marking a no-show are `record_sale` acts and work OFFLINE (inbox events, idempotent on their ids).
 *    VOID, REFUND and KEEP need a manager's PIN (or a signed-in `approve_pos_correction` holder, the refund pattern `postSaleApprover`), a reason, and the internet: they are API calls
 *    with no outbox kind, so an offline tablet cannot send them. Each goes through `authorize()` first.
 *  - A void is refused once any deposit of the reservation was applied (the DATABASE refuses it too, 0276 pos_reservation_deposits_guard).
 *  - Applying is consume-once: one applied row per reservation and per receipt (partial uniques). `completeSale` (sale.ts) writes it; a second apply is refused in words
 *    and, offline, arrives later as a quarantined sale (the existing quarantine flow).
 *  - A reservation closes only at a zero held balance (the DATABASE refuses a close with money held, 0276 pos_reservations_guard): a cancelled or no-show reservation with money held
 *    cannot close without a refund or a keep, each with a reason.
 *  - Money moves under the store's Z lock (`lockPosDayClose`) and a row lock on the reservation, so a Z never freezes figures a manager action is about to change.
 */
import { authorize, type Actor } from '@shareat/auth';
import { compare, fromCentavos, money, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { advisoryLocksRepo, journalRepo, moneyAccountsRepo, posV1Repo, posV2Repo, type Tx } from '@shareat/db';
import { buildPeriodFacts, periodRefusal } from '../business-rules';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { assertFieldRules } from '../shared/field-rules-assert';
import { gone, refuse } from '../shared/refusal';
import { parseMoneyInput } from '../shared/money-input';
import { POS_PAYMENT_REFERENCE_RULES, POS_REASON_RULES, POS_RESERVATION_RULES } from '../field-rules/pos';
import { usableTender } from './convert';
import { postSaleApprover } from './tender-correction';
import { audit, deviceTime, recordedDifferently, requireContext, requireStoreScope, uuidInput, uuidv5, wholeNumber, type PosDeps } from './shared';

// ---------------------------------------------------------------------------------------------------------------------
// Sentences and limits
// ---------------------------------------------------------------------------------------------------------------------
/** A typo guard on one deposit, not a business setting (the same kind of cap as a charge's); a bigger deposit is taken as several. */
export const DEPOSIT_AMOUNT_MAX = '1000000.00';
export const DEPOSIT_AMOUNT_MAX_SENTENCE = 'A single deposit can be at most 1,000,000 pesos.';
export const DEPOSIT_NOT_TAKEN_NOW = 'Only a booked or seated reservation can take a deposit.';
export const DEPOSIT_VOID_AFTER_APPLY = 'This deposit was already used on a bill, so it cannot be voided.';
export const DEPOSIT_ALREADY_USED = 'This reservation’s deposit was already used on a bill.';
export const DEPOSIT_NOT_THIS_TABLE = 'This deposit belongs to another table.';
export const DEPOSIT_MORE_THAN_HELD = 'That is more than the reservation holds.';
export const DEPOSIT_MORE_THAN_BILL = 'The deposit cannot be more than the bill.';
export const RESERVATION_CLOSE_WITH_MONEY = 'This reservation still holds a deposit. A manager must refund it or keep it, with a reason, before it can be closed.';
export const RESERVATION_NEEDS_CHOICE = 'Choose what happens to the deposit: refund it or keep it.';

type Reservation = posV2Repo.PosReservationRow;
type Deposit = posV2Repo.PosReservationDepositRow;

// ---------------------------------------------------------------------------------------------------------------------
// The figures (pure)
// ---------------------------------------------------------------------------------------------------------------------
/**
 * What a Z, an X or a handover shows for reservation deposits. `taken`, `voided`, `refunded` are the money that moved by any method in the window; `kept` moved nothing (it is the
 * business keeping money already held); `applied` is what the window's bills were paid from held deposits. `cashNet` = cash taken - cash voided - cash refunded = the change in the
 * drawer, so the count matches the day the cash moved (the same idea as a Convert's `net`).
 */
export interface DepositBlock {
  taken: Money;
  voided: Money;
  refunded: Money;
  kept: Money;
  applied: Money;
  cashNet: Money;
  /** Cash-moving events in the window (taken, voided, refunded, kept). */
  count: number;
}
export const NO_DEPOSITS: DepositBlock = { taken: ZERO, voided: ZERO, refunded: ZERO, kept: ZERO, applied: ZERO, cashNet: ZERO, count: 0 };

/** The block of a window's cash-moving events and the sum its bills took from deposits. */
export function depositBlockOf(events: readonly Pick<Deposit, 'kind' | 'amount' | 'tenderId'>[], applied: Money, tenderKind: ReadonlyMap<string, 'cash' | 'wallet'>): DepositBlock {
  const sum = { taken: 0n, voided: 0n, refunded: 0n, kept: 0n };
  let cash = 0n;
  for (const e of events) {
    if (e.kind === 'applied') continue; // belongs to its receipt's Z, never counted here
    const cents = toCentavos(money(e.amount));
    sum[e.kind as 'taken' | 'voided' | 'refunded' | 'kept'] += cents;
    if (e.tenderId !== null && tenderKind.get(e.tenderId) === 'cash') cash += e.kind === 'taken' ? cents : e.kind === 'kept' ? 0n : -cents;
  }
  return {
    taken: fromCentavos(sum.taken),
    voided: fromCentavos(sum.voided),
    refunded: fromCentavos(sum.refunded),
    kept: fromCentavos(sum.kept),
    applied,
    cashNet: fromCentavos(cash),
    count: events.filter((e) => e.kind !== 'applied').length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// createReservation (offline event `reservation.created`)
// ---------------------------------------------------------------------------------------------------------------------
export interface CreateReservationInput {
  storeId: string;
  pairingId: string | null;
  /** Device-made uuid: the row's id, so a replay is the same reservation. */
  reservationId: string;
  customerName: string;
  phone?: string | null;
  partySize: number;
  reservedFor: string | Date;
  standId?: string | null;
  note?: string | null;
  createdAtDevice: string | Date;
}

export async function createReservation(tx: Tx, actor: Actor, input: CreateReservationInput): Promise<{ wrote: boolean; id: string }> {
  const { storeId } = input;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = await requireContext(tx, actor, storeId, input.pairingId, false);
  const id = uuidInput(input.reservationId, 'The reservation id');
  const f = assertFieldRules(POS_RESERVATION_RULES, { customerName: input.customerName ?? '', phone: input.phone ?? '', note: input.note ?? '' });
  const partySize = wholeNumber(input.partySize, { what: 'The party size', min: 1, max: 500 });
  const reservedFor = deviceTime(input.reservedFor, 'The reservation time');
  const at = deviceTime(input.createdAtDevice, 'The time of the booking');
  const standId = input.standId ? uuidInput(input.standId, 'The table') : null;

  const prior = await posV2Repo.getReservation(tx, actor.orgId, storeId, id);
  if (prior) {
    const same = prior.customerName === f.customerName && (prior.phone ?? null) === (f.phone ?? null) && prior.partySize === partySize && prior.reservedFor.getTime() === reservedFor.getTime() && prior.standId === standId;
    if (same) return { wrote: false, id };
    throw recordedDifferently();
  }
  if (standId && !(await posV2Repo.getStand(tx, actor.orgId, storeId, standId))) throw refuse('pos: reservation stand not at this store', 'That table is not at this store.');
  await posV2Repo.insertReservation(tx, {
    id, orgId: actor.orgId, storeId, customerName: f.customerName!, phone: f.phone ?? null, partySize, reservedFor, standId, note: f.note ?? null, createdBy: actor.personId, createdAtDevice: at,
  });
  await audit(tx, actor, 'pos.reservation_created', {
    storeId, entityId: id, pairingId, at, before: null,
    after: { partySize, reservedFor: reservedFor.toISOString(), standId, hasPhone: f.phone !== undefined && f.phone !== null && f.phone !== '' },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, storeId);
  return { wrote: true, id };
}

// ---------------------------------------------------------------------------------------------------------------------
// takeDeposit (offline event `deposit.taken`)
// ---------------------------------------------------------------------------------------------------------------------
export interface TakeDepositInput {
  storeId: string;
  pairingId: string | null;
  /** Device-made uuid: the event's id, so a replay is the same deposit. */
  depositId: string;
  reservationId: string;
  tenderId: string;
  amount: string;
  /** Required for a wallet (4 to 40 characters), as at payment. */
  referenceNo?: string | null;
  occurredAtDevice: string | Date;
}

function depositAmount(raw: unknown): Money {
  const amount = parseMoneyInput(String(raw ?? ''), 'pos: the deposit amount', 'The deposit amount');
  if (compare(amount, ZERO) <= 0) throw refuse('pos: deposit amount not above zero', 'The deposit must be more than zero.');
  if (compare(amount, money(DEPOSIT_AMOUNT_MAX)) > 0) throw refuse('pos: deposit over the cap', DEPOSIT_AMOUNT_MAX_SENTENCE);
  return amount;
}

/** The wallet's reference (4 to 40 characters) or null for cash. */
function referenceOf(kind: string, raw: unknown): string | null {
  return kind === 'wallet' ? assertFieldRules(POS_PAYMENT_REFERENCE_RULES, { referenceNo: typeof raw === 'string' ? raw : '' }).referenceNo! : null;
}

export async function takeDeposit(tx: Tx, actor: Actor, input: TakeDepositInput): Promise<{ wrote: boolean; id: string }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = (await requireContext(tx, actor, storeId, input.pairingId, false))!;
  const id = uuidInput(input.depositId, 'The deposit id');
  const reservationId = uuidInput(input.reservationId, 'The reservation');
  const tenderId = uuidInput(input.tenderId, 'The payment method');
  const amount = depositAmount(input.amount);
  const at = deviceTime(input.occurredAtDevice, 'The time of the deposit');

  const prior = await posV2Repo.getDeposit(tx, orgId, storeId, id);
  if (prior) {
    const same = prior.kind === 'taken' && prior.reservationId === reservationId && prior.tenderId === tenderId && toCentavos(money(prior.amount)) === toCentavos(amount);
    if (same) return { wrote: false, id };
    throw recordedDifferently();
  }
  const tender = usableTender(await posV1Repo.listTendersByStore(tx, orgId, storeId), tenderId);
  const referenceNo = referenceOf(tender.kind, input.referenceNo);
  const terminal = await posV2Repo.getTerminalForPairing(tx, orgId, storeId, pairingId);
  if (!terminal) throw refuse('pos: no till for this tablet', 'This tablet is not set up as a till yet. Ask a manager.');
  const reservation = await posV2Repo.getReservation(tx, orgId, storeId, reservationId, { forUpdate: true });
  if (!reservation) throw gone(`pos: reservation ${reservationId} not found`, 'that reservation');
  if (reservation.status !== 'booked' && reservation.status !== 'seated') throw refuse(`pos: a ${reservation.status} reservation takes no deposit`, DEPOSIT_NOT_TAKEN_NOW);
  await posV2Repo.insertDeposit(tx, {
    id, orgId, storeId, reservationId, kind: 'taken', amount, tenderId, referenceNo, terminalId: terminal.id, receiptId: null, voidsDepositId: null, reason: null,
    recordedBy: actor.personId, approvedBy: null, occurredAtDevice: at,
  });
  await audit(tx, actor, 'pos.deposit_taken', {
    storeId, entityId: id, pairingId, at, before: null,
    after: { reservationId, tenderId, amount: String(amount), hasReference: referenceNo !== null },
  });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true, id };
}

// ---------------------------------------------------------------------------------------------------------------------
// seat / cancel / no-show (offline events `reservation.seated`, `reservation.status_set`)
// ---------------------------------------------------------------------------------------------------------------------
export interface SeatReservationInput {
  storeId: string;
  pairingId: string | null;
  reservationId: string;
  /** The table session the party was seated at (opened as usual, `stand.opened`). */
  sessionId: string;
  seatedAtDevice: string | Date;
}

export async function seatReservation(tx: Tx, actor: Actor, input: SeatReservationInput): Promise<{ wrote: boolean }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = await requireContext(tx, actor, storeId, input.pairingId, false);
  const reservationId = uuidInput(input.reservationId, 'The reservation');
  const sessionId = uuidInput(input.sessionId, 'The table');
  const at = deviceTime(input.seatedAtDevice, 'The time of seating');
  const reservation = await posV2Repo.getReservation(tx, orgId, storeId, reservationId, { forUpdate: true });
  if (!reservation) throw gone(`pos: reservation ${reservationId} not found`, 'that reservation');
  if (reservation.status === 'seated' && reservation.sessionId === sessionId) return { wrote: false };
  if (reservation.status !== 'booked') throw refuse(`pos: a ${reservation.status} reservation cannot be seated`, 'Only a booked reservation can be seated.');
  const session = await posV2Repo.getTableSession(tx, orgId, storeId, sessionId);
  if (!session) throw gone(`pos: table session ${sessionId} not found`, 'table');
  if (session.status !== 'open') throw refuse(`pos: session is ${session.status}`, 'That table is not open.');
  if (await posV2Repo.getReservationBySession(tx, orgId, storeId, sessionId)) throw refuse('pos: table already holds a reservation', 'That table is already linked to another reservation.');
  if ((await posV2Repo.updateReservation(tx, orgId, storeId, reservationId, { status: 'seated', sessionId, standId: session.standId, updatedAt: at })) === 0) throw refuse('pos: seat raced', 'This reservation just changed. Look again.');
  await audit(tx, actor, 'pos.reservation_status_set', { storeId, entityId: reservationId, pairingId, at, before: { status: 'booked' }, after: { status: 'seated', sessionId } });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true };
}

export interface SetReservationStatusInput {
  storeId: string;
  pairingId: string | null;
  reservationId: string;
  status: 'cancelled' | 'no_show';
  atDevice: string | Date;
}

/** Cancel (a booked or seated reservation) or mark a no-show (a booked one). Money held stays held: a manager settles it (`closeReservation`). */
export async function setReservationStatus(tx: Tx, actor: Actor, input: SetReservationStatusInput): Promise<{ wrote: boolean }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = await requireContext(tx, actor, storeId, input.pairingId, false);
  const reservationId = uuidInput(input.reservationId, 'The reservation');
  if (input.status !== 'cancelled' && input.status !== 'no_show') throw refuse('pos: reservation status not allowed', 'A reservation can be cancelled or marked a no-show.');
  const at = deviceTime(input.atDevice, 'The time of the change');
  const reservation = await posV2Repo.getReservation(tx, orgId, storeId, reservationId, { forUpdate: true });
  if (!reservation) throw gone(`pos: reservation ${reservationId} not found`, 'that reservation');
  if (reservation.status === input.status) return { wrote: false };
  const ok = reservation.status === 'booked' || (reservation.status === 'seated' && input.status === 'cancelled');
  if (!ok) throw refuse(`pos: ${reservation.status} -> ${input.status}`, `A ${reservation.status.replace('_', '-')} reservation cannot be ${input.status === 'cancelled' ? 'cancelled' : 'marked a no-show'}.`);
  if ((await posV2Repo.updateReservation(tx, orgId, storeId, reservationId, { status: input.status, updatedAt: at })) === 0) throw refuse('pos: status raced', 'This reservation just changed. Look again.');
  await audit(tx, actor, 'pos.reservation_status_set', { storeId, entityId: reservationId, pairingId, at, before: { status: reservation.status }, after: { status: input.status } });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// The manager's three money actions (online only; no outbox kind): void, refund, keep
// ---------------------------------------------------------------------------------------------------------------------
interface ManagerInput {
  storeId: string;
  /** The tablet: the money comes out of (or the keep is booked at) its till. */
  pairingId: string | null;
  /** Device-made uuid: the event's id, so a retry is the same event. */
  depositId: string;
  reservationId: string;
  reason: string;
  /** The manager's PIN. Not needed when the signed-in person already holds `approve_pos_correction` at the store (the refund pattern). */
  approval?: { pin: string };
}

/** The common head: capability, tablet, ids, reason. Returns what every manager action needs, before the approver is judged. */
async function managerHead(tx: Tx, actor: Actor, input: ManagerInput) {
  const { storeId } = input;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = (await requireContext(tx, actor, storeId, input.pairingId, false))!;
  return {
    pairingId,
    id: uuidInput(input.depositId, 'The deposit id'),
    reservationId: uuidInput(input.reservationId, 'The reservation'),
    reason: assertFieldRules(POS_REASON_RULES, { reason: input.reason }).reason!,
  };
}

/** The locks every manager action takes, in the Z's order: the store's Z lock, then the reservation row. */
async function lockedReservation(tx: Tx, actor: Actor, storeId: string, reservationId: string): Promise<Reservation> {
  await advisoryLocksRepo.lockPosDayClose(tx, storeId);
  const r = await posV2Repo.getReservation(tx, actor.orgId, storeId, reservationId, { forUpdate: true });
  if (!r) throw gone(`pos: reservation ${reservationId} not found`, 'that reservation');
  return r;
}

export interface VoidDepositInput extends ManagerInput {
  /** The taken deposit being voided (the whole of it: a void is for a mistake, a part goes back by a refund). */
  voidsDepositId: string;
}

export async function voidDeposit(tx: Tx, actor: Actor, input: VoidDepositInput): Promise<{ wrote: boolean; id: string }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  const head = await managerHead(tx, actor, input);
  const voidsId = uuidInput(input.voidsDepositId, 'The deposit');
  const prior = await posV2Repo.getDeposit(tx, orgId, storeId, head.id);
  if (prior) {
    if (prior.kind === 'voided' && prior.voidsDepositId === voidsId && prior.reservationId === head.reservationId) return { wrote: false, id: head.id };
    throw recordedDifferently();
  }
  const approverId = await postSaleApprover(tx, actor, storeId, input.approval?.pin);
  await lockedReservation(tx, actor, storeId, head.reservationId);
  const events = await posV2Repo.listDepositsOfReservation(tx, orgId, storeId, head.reservationId);
  if (events.some((e) => e.kind === 'applied')) throw refuse('pos: void after the deposit was applied', DEPOSIT_VOID_AFTER_APPLY);
  const taken = events.find((e) => e.id === voidsId && e.kind === 'taken');
  if (!taken) throw gone(`pos: deposit ${voidsId} is not a taken deposit of reservation ${head.reservationId}`, 'that deposit');
  if (events.some((e) => e.kind === 'voided' && e.voidsDepositId === voidsId)) throw refuse('pos: deposit already voided', 'That deposit was already voided.');
  const terminal = await posV2Repo.getTerminalForPairing(tx, orgId, storeId, head.pairingId);
  if (!terminal) throw refuse('pos: no till for this tablet', 'This tablet is not set up as a till yet. Ask a manager.');
  const at = new Date();
  await posV2Repo.insertDeposit(tx, {
    id: head.id, orgId, storeId, reservationId: head.reservationId, kind: 'voided', amount: money(taken.amount), tenderId: taken.tenderId, referenceNo: taken.referenceNo, terminalId: terminal.id,
    receiptId: null, voidsDepositId: voidsId, reason: head.reason, recordedBy: actor.personId, approvedBy: approverId, occurredAtDevice: at,
  });
  await audit(tx, actor, 'pos.deposit_voided', { storeId, entityId: head.id, pairingId: head.pairingId, at, before: { voids: voidsId }, after: { reservationId: head.reservationId, amount: taken.amount, reason: head.reason, approvedBy: approverId } });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true, id: head.id };
}

export interface RefundDepositInput extends ManagerInput {
  amount: string;
  /** The method the money goes back by (a wallet needs `referenceNo`). */
  tenderId: string;
  referenceNo?: string | null;
}

export async function refundDeposit(tx: Tx, actor: Actor, input: RefundDepositInput): Promise<{ wrote: boolean; id: string }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  const head = await managerHead(tx, actor, input);
  const amount = depositAmount(input.amount);
  const tenderId = uuidInput(input.tenderId, 'The payment method');
  const prior = await posV2Repo.getDeposit(tx, orgId, storeId, head.id);
  if (prior) {
    if (prior.kind === 'refunded' && prior.reservationId === head.reservationId && prior.tenderId === tenderId && toCentavos(money(prior.amount)) === toCentavos(amount)) return { wrote: false, id: head.id };
    throw recordedDifferently();
  }
  const tender = usableTender(await posV1Repo.listTendersByStore(tx, orgId, storeId), tenderId);
  const referenceNo = referenceOf(tender.kind, input.referenceNo);
  const approverId = await postSaleApprover(tx, actor, storeId, input.approval?.pin);
  await lockedReservation(tx, actor, storeId, head.reservationId);
  const held = money(await posV2Repo.heldOfReservation(tx, orgId, storeId, head.reservationId));
  if (compare(amount, held) > 0) throw refuse(`pos: refund ${amount} over the ${held} held`, `${DEPOSIT_MORE_THAN_HELD} It holds ₱${held}.`);
  const terminal = await posV2Repo.getTerminalForPairing(tx, orgId, storeId, head.pairingId);
  if (!terminal) throw refuse('pos: no till for this tablet', 'This tablet is not set up as a till yet. Ask a manager.');
  const at = new Date();
  await posV2Repo.insertDeposit(tx, {
    id: head.id, orgId, storeId, reservationId: head.reservationId, kind: 'refunded', amount, tenderId, referenceNo, terminalId: terminal.id, receiptId: null, voidsDepositId: null,
    reason: head.reason, recordedBy: actor.personId, approvedBy: approverId, occurredAtDevice: at,
  });
  await audit(tx, actor, 'pos.deposit_refunded', { storeId, entityId: head.id, pairingId: head.pairingId, at, before: null, after: { reservationId: head.reservationId, tenderId, amount: String(amount), reason: head.reason, approvedBy: approverId } });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true, id: head.id };
}

export interface KeepDepositInput extends ManagerInput {
  amount: string;
}

/** The business keeps money already held (a no-show, a late cancel): Dr 2170 / Cr 4500 at the Z. Moves no cash. */
export async function keepDeposit(tx: Tx, actor: Actor, input: KeepDepositInput): Promise<{ wrote: boolean; id: string }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  const head = await managerHead(tx, actor, input);
  const amount = depositAmount(input.amount);
  const prior = await posV2Repo.getDeposit(tx, orgId, storeId, head.id);
  if (prior) {
    if (prior.kind === 'kept' && prior.reservationId === head.reservationId && toCentavos(money(prior.amount)) === toCentavos(amount)) return { wrote: false, id: head.id };
    throw recordedDifferently();
  }
  const approverId = await postSaleApprover(tx, actor, storeId, input.approval?.pin);
  await lockedReservation(tx, actor, storeId, head.reservationId);
  const held = money(await posV2Repo.heldOfReservation(tx, orgId, storeId, head.reservationId));
  if (compare(amount, held) > 0) throw refuse(`pos: keep ${amount} over the ${held} held`, `${DEPOSIT_MORE_THAN_HELD} It holds ₱${held}.`);
  const terminal = await posV2Repo.getTerminalForPairing(tx, orgId, storeId, head.pairingId);
  if (!terminal) throw refuse('pos: no till for this tablet', 'This tablet is not set up as a till yet. Ask a manager.');
  const at = new Date();
  await posV2Repo.insertDeposit(tx, {
    id: head.id, orgId, storeId, reservationId: head.reservationId, kind: 'kept', amount, tenderId: null, referenceNo: null, terminalId: terminal.id, receiptId: null, voidsDepositId: null,
    reason: head.reason, recordedBy: actor.personId, approvedBy: approverId, occurredAtDevice: at,
  });
  await audit(tx, actor, 'pos.deposit_kept', { storeId, entityId: head.id, pairingId: head.pairingId, at, before: null, after: { reservationId: head.reservationId, amount: String(amount), reason: head.reason, approvedBy: approverId } });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true, id: head.id };
}

export interface CloseReservationInput {
  storeId: string;
  pairingId: string | null;
  reservationId: string;
  /**
   * Needed when money is still held: what happens to ALL of it. `refund` goes back by `tenderId` (a wallet needs `referenceNo`); `keep` is booked as other income.
   * Each is the manager's act, with a reason, and writes its own event (`refundId` / `keepId`, device-made uuids so a retry is the same close).
   */
  resolution?: { choice: 'refund' | 'keep'; eventId: string; reason: string; tenderId?: string; referenceNo?: string | null };
  approval?: { pin: string };
}

/**
 * Closes a reservation. At a zero held balance it just closes (the DATABASE refuses it otherwise). With money held, `resolution` says refund or keep of the whole balance; without
 * one the close is refused in words. A booked reservation cannot be closed (cancel it first).
 */
export async function closeReservation(tx: Tx, actor: Actor, input: CloseReservationInput): Promise<{ wrote: boolean }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = (await requireContext(tx, actor, storeId, input.pairingId, false))!;
  const reservationId = uuidInput(input.reservationId, 'The reservation');
  const peek = await posV2Repo.getReservation(tx, orgId, storeId, reservationId);
  if (!peek) throw gone(`pos: reservation ${reservationId} not found`, 'that reservation');
  if (peek.status === 'closed') return { wrote: false };
  if (peek.status === 'booked') throw refuse('pos: a booked reservation cannot be closed', 'Cancel or seat this reservation first.');
  const held0 = money(await posV2Repo.heldOfReservation(tx, orgId, storeId, reservationId));
  if (compare(held0, ZERO) > 0) {
    const r = input.resolution;
    if (!r) throw refuse('pos: close with money held and no choice', `${RESERVATION_CLOSE_WITH_MONEY} ${RESERVATION_NEEDS_CHOICE}`);
    const base = { storeId, pairingId, depositId: r.eventId, reservationId, reason: r.reason, amount: String(held0), ...(input.approval ? { approval: input.approval } : {}) };
    if (r.choice === 'refund') {
      if (typeof r.tenderId !== 'string') throw refuse('pos: refund without a method', 'Say how the money goes back.');
      await refundDeposit(tx, actor, { ...base, tenderId: r.tenderId, referenceNo: r.referenceNo ?? null });
    } else if (r.choice === 'keep') {
      await keepDeposit(tx, actor, base);
    } else {
      throw refuse('pos: unknown resolution', RESERVATION_NEEDS_CHOICE);
    }
  }
  const at = new Date();
  await lockedReservation(tx, actor, storeId, reservationId);
  if ((await posV2Repo.updateReservation(tx, orgId, storeId, reservationId, { status: 'closed', updatedAt: at, closedAt: at })) === 0) throw refuse('pos: close raced', 'This reservation just changed. Look again.');
  await audit(tx, actor, 'pos.reservation_status_set', { storeId, entityId: reservationId, pairingId, at, before: { status: peek.status }, after: { status: 'closed' } });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------
export interface ReservationView {
  id: string;
  customerName: string;
  phone: string | null;
  partySize: number;
  reservedFor: string;
  standId: string | null;
  note: string | null;
  status: Reservation['status'];
  sessionId: string | null;
  /** Money still held, decimal text. */
  held: string;
}

const viewOf = (x: posV2Repo.ReservationWithHeld): ReservationView => ({
  id: x.reservation.id,
  customerName: x.reservation.customerName,
  phone: x.reservation.phone,
  partySize: x.reservation.partySize,
  reservedFor: x.reservation.reservedFor.toISOString(),
  standId: x.reservation.standId,
  note: x.reservation.note,
  status: x.reservation.status,
  sessionId: x.reservation.sessionId,
  held: x.held,
});

/** What the tablet keeps for offline use (the snapshot): the store's reservations that still matter, soonest first. Judged by the caller's store scope; no capability beyond it. */
export async function listReservationsForTablet(tx: Tx, orgId: string, storeId: string, now: Date): Promise<ReservationView[]> {
  const since = new Date(now.getTime() - 36 * 3_600_000);
  return (await posV2Repo.listReservationsWithHeld(tx, orgId, storeId, since)).filter((x) => x.reservation.status !== 'closed').map(viewOf);
}

/** The office's read-only list (ERP): reservations and the money held per store. A manager who may approve a POS correction here; editing stays on the POS. */
export async function listReservationsForOffice(tx: Tx, actor: Actor, input: { storeId: string; since?: Date }, deps?: PosDeps): Promise<{ reservations: (ReservationView & { createdByName: string })[] }> {
  await requireStoreScope(tx, actor, input.storeId);
  await authorize(tx, actor, 'approve_pos_correction', { storeId: input.storeId });
  const now = deps?.now ? deps.now() : new Date();
  const rows = await posV2Repo.listReservationsWithHeld(tx, actor.orgId, input.storeId, input.since ?? new Date(now.getTime() - 30 * 86_400_000));
  const names = await posV2Repo.listPersonNames(tx, actor.orgId, rows.map((r) => r.reservation.createdBy));
  return { reservations: rows.map((r) => ({ ...viewOf(r), createdByName: names.get(r.reservation.createdBy) ?? '' })) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The books, at the Z
// ---------------------------------------------------------------------------------------------------------------------
type Tender = posV1Repo.TenderRow;

/**
 * POSTING-PATTERNS `deposit.taken`, `deposit.voided`, `deposit.refunded`, `deposit.kept`: the cash-moving deposit events of a Z post beside its sales day (the Convert path), one entry per
 * kind per money place, dated the Z's business date, store-scoped:
 *   taken    Dr the money place / Cr 2170        voided and refunded   Dr 2170 / Cr the money place        kept   Dr 2170 / Cr 4500
 * Cash is the cashier's till (1110), a wallet is 1140 with its money account as party. Key `pos_deposit:<closeId>:<kind>:<place>`: a replay writes nothing twice. Called by the Z for a
 * LIVE store only (test mode never books), inside the close's transaction: a refusal rolls the whole close back. `applied` is not here: it rides the sales day (`depositsApplied`).
 */
export async function postDepositsForZ(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; closeId: string; businessDate: string; events: readonly Deposit[]; tenders: readonly Tender[] },
): Promise<string[]> {
  const { orgId } = actor;
  const byId = new Map(input.tenders.map((t) => [t.id, t]));
  // kind -> place key -> centavos
  const groups = new Map<string, { kind: 'taken' | 'voided' | 'refunded' | 'kept'; place: string; tender: Tender | null; cents: bigint }>();
  for (const e of input.events) {
    if (e.kind === 'applied') continue;
    const tender = e.tenderId ? (byId.get(e.tenderId) ?? null) : null;
    if (e.kind !== 'kept' && !tender) throw refuse(`pos: deposit tender ${e.tenderId} is not a tender of store ${input.storeId}`, 'A deposit method of this day is no longer available. An admin must restore it before the day can be closed.');
    const place = e.kind === 'kept' ? '4500' : tender!.kind === 'cash' ? 'cash' : (tender!.moneyAccountId ?? '');
    const key = `${e.kind}:${place}`;
    const cur = groups.get(key) ?? { kind: e.kind, place, tender, cents: 0n };
    cur.cents += toCentavos(money(e.amount));
    groups.set(key, cur);
  }
  if (groups.size === 0) return [];
  const month = periodRefusal(buildPeriodFacts(await journalRepo.findPeriodForDate(tx, orgId, input.businessDate)), { override: false });
  if (month) throw refuse(`pos: the fiscal period covering ${input.businessDate} is ${month.kind}`, month.sentence);
  const side = async (g: { kind: string; tender: Tender | null }): Promise<Pick<PostEntryLine, 'accountCode' | 'partyType' | 'partyId'>> => {
    if (g.kind === 'kept') return { accountCode: '4500' };
    const t = g.tender!;
    if (t.kind === 'cash') return { accountCode: '1110' };
    const account = t.moneyAccountId ? await moneyAccountsRepo.getById(tx, orgId, t.moneyAccountId) : undefined;
    if (!account || !account.isActive) {
      throw refuse(`pos: money account of tender ${t.id} is retired or missing`, `${t.name}'s money account is no longer active, so this day can't be closed. An admin sets ${t.name}'s account under Settings › POS link.`);
    }
    return { accountCode: '1140', partyType: 'money_account', partyId: account.id };
  };
  const entries: string[] = [];
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const amount = String(fromCentavos(g.cents));
    const other = await side(g);
    const deposits = { accountCode: '2170' };
    const [debit, credit] = g.kind === 'taken' ? [other, deposits] : [deposits, other];
    const label = g.kind === 'taken' ? 'taken' : g.kind === 'voided' ? 'voided' : g.kind === 'refunded' ? 'refunded' : 'kept';
    const posted = await postEntry(tx, {
      orgId,
      entryDate: input.businessDate,
      sourceType: 'pos_deposit',
      sourceId: uuidv5(key, input.closeId),
      idempotencyKey: `pos_deposit:${input.closeId}:${key}`,
      memo: `Reservation deposits ${label}${g.tender ? ` - ${g.tender.name}` : ''} - ${input.businessDate}`,
      postedBy: actor.personId,
      lines: [
        { ...debit, storeId: input.storeId, debit: amount },
        { ...credit, storeId: input.storeId, credit: amount },
      ],
    });
    entries.push(posted.entryId);
  }
  return entries;
}
