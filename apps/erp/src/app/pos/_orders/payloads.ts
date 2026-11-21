/**
 * T-527 R3, R5, R6 - the events the Orders tab writes, and the one write path. docs/tasks/527-pos-orders-screen.md.
 * Each payload is the T-524 input shape WITHOUT `storeId` or `pairingId` (T-525 R3): the server takes both from the pairing. The inbox refuses a key it
 * does not know, so a key with no value is left out, never sent as `undefined`.
 * Every write goes `enqueue` first, then `requestDrain`; the server re-checks and re-prices every action.
 */
import type { ProjectedStoreMenu, StoreMenuV2 } from '@shareat/domain';
import type { NewPosEvent, PosEvent } from '@/lib/pos-device';
import type { ApprovalFields } from '../_shell/line-approval';
import { asStoreMenu } from './menu-filter';

export interface CartLine {
  itemId: string;
  variantId?: string;
  qty: number;
  note?: string;
  optionValueIds?: string[];
}

export const POS_ENQUEUE_FAILED = 'This tablet could not save that. Nothing was sent. Try again.';
export const POS_READ_ONLY_NOTE = 'Orders are taken on the store tablet.';

/** The shape limits of the seat dialog's fields (the server's own bounds are wider: 200 for a note). */
export const HEADS_MIN = 1;
export const HEADS_MAX = 200;
export const NOTE_MAX = 120;
export const TAKE_OUT_NAME_MAX = 40;
/** The short list for cancelling a line; "Other" is typed by the cashier and is not a reason on its own. */
// shortcut: fixed cancel reasons until a settings list exists; post-go-live What's Left
export const CANCEL_REASONS = ['Wrong item', 'Customer changed mind', 'Duplicate', 'Other'];
export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 200;

type Menu = StoreMenuV2 | ProjectedStoreMenu;
interface Common {
  personId: string;
  menu: Menu;
  now: Date;
  newId: () => string;
}
type EventLine = { lineId: string; menuItemId: string; variantId?: string; qty: number; note?: string; addedAtDevice: string; optionValueIds?: string[] };

function checkHeads(heads: number): void {
  if (!Number.isInteger(heads) || heads < HEADS_MIN || heads > HEADS_MAX) throw new Error(`Heads must be a whole number from ${HEADS_MIN} to ${HEADS_MAX}.`);
}

function eventLines(c: Common & { cart: readonly CartLine[]; heads: number; firstNote?: string }): EventLine[] {
  const items = asStoreMenu(c.menu).items;
  const at = c.now.toISOString();
  return c.cart.map((l, i) => {
    const isPackage = items.find((x) => x.id === l.itemId)?.itemType === 'package';
    const own = l.note?.trim() ?? '';
    const note = i === 0 && c.firstNote ? (own ? `${c.firstNote} - ${own}` : c.firstNote) : own;
    return {
      lineId: c.newId(),
      menuItemId: l.itemId,
      ...(l.variantId ? { variantId: l.variantId } : {}),
      qty: isPackage ? c.heads : l.qty, // a package is billed per head (T-524 ruling 3); the server derives the bundle's extra-heads line
      ...(note ? { note } : {}),
      addedAtDevice: at, // one time for the whole event; the cart order rides in the line ids (ids.ts)
      ...(l.optionValueIds && l.optionValueIds.length > 0 ? { optionValueIds: l.optionValueIds } : {}),
    };
  });
}

export function seatEvent(i: Common & { standId: string; heads: number; cart: readonly CartLine[] }): NewPosEvent {
  checkHeads(i.heads);
  const sessionId = i.newId();
  const at = i.now.toISOString();
  return {
    kind: 'stand.opened',
    personId: i.personId,
    occurredAtDevice: at,
    payload: { sessionId, mode: 'dine_in', standId: i.standId, headsCashier: i.heads, openedAtDevice: at, lines: eventLines({ ...i, heads: i.heads }) },
  };
}

export function takeOutEvent(i: Common & { cart: readonly CartLine[]; name?: string }): NewPosEvent {
  const items = asStoreMenu(i.menu).items;
  if (i.cart.some((l) => items.find((x) => x.id === l.itemId)?.itemType === 'package')) throw new Error('A package can only be sold to a table, not take-out.');
  const sessionId = i.newId();
  const at = i.now.toISOString();
  const name = i.name?.trim().slice(0, TAKE_OUT_NAME_MAX);
  return {
    kind: 'stand.opened',
    personId: i.personId,
    occurredAtDevice: at,
    payload: { sessionId, mode: 'take_out', headsCashier: 0, openedAtDevice: at, lines: eventLines({ ...i, heads: 0, ...(name ? { firstNote: `For: ${name}` } : {}) }) },
  };
}

export function addLinesEvent(i: Common & { sessionId: string; heads: number; cart: readonly CartLine[] }): NewPosEvent {
  return { kind: 'lines.added', personId: i.personId, occurredAtDevice: i.now.toISOString(), payload: { sessionId: i.sessionId, lines: eventLines(i) } };
}

