import type { LobbyCheckInInput, LobbyCheckInLine, LobbyMyEntry, LobbyResult } from '@/data/http-lobby-data';
import type { LobbyStoreView } from '@/data/lobby-data';

/**
 * T-455 S4 - the PURE rules behind the lobby screens (docs/tasks/455-customer-lobby.md 3.1). The screens are thin shells over these functions.
 * Nothing here knows a price, a phone or an email: the check-in payload is built from an allow-list, never by spreading the form.
 */

export const LOBBY_NAME_MAX = 40;
export const LOBBY_PARTY_MIN = 1;
export const LOBBY_PARTY_MAX = 30;
export const LOBBY_NOTE_MAX = 60;
export const LOBBY_LINES_MAX = 20;
export const COUNTER_NOTICE = 'Please check in at the counter';
export const CALLED_NOTICE = 'Please come to the counter';

// ---------- check-in form ----------

export interface CheckInAttempt {
  /** Generated on first use, then the same value for every retry of this attempt. */
  id(): string;
}

/** One attempt = one place in line. A retry of the SAME attempt re-sends the same id, so the server returns the same place. */
export function createCheckInAttempt(newId: () => string = () => crypto.randomUUID()): CheckInAttempt {
  let id: string | null = null;
  return {
    id() {
      if (id === null) id = newId();
      return id;
    },
  };
}

export interface CheckInForm {
  displayName: string;
  partySize: number;
  note: string;
  lines: ReadonlyArray<{ variantId: string; qty: number; lineKind: 'package' | 'a_la_carte'; optionValueIds?: readonly string[] }>;
}

export type CheckInErrors = Partial<Record<'displayName' | 'partySize' | 'note' | 'lines', string>>;

export type CheckInValidation = { ok: true; value: LobbyCheckInInput } | { ok: false; errors: CheckInErrors };

export function validateCheckIn(storeCode: string, form: CheckInForm, attempt: CheckInAttempt): CheckInValidation {
  const errors: CheckInErrors = {};

  const displayName = (form.displayName ?? '').trim();
  if (displayName.length < 1 || displayName.length > LOBBY_NAME_MAX) errors.displayName = `Enter a name to call, up to ${LOBBY_NAME_MAX} characters.`;

  const partySize = form.partySize;
  if (!Number.isInteger(partySize) || partySize < LOBBY_PARTY_MIN || partySize > LOBBY_PARTY_MAX) {
    errors.partySize = `Party size must be from ${LOBBY_PARTY_MIN} to ${LOBBY_PARTY_MAX}.`;
  }

  const note = (form.note ?? '').trim();
  if (note.length > LOBBY_NOTE_MAX) errors.note = `Keep the note to ${LOBBY_NOTE_MAX} characters.`;

  const rawLines = form.lines ?? [];
  const lines: LobbyCheckInLine[] = [];
  let linesOk = rawLines.length <= LOBBY_LINES_MAX;
  for (const l of rawLines) {
    if (typeof l.variantId !== 'string' || l.variantId.length === 0 || !Number.isInteger(l.qty) || l.qty < 1 || (l.lineKind !== 'package' && l.lineKind !== 'a_la_carte')) {
      linesOk = false;
      break;
    }
    const line: LobbyCheckInLine = { variantId: l.variantId, qty: l.qty, lineKind: l.lineKind };
    if (l.optionValueIds !== undefined) line.optionValueIds = [...l.optionValueIds];
    lines.push(line);
  }
  if (!linesOk) errors.lines = `Check your order: up to ${LOBBY_LINES_MAX} items, each at least 1.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const value: LobbyCheckInInput = { storeCode, displayName, partySize, clientRequestId: attempt.id() };
  if (note.length > 0) value.note = note;
  if (lines.length > 0) value.lines = lines;
  return { ok: true, value };
}

// ---------- sentences ----------

/** Where the diner stands. Nobody ahead is "You are next", never "0 parties". */
export function positionText(partiesAhead: number): string {
  if (partiesAhead <= 0) return 'You are next';
  if (partiesAhead === 1) return '1 party ahead of you';
  return `${partiesAhead} parties ahead of you`;
}

export function waitingText(partiesWaiting: number): string {
  return partiesWaiting === 1 ? '1 party waiting' : `${partiesWaiting} parties waiting`;
}

// ---------- store screen ----------

export interface StoreScreenView {
  title: string;
  waitingText: string;
  notice: string | null;
  showForm: boolean;
  checkInHref: string | null;
  showMenu: boolean;
}

/** An open store offers the form. ANY other answer (paused, disabled, POS unseen, unknown, offline, server fault) shows the counter sentence and the menu only. */
export function storeScreenView(result: LobbyResult<LobbyStoreView>): StoreScreenView {
  if (result.ok && result.value.accepting) {
    const s = result.value;
    return {
      title: s.storeName,
      waitingText: waitingText(s.partiesWaiting),
      notice: null,
      showForm: true,
      checkInHref: `/lobby/check-in?s=${encodeURIComponent(s.storeCode)}`,
      showMenu: true,
    };
  }
  const name = result.ok ? result.value.storeName : '';
  return { title: name.length > 0 ? name : 'Shareat', waitingText: '', notice: `${COUNTER_NOTICE}.`, showForm: false, checkInHref: null, showMenu: true };
}

// ---------- wait screen ----------

export type WaitKind = 'waiting' | 'called' | 'handoff' | 'closed';

export interface WaitView {
  kind: WaitKind;
  code: string;
  positionText: string;
  notice: string | null;
  canCancel: boolean;
  /** Exactly what the server sent (null stays null). Never built here. */
  handoffUrl: string | null;
}

export function waitView(entry: LobbyMyEntry): WaitView {
  const code = entry.code;
  switch (entry.status) {
    case 'waiting':
      return { kind: 'waiting', code, positionText: positionText(entry.partiesAhead), notice: null, canCancel: true, handoffUrl: null };
    case 'called':
      return { kind: 'called', code, positionText: positionText(entry.partiesAhead), notice: CALLED_NOTICE, canCancel: true, handoffUrl: null };
    case 'seated':
      return { kind: 'handoff', code, positionText: '', notice: null, canCancel: false, handoffUrl: entry.handoffUrl };
    default:
      return { kind: 'closed', code, positionText: '', notice: null, canCancel: false, handoffUrl: null };
  }
}
