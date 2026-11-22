/**
 * T-628 - the pure half of the POS Reservations tab: the offline events it makes (one outbox event per tap, like Orders), the checks that mirror the server's sentences,
 * the deposit slip, and the list order. No React, no clock, no network: every dependency arrives in an argument. docs/tasks/628-pos-reservations-deposits.md.
 * The server decides everything (`packages/domain/src/pos/reservations.ts`); change a rule there first.
 */
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import { checkAll, POS_PAYMENT_REFERENCE_RULES, POS_RESERVATION_RULES } from '@shareat/domain/field-rules';
import type { NewPosEvent } from '@/lib/pos-device';
import { receiptHeaderOf, type DepositSlipView } from '@/lib/pos-print';

export type ReservationStatus = 'booked' | 'seated' | 'cancelled' | 'no_show' | 'closed';
/** One reservation as the snapshot carries it (`ReservationView` of the domain). */
export interface ReservationRow {
  id: string;
  customerName: string;
  phone: string | null;
  partySize: number;
  reservedFor: string;
  standId: string | null;
  note: string | null;
  status: ReservationStatus;
  sessionId: string | null;
  /** Money still held, decimal text. */
  held: string;
}
export interface DepositTender {
  id: string;
  name: string;
  kind: string;
}

export const DEPOSIT_MAX_CENTAVOS = 100_000_000n;
export const SENTENCES = {
  name: 'Enter the customer name (up to 60 characters).',
  party: 'The party size must be a whole number from 1 to 500.',
  time: 'Pick the date and time of the reservation.',
  amount: 'The deposit must be more than zero.',
  amountMax: 'A single deposit can be at most 1,000,000 pesos.',
  pickTender: 'Pick how the deposit is paid.',
  manager: 'A manager settles the deposit, and that needs the internet.',
  reasonShort: 'Give a reason of 3 to 200 characters.',
} as const;

/** The status as the list prints it. */
export const statusLabel = (s: ReservationStatus): string => ({ booked: 'Booked', seated: 'Seated', cancelled: 'Cancelled', no_show: 'No-show', closed: 'Closed' })[s];

/** A reservation whose money a manager still has to settle: cancelled or no-show with a deposit held. */
export const needsSettling = (r: Pick<ReservationRow, 'status' | 'held'>): boolean => (r.status === 'cancelled' || r.status === 'no_show') && toCentavos(money(r.held)) > 0n;
export const heldCents = (r: Pick<ReservationRow, 'held'>): bigint => toCentavos(money(r.held));

/** Soonest first; the ones a manager must settle come first of all. */
export function sortReservations(rows: readonly ReservationRow[]): ReservationRow[] {
  return [...rows].sort((a, b) => Number(needsSettling(b)) - Number(needsSettling(a)) || Date.parse(a.reservedFor) - Date.parse(b.reservedFor) || a.id.localeCompare(b.id));
}

export function checkReservation(i: { name: string; phone: string; partySize: number; reservedFor: string; note: string }): string | null {
  const c = checkAll(POS_RESERVATION_RULES, { customerName: i.name, phone: i.phone, note: i.note });
  if (!c.ok) return c.requirement;
  if (!Number.isInteger(i.partySize) || i.partySize < 1 || i.partySize > 500) return SENTENCES.party;
  if (Number.isNaN(Date.parse(i.reservedFor))) return SENTENCES.time;
  return null;
}

/** null = the sheet may take it. A wallet needs its reference (4 to 40 characters), as at payment. */
export function checkDeposit(i: { amount: string; tender: DepositTender | undefined; referenceNo: string }): string | null {
  if (!i.tender) return SENTENCES.pickTender;
  const typed = i.amount.trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(typed)) return SENTENCES.amount;
  const cents = toCentavos(money(typed));
  if (cents <= 0n) return SENTENCES.amount;
  if (cents > DEPOSIT_MAX_CENTAVOS) return SENTENCES.amountMax;
  if (i.tender.kind === 'wallet') {
    const c = checkAll(POS_PAYMENT_REFERENCE_RULES, { referenceNo: i.referenceNo });
    if (!c.ok) return c.requirement;
  }
  return null;
}

/** What a typed amount is worth in centavos; anything that is not a money figure is zero. */
const amountCents = (raw: string): bigint => {
  try {
    return toCentavos(money(raw.trim()));
  } catch {
    return 0n;
  }
};
export const reasonProblem = (reason: string): string | null => (reason.trim().length >= 3 && reason.trim().length <= 200 ? null : SENTENCES.reasonShort);

// ---------------------------------------------------------------------------------------------------------------------
// The offline events
// ---------------------------------------------------------------------------------------------------------------------
export function reservationCreatedEvent(i: { personId: string; now: Date; reservationId: string; name: string; phone: string; partySize: number; reservedFor: Date; standId?: string; note: string }): NewPosEvent {
  const at = i.now.toISOString();
  return {
    kind: 'reservation.created',
    personId: i.personId,
    occurredAtDevice: at,
    payload: {
      reservationId: i.reservationId,
      customerName: i.name.trim(),
      ...(i.phone.trim() !== '' ? { phone: i.phone.trim() } : {}),
      partySize: i.partySize,
      reservedFor: i.reservedFor.toISOString(),
      ...(i.standId ? { standId: i.standId } : {}),
      ...(i.note.trim() !== '' ? { note: i.note.trim() } : {}),
      createdAtDevice: at,
    },
  };
}