export function setHeadsEvent(i: { personId: string; sessionId: string; heads: number; now: Date }): NewPosEvent {
  checkHeads(i.heads);
  return { kind: 'heads.set', personId: i.personId, occurredAtDevice: i.now.toISOString(), payload: { sessionId: i.sessionId, headsCashier: i.heads } };
}

export function cancelLineEvent(i: { personId: string; lineId: string; reason: string; now: Date; /** T-576: the manager PIN, or offline: true when the rule asks for one and the till is offline. */ approval?: ApprovalFields }): NewPosEvent {
  return { kind: 'line.cancelled', personId: i.personId, occurredAtDevice: i.now.toISOString(), payload: { lineId: i.lineId, reason: i.reason, ...i.approval } };
}

/** T-620: the server's `session.voided` spec (inbox.ts): sessionId, reason, voidedAtDevice and offline always; `approval: { pin }` only when a manager PIN was typed. */
export function voidSessionEvent(i: { personId: string; sessionId: string; reason: string; now: Date; offline: boolean; pin?: string }): NewPosEvent {
  const at = i.now.toISOString();
  return { kind: 'session.voided', personId: i.personId, occurredAtDevice: at, payload: { sessionId: i.sessionId, reason: i.reason, voidedAtDevice: at, offline: i.offline, ...(i.pin ? { approval: { pin: i.pin } } : {}) } };
}

export const VOID_OFFLINE_NOTE = 'A manager must approve voiding a table, and that needs the internet.';
export const VOID_NOT_SENT = 'Could not reach the server, so the table was not voided. Try again.';
/**
 * Who may void, as the server decides it (sale.ts voidUnpaidSession, row 356):
 *   direct  - the signed-in person holds `approve_pos_correction`: no PIN, saved to the outbox like any action (works offline; the event says `offline: true`).
 *   pin     - anyone else, online: a manager's PIN, sent at once and never saved (`sendVoidNow`).
 *   blocked - anyone else, offline: nothing is sent; the screen says why.
 */
export type VoidAccess = 'direct' | 'pin' | 'blocked';
export const voidAccess = (a: { canApprove: boolean; online: boolean }): VoidAccess => (a.canApprove ? 'direct' : a.online ? 'pin' : 'blocked');

/**
 * T-620: sends ONE event to the server now, outside the outbox, so a typed manager PIN is never written to the tablet's storage. It takes a fresh `seq` and the bound
 * pairing, posts a one-event batch, and turns the answer into `ok` or the one sentence for the dialog. A refusal (wrong PIN, table already paid) is the server's own sentence.
 */
export async function sendVoidNow(deps: { reserveSeq: () => Promise<{ seq: number; pairingId: string }>; fetch: typeof fetch }, event: NewPosEvent): Promise<{ ok: true; event: PosEvent } | { ok: false; message: string }> {
  try {
    const { seq, pairingId } = await deps.reserveSeq();
    const sent: PosEvent = { seq, pairingId, ...event };
    const res = await deps.fetch('/api/pos/events', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId, events: [sent] }),
    });
    const j = (await res.json().catch(() => null)) as { results?: { seq: number; status: string; error?: string }[] } | null;
    const r = res.ok ? j?.results?.find((x) => x.seq === seq) : undefined;
    if (r?.status === 'applied' || r?.status === 'duplicate') return { ok: true, event: sent };
    if (r?.status === 'quarantined' && r.error) return { ok: false, message: r.error.replace(/^[A-Z][A-Z0-9_]+: /, '') };
    return { ok: false, message: VOID_NOT_SENT };
  } catch {
    return { ok: false, message: VOID_NOT_SENT };
  }
}

/** The one write path: save to the tablet's outbox first, and only then ask for a send. A failed save changes nothing and says so. */
export async function submitPosEvent(
  deps: { enqueue: (e: NewPosEvent) => Promise<PosEvent>; requestDrain: () => void },
  event: NewPosEvent,
): Promise<{ ok: true; event: PosEvent } | { ok: false; message: string }> {
  let stored: PosEvent;
  try {
    stored = await deps.enqueue(event);
  } catch {
    return { ok: false, message: POS_ENQUEUE_FAILED };
  }
  deps.requestDrain();
  return { ok: true, event: stored };
}

/** The person on an event: the cashier who signed in offline when there is one, else the signed-in person (T-526 R5). */
export const actingPersonId = (offlineActor: { personId: string } | null, sessionPersonId: string): string => (offlineActor ? offlineActor.personId : sessionPersonId);

/** Row 447: only a paired store tablet writes orders. Any other browser reads them. */
export const ordersAccess = (a: { paired: boolean }): { canWrite: boolean; note: string | null } => (a.paired ? { canWrite: true, note: null } : { canWrite: false, note: POS_READ_ONLY_NOTE });
