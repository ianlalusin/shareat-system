import type { LobbyBirthday, LobbyClaim, LobbyCheckInInput, LobbyCheckInLine, LobbyMyEntry, LobbyResult } from '@/data/http-lobby-data';
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

// ---------- birthday screen (T-455 S6a) ----------

export const BIRTHDAY_NAME_MAX = 40;

export type BirthdayNameCheck = { ok: true; value: string | null } | { ok: false; error: string };

/** The celebrant's first name is optional: blank is "no name". Up to 40 characters after trimming. */
export function validateBirthdayName(raw: string): BirthdayNameCheck {
  const t = (raw ?? '').trim();
  if (t.length > BIRTHDAY_NAME_MAX) return { ok: false, error: `Keep the name to ${BIRTHDAY_NAME_MAX} characters.` };
  return { ok: true, value: t.length > 0 ? t : null };
}

export type BirthdayKind = 'form' | 'waiting' | 'accepted' | 'declined' | 'played' | 'expired';

export interface BirthdayScreenView {
  kind: BirthdayKind;
  /** One plain sentence for the status; empty for the form. */
  message: string;
  canCancel: boolean;
  /** Stop refreshing: nothing can change any more. */
  final: boolean;
}

/** "7:30 PM" in the phone's own time zone. */
export function formatBirthdayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** No request (or a cancelled one) shows the form again; the others show what became of it. */
export function birthdayScreenView(b: LobbyBirthday | null): BirthdayScreenView {
  if (!b || b.status === 'cancelled') return { kind: 'form', message: '', canCancel: false, final: false };
  switch (b.status) {
    case 'requested':
      return { kind: 'waiting', message: 'Waiting for the cashier to answer.', canCancel: true, final: false };
    case 'accepted': {
      const at = b.scheduledAt ? formatBirthdayTime(b.scheduledAt) : '';
      return { kind: 'accepted', message: at ? `Accepted for ${at}.` : 'Accepted.', canCancel: true, final: false };
    }
    case 'declined': {
      const why = (b.declineReason ?? '').trim().replace(/[.]+$/, '');
      return { kind: 'declined', message: why ? `Sorry, not tonight: ${why}.` : 'Sorry, not tonight.', canCancel: false, final: true };
    }
    case 'played':
      return { kind: 'played', message: 'Your birthday song has played. Happy birthday!', canCancel: false, final: true };
    default:
      return { kind: 'expired', message: 'This request has ended. Please ask the cashier.', canCancel: false, final: true };
  }
}

// ---------- senior / PWD discount screen (T-455 S7a) ----------

export const CLAIM_NAME_MAX = 40;
export const CLAIM_ID_MIN = 4;
export const CLAIM_ID_MAX = 40;

export interface ClaimForm {
  kind: 'senior' | 'pwd' | '';
  holderName: string;
  idNumber: string;
}

export type ClaimFormCheck =
  | { ok: true; value: { kind: 'senior' | 'pwd'; holderName: string; idNumber: string } }
  | { ok: false; errors: { kind?: string; holderName?: string; idNumber?: string } };

/** The same bounds the server enforces (name 1..40, ID 4..40 with at least 4 letters or digits once spaces and hyphens are ignored). Typed only. */
export function validateClaimForm(f: ClaimForm): ClaimFormCheck {
  const errors: { kind?: string; holderName?: string; idNumber?: string } = {};
  if (f.kind !== 'senior' && f.kind !== 'pwd') errors.kind = 'Please choose Senior or PWD.';
  const name = (f.holderName ?? '').trim();
  if (name.length < 1) errors.holderName = 'Please type the name as it is on the card.';
  else if (name.length > CLAIM_NAME_MAX) errors.holderName = `Keep the name to ${CLAIM_NAME_MAX} characters.`;
  const id = (f.idNumber ?? '').trim();
  const bare = id.replace(/[\s-]/g, '');
  if (id.length > CLAIM_ID_MAX) errors.idNumber = `Keep the ID number to ${CLAIM_ID_MAX} characters.`;
  else if (bare.length < CLAIM_ID_MIN) errors.idNumber = 'Please type the ID number as it is on the card.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { kind: f.kind as 'senior' | 'pwd', holderName: name, idNumber: id } };
}

export interface ClaimRowView {
  claimId: string;
  /** "Senior" or "PWD". */
  kindLabel: string;
  /** "****1187". */
  idMasked: string;
  /** One plain sentence for the claim's status. */
  message: string;
  canCancel: boolean;
}

/** What the claim list shows: the kind, the masked ID and what became of it. The name and the full ID are never on this screen after Send. */
export function claimRowView(c: LobbyClaim): ClaimRowView {
  const kindLabel = c.kind === 'pwd' ? 'PWD' : 'Senior';
  switch (c.status) {
    case 'pending':
      return { claimId: c.claimId, kindLabel, idMasked: c.idMasked, message: 'Waiting for the cashier to check your card.', canCancel: true };
    case 'approved':
      return { claimId: c.claimId, kindLabel, idMasked: c.idMasked, message: 'Approved. The discount has been added.', canCancel: false };
    case 'rejected': {
      const why = (c.rejectReason ?? '').trim().replace(/[.]+$/, '');
      return { claimId: c.claimId, kindLabel, idMasked: c.idMasked, message: why ? `Not approved: ${why}.` : 'Not approved.', canCancel: false };
    }
    default:
      return { claimId: c.claimId, kindLabel, idMasked: c.idMasked, message: 'This claim has ended. Please ask the cashier.', canCancel: false };
  }
}
