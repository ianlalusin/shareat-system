/**
 * T-455 S2 - the typed lobby refusals. A refusal carries a machine `code` (for tests, logs and the screens) and ONE plain sentence.
 * Section 4.1 (S2 ruling 2): a diner is never told WHICH limit stopped them, so every limit, closed-store and no-code refusal reads
 * the same sentence; only the `code` differs. No database wording ever reaches `userMessage`.
 */
import { RefusalError, refuse } from '../shared/refusal';

export const LOBBY_REFUSAL_CODES = [
  'LOBBY_BAD_INPUT',
  'LOBBY_IP_LIMIT',
  'LOBBY_FULL',
  'LOBBY_PAUSED',
  'LOBBY_DISABLED',
  'LOBBY_POS_STALE',
  'LOBBY_NO_CODE',
  'LOBBY_NOT_FOUND',
  'LOBBY_ENTRY_CLOSED',
  'LOBBY_SEAT_NEEDS_SESSION',
] as const;
export type LobbyRefusalCode = (typeof LOBBY_REFUSAL_CODES)[number];

export class LobbyRefusal extends RefusalError {
  readonly code: LobbyRefusalCode;
  constructor(code: LobbyRefusalCode, message: string, userMessage: string) {
    super(message, userMessage);
    this.name = 'LobbyRefusal';
    this.code = code;
  }
}

/** What a diner reads when any limit, switch or the code lottery stops a check-in. The same for all of them. */
const COUNTER_SENTENCE = 'Please check in at the counter.';

const SENTENCES: Record<LobbyRefusalCode, string> = {
  LOBBY_BAD_INPUT: 'Please check the name, party size and order, then try again.',
  LOBBY_IP_LIMIT: COUNTER_SENTENCE,
  LOBBY_FULL: COUNTER_SENTENCE,
  LOBBY_PAUSED: COUNTER_SENTENCE,
  LOBBY_DISABLED: COUNTER_SENTENCE,
  LOBBY_POS_STALE: COUNTER_SENTENCE,
  LOBBY_NO_CODE: COUNTER_SENTENCE,
  LOBBY_NOT_FOUND: 'We could not find that place in line.',
  LOBBY_ENTRY_CLOSED: 'That place in line is already closed.',
  LOBBY_SEAT_NEEDS_SESSION: 'Start the table session first, then pick the stand and seat the party.',
};

/** `detail` goes to the log message only (never to the diner). It must carry no name, phone or ID number. */
export function lobbyRefusal(code: LobbyRefusalCode, detail?: string): LobbyRefusal {
  const sentence = SENTENCES[code];
  const r = refuse(detail ? `${code}: ${detail}` : code, sentence);
  return new LobbyRefusal(code, r.message, r.userMessage);
}

export const LOBBY_NAME_MAX = 40;
export const LOBBY_NOTE_MAX = 60;
export const LOBBY_PARTY_MIN = 1;
export const LOBBY_PARTY_MAX = 30;

/** Shared by the diner check-in and the cashier's park: the name, party size and note, trimmed and bounded. Refuses LOBBY_BAD_INPUT. */
export function cleanParty(input: { displayName: unknown; partySize: unknown; note?: unknown }): { displayName: string; partySize: number; note: string | null } {
  const name = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (name.length < 1 || name.length > LOBBY_NAME_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'name length');
  const size = input.partySize;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < LOBBY_PARTY_MIN || size > LOBBY_PARTY_MAX) {
    throw lobbyRefusal('LOBBY_BAD_INPUT', 'party size');
  }
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') throw lobbyRefusal('LOBBY_BAD_INPUT', 'note type');
    const t = input.note.trim();
    if (t.length > LOBBY_NOTE_MAX) throw lobbyRefusal('LOBBY_BAD_INPUT', 'note length');
    note = t.length > 0 ? t : null;
  }
  return { displayName: name, partySize: size, note };
}
