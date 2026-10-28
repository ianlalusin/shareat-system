/**
 * T-455 S5 - the lobby card's pure rules (no React, no Firebase, no fetch). The screens decide nothing themselves: wording of a failure,
 * the number-pad search, the one-line row, the seat pre-fill and the "link the phone after seating" step all live here so they can be
 * tested without a DOM. docs/tasks/455-customer-lobby.md "S5 rulings" 4, 6, 7.
 */

export const LOBBY_UNAVAILABLE = 'The waiting list needs the POS server. Seat walk-ins as usual.';
export const LOBBY_RETRY_LABEL = 'Retry link';
const GENERIC_ERROR = 'Could not reach the waiting list. Try again.';
const CODE_DIGITS = 4;
const DOT = '·';

export interface LobbyLine {
  lineKind: 'package' | 'a_la_carte';
  qty: number;
  variantId: string;
  optionValueIds: string[];
  label: string;
  posItemKey: string | null;
}

/** One row of the `list` answer, as it arrives over JSON (times are ISO strings). */
export interface LobbyEntry {
  entryId: string;
  code: string;
  displayName: string | null;
  partySize: number;
  status: 'waiting' | 'called';
  source: 'lobby' | 'staff';
  note: string | null;
  phone: string | null;
  createdAt: string | number | Date;
  calledAt: string | number | Date | null;
  lines: LobbyLine[];
}

export type LobbyFailure =
  | { kind: 'unavailable'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'error'; message: string };

/** What a failed lobby call says. 503 and "no answer" (status 0) are the one waiting-list sentence; a 409 keeps the server's sentence. */
export function lobbyFailure(err: { status?: unknown; message?: unknown } | null | undefined): LobbyFailure {
  const status = err && typeof err.status === 'number' ? err.status : null;
  const message = err && typeof err.message === 'string' && err.message.trim() !== '' ? err.message : GENERIC_ERROR;
  if (status === 503 || status === 0) return { kind: 'unavailable', message: LOBBY_UNAVAILABLE };
  if (status === 409) return { kind: 'refused', message };
  return { kind: 'error', message };
}

/** The number pad: '0'-'9' appends (up to four), 'back' drops the last digit, 'clear' empties; anything else changes nothing. */
export function keypadPress(digits: string, key: string): string {
  if (key === 'clear') return '';
  if (key === 'back') return digits.slice(0, -1);
  if (/^[0-9]$/.test(key)) return digits.length < CODE_DIGITS ? digits + key : digits;
  return digits;
}

/** The line narrowed by the digits typed so far: by CODE only (never by name or phone). Empty pad = the whole line, in order. */
export function filterByCode<T extends { code: string }>(entries: T[], digits: string): T[] {
  if (digits === '') return entries;
  return entries.filter((e) => e.code.startsWith(digits));
}

/** "4821 . Ana . 5 pax . Pork+Chicken . 12 min" (the package part is left out when the party ordered none). */
export function lobbyRowSummary(
  e: { code: string; displayName: string | null; partySize: number; createdAt: string | number | Date; lines: { lineKind: string; label: string }[] },
  nowMs: number,
): string {
  const created = new Date(e.createdAt).getTime();
  const mins = Number.isFinite(created) ? Math.max(0, Math.floor((nowMs - created) / 60000)) : 0;
  const packages = e.lines.filter((l) => l.lineKind === 'package').map((l) => l.label);
  const parts = [e.code, e.displayName && e.displayName.trim() !== '' ? e.displayName : 'Guest', `${e.partySize} pax`];
  if (packages.length > 0) parts.push(packages.join('+'));
  parts.push(`${mins} min`);
  return parts.join(` ${DOT} `);
}

export interface SeatPrefill {
  partySize: number;
  notes: string;
  items: { posItemKey: string; qty: number }[];
  textLines: { label: string; qty: number }[];
}

/** What the Start Session form starts with: pax, the name + the entry's note in the notes, mapped lines, and the unmapped ones as text. */
export function prefillForSeat(e: LobbyEntry): SeatPrefill {
  const notes = [e.displayName, e.note].filter((s): s is string => typeof s === 'string' && s.trim() !== '').join(` ${DOT} `);
  const items: SeatPrefill['items'] = [];
  const textLines: SeatPrefill['textLines'] = [];
  for (const l of e.lines) {
    if (l.posItemKey) items.push({ posItemKey: l.posItemKey, qty: l.qty });
    else textLines.push({ label: l.label, qty: l.qty });
  }
  return { partySize: e.partySize, notes, items, textLines };
}

/**
 * After the POS session exists: fetch its join link and tell the lobby the party is seated (so the waiting phone can join). NEVER throws and
 * never undoes the session: if either step fails the entry stays on the list and the row offers "Retry link".
 */
export async function linkSeatedSession(i: {
  entryId: string;
  sessionId: string;
  standLabel: string;
  fetchJoinUrl: () => Promise<string>;
  seat: (b: { entryId: string; sessionId: string; standLabel: string; joinUrl: string }) => Promise<unknown>;
}): Promise<{ linked: true } | { linked: false; retryLabel: typeof LOBBY_RETRY_LABEL }> {
  try {
    const joinUrl = await i.fetchJoinUrl();
    await i.seat({ entryId: i.entryId, sessionId: i.sessionId, standLabel: i.standLabel, joinUrl });
    return { linked: true };
  } catch {
    return { linked: false, retryLabel: LOBBY_RETRY_LABEL };
  }
}