export function depositTakenEvent(i: { personId: string; now: Date; depositId: string; reservationId: string; tenderId: string; amount: string; referenceNo?: string }): NewPosEvent {
  const at = i.now.toISOString();
  return {
    kind: 'deposit.taken',
    personId: i.personId,
    occurredAtDevice: at,
    payload: {
      depositId: i.depositId,
      reservationId: i.reservationId,
      tenderId: i.tenderId,
      amount: String(money(i.amount.trim())),
      ...(i.referenceNo && i.referenceNo.trim() !== '' ? { referenceNo: i.referenceNo.trim() } : {}),
      occurredAtDevice: at,
    },
  };
}

export function reservationSeatedEvent(i: { personId: string; now: Date; reservationId: string; sessionId: string }): NewPosEvent {
  const at = i.now.toISOString();
  return { kind: 'reservation.seated', personId: i.personId, occurredAtDevice: at, payload: { reservationId: i.reservationId, sessionId: i.sessionId, seatedAtDevice: at } };
}

/** The table opens as usual (heads = the party), with no items yet; `reservation.seated` links it right after, in the same outbox order. */
export function seatTableEvent(i: { personId: string; now: Date; sessionId: string; standId: string; heads: number }): NewPosEvent {
  const at = i.now.toISOString();
  return { kind: 'stand.opened', personId: i.personId, occurredAtDevice: at, payload: { sessionId: i.sessionId, mode: 'dine_in', standId: i.standId, headsCashier: Math.max(1, Math.min(200, i.heads)), openedAtDevice: at } };
}

export function reservationStatusEvent(i: { personId: string; now: Date; reservationId: string; status: 'cancelled' | 'no_show' }): NewPosEvent {
  const at = i.now.toISOString();
  return { kind: 'reservation.status_set', personId: i.personId, occurredAtDevice: at, payload: { reservationId: i.reservationId, status: i.status, atDevice: at } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The deposit slip
// ---------------------------------------------------------------------------------------------------------------------
export function depositSlipView(i: {
  storeName: string;
  vatRegistered: boolean;
  identity?: unknown;
  mode?: string;
  reservation: Pick<ReservationRow, 'customerName' | 'partySize' | 'reservedFor'>;
  takenAt: Date;
  amount: string;
  tenderName: string;
  referenceNo: string | null;
  takenBy: string;
  reprint?: boolean;
}): DepositSlipView {
  return {
    header: receiptHeaderOf({ name: i.storeName, vatRegistered: i.vatRegistered, identity: i.identity, mode: i.mode }),
    customerName: i.reservation.customerName,
    partySize: i.reservation.partySize,
    reservedForLocal: formatBusinessDateTime(new Date(i.reservation.reservedFor)),
    takenAtLocal: formatBusinessDateTime(i.takenAt),
    amount: String(money(i.amount.trim())),
    tenderName: i.tenderName,
    reference: i.referenceNo && i.referenceNo.trim() !== '' ? i.referenceNo.trim() : null,
    takenBy: i.takenBy,
    reprint: i.reprint === true,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The list as the tablet sees it: the snapshot's reservations with the outbox's not-yet-sent events laid on top
// ---------------------------------------------------------------------------------------------------------------------
interface PendingLike {
  kind: string;
  payload: Record<string, unknown>;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * shortcut: a deposit the server already holds but whose event is still in the outbox (the window between a snapshot refresh and the acknowledgement) shows twice for that moment;
 * the next snapshot or poll corrects it. The server is never affected: this is a display.
 */
export function projectReservations(base: readonly ReservationRow[], pending: readonly PendingLike[]): ReservationRow[] {
  const rows = new Map(base.map((r) => [r.id, { ...r }]));
  for (const e of pending) {
    const p = e.payload;
    if (e.kind === 'reservation.created') {
      const id = str(p.reservationId);
      if (!rows.has(id)) {
        rows.set(id, {
          id, customerName: str(p.customerName), phone: typeof p.phone === 'string' ? p.phone : null, partySize: Number(p.partySize) || 1, reservedFor: str(p.reservedFor),
          standId: typeof p.standId === 'string' ? p.standId : null, note: typeof p.note === 'string' ? p.note : null, status: 'booked', sessionId: null, held: '0.00',
        });
      }
    } else if (e.kind === 'deposit.taken') {
      const r = rows.get(str(p.reservationId));
      if (r) r.held = String(fromCentavos(toCentavos(money(r.held)) + amountCents(str(p.amount))));
    } else if (e.kind === 'reservation.seated') {
      const r = rows.get(str(p.reservationId));
      if (r) {
        r.status = 'seated';
        r.sessionId = str(p.sessionId);
      }
    } else if (e.kind === 'reservation.status_set') {
      const r = rows.get(str(p.reservationId));
      if (r && (p.status === 'cancelled' || p.status === 'no_show')) r.status = p.status;
    }
  }
  return [...rows.values()];
}

/** The deposit held for the reservation seated at `sessionId`, as the Pay screen offers it (the snapshot with the outbox on top). Undefined when there is none to use. */
export function depositForSession(base: readonly ReservationRow[] | undefined, pending: readonly PendingLike[] | undefined, sessionId: string): { reservationId: string; held: string; customerName: string } | undefined {
  const r = projectReservations(base ?? [], pending ?? []).find((x) => x.status === 'seated' && x.sessionId === sessionId);
  return r && heldCents(r) > 0n ? { reservationId: r.id, held: r.held, customerName: r.customerName } : undefined;
}
