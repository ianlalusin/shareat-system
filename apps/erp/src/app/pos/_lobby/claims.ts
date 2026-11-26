/**
 * T-644 S4 - the pure half of the senior / PWD discount claims on the Lobby tab: the shapes the server actions answer with, the four fixed reject reasons, the
 * statutory-diner reference (ruling 6), what the cashier may tap, the approve-then-recheck flow and the strip's poller. No React, no clock, no network: every dependency
 * arrives in an argument. docs/tasks/644-lobby-in-erp-pos.md, S4. Ported as REQUIREMENTS from apps/pos (lobbyClaims.ts); the state rules live in `packages/domain/src/lobby/claims.ts`.
 * ⛔ A claim's name and ID number exist only in `OpenedClaimView`, the answer of the one "open" call, which the dialog keeps in its own memory. No list view, summary or log carries them.
 */
import { createPollGuard, type LobbyResult } from './logic';

export type ClaimKind = 'senior' | 'pwd';

/** The fixed reject list: the diner reads only the sentence for a code. Each sentence is at most 80 characters (the domain cap). No free text from this screen. */
export const CLAIM_REJECT_REASONS = [
  { code: 'card_not_shown', label: 'We could not see your ID card. Please show it to the cashier.' },
  { code: 'id_mismatch', label: 'The ID number did not match the card.' },
  { code: 'card_not_valid', label: 'This card cannot be used for the discount.' },
  { code: 'already_claimed', label: 'This card was already used for this table.' },
] as const;
export type ClaimRejectCode = (typeof CLAIM_REJECT_REASONS)[number]['code'];
/** The sentence for a known code; anything else (free text, a label, junk, a non-string) is null. */
export function claimRejectText(code: unknown): string | null {
  return typeof code === 'string' ? (CLAIM_REJECT_REASONS.find((r) => r.code === code)?.label ?? null) : null;
}
/** Body keys that would carry free text: a client that sends one is refused, not ignored, so the bug is visible. */
export const CLAIM_FREE_TEXT_KEYS: readonly string[] = ['reason', 'note', 'text', 'message'];

export const BAD_CLAIM = 'Choose a claim from the list.';
export const BAD_CLAIM_REASON = 'Choose one of the reasons.';
export const BAD_CLAIM_DINER = 'Choose the diner number, and seat the party first.';
export const CLAIMS_NOT_LOADED = 'Discount claims could not be loaded. They will try again.';
export const CLAIM_CLOSED_NOW = 'That discount claim can no longer be changed.';
export const CLAIM_UNSURE = 'No answer came back. Check the claim before trying again.';

/** The largest diner number: a party is at most 30 (LOBBY_PARTY_MAX in the domain), so `${sessionId}:${n}` stays far under the 80-character reference cap. */
export const DINER_NO_MAX = 30;

/** One pending claim of the list, JSON-safe. The ID is masked (`****1187`); there is no name and no full number. */
export interface ClaimView {
  claimId: string;
  entryId: string;
  code: string;
  displayName: string | null;
  standLabel: string | null;
  partySize: number;
  kind: ClaimKind;
  idMasked: string;
  status: 'pending';
  createdAt: string;
}
export type ClaimListResult = LobbyResult<{ claims: ClaimView[] }>;

/** The answer of "open claim": the ONLY place a name and an ID number reach the tablet. The dialog holds it in component state and drops it on close. */
export interface OpenedClaimView {
  claimId: string;
  kind: ClaimKind;
  holderName: string;
  idNumber: string;
  code: string;
  standLabel: string | null;
  partySize: number;
  /** The POS session the party was seated on, or null when the party is not seated yet (approve is blocked until it is). */
  sessionRef: string | null;
}

/** What the paying screen is told of an approved claim: the kind, the card's last 4 and the diner number. Never a name or a full ID number. */
export interface ApprovedClaimView {
  kind: ClaimKind;
  idLast4: string;
  dinerNo: number;
}

/** Ruling 6: the statutory-diner reference of an approved claim, 1..80 characters. */
export const dinerRefOf = (sessionId: string, dinerNo: number): string => `${sessionId}:${dinerNo}`;
/** The diner number of a reference that belongs to this session, else null (another session's, a malformed one, a number out of range). */
export function dinerNoOfRef(sessionId: string, ref: string): number | null {
  const prefix = `${sessionId}:`;
  if (!ref.startsWith(prefix)) return null;
  const tail = ref.slice(prefix.length);
  if (!/^[1-9][0-9]{0,2}$/.test(tail)) return null;
  const n = Number(tail);
  return Math.min(Math.max(n, 1), DINER_NO_MAX) === n ? n : null; // clamp-equals-self is the range test; keeps G2 (no relational op on a string-derived value)
}

const MASKED = /^\*{4}[A-Za-z0-9]{1,4}$/;
const DOT = '·';
/** "4821 · Stand 7 · Senior · ****1187". Only these four fields are read; a masked field that is not ****last4 prints as ****. */
export function claimLine(c: Pick<ClaimView, 'code' | 'standLabel' | 'kind' | 'idMasked'>): string {
  const parts = [c.code];
  if (typeof c.standLabel === 'string' && c.standLabel.trim() !== '') parts.push(`Stand ${c.standLabel.trim()}`);
  parts.push(c.kind === 'pwd' ? 'PWD' : 'Senior');
  parts.push(MASKED.test(c.idMasked) ? c.idMasked : '****');
  return parts.join(` ${DOT} `);
}

/** Why Approve is not allowed yet, in plain words, or null when it is. The tick always starts OFF: the cashier sees the card every time. */
export function claimApproveBlock(i: { sessionRef: string | null; dinerNo: number | null; cardSeen: boolean }): string | null {
  if (i.sessionRef === null || i.sessionRef.trim() === '') return 'Seat the party first, then approve the claim.';
  if (i.dinerNo === null) return 'Choose which diner this card is for.';
  if (!i.cardSeen) return 'Tick the box once you have seen the card.';
  return null;
}

export type DecideOutcome = { done: true } | { done: false; message: string };

/**
 * Approve or reject, and when the answer is lost, ask the server what happened. A call that threw (no answer) or was refused as "closed" may be the second try of a move that already
 * worked: the claim's status decides. Only the status the cashier wanted counts as done; `pending` after no answer means try again, anything else is shown as a sentence.
 */
export async function decideWithRecheck(
  wanted: 'approved' | 'rejected',
  deps: { act: () => Promise<LobbyResult>; status: () => Promise<LobbyResult<{ status: string }>> },
): Promise<DecideOutcome> {
  let first: LobbyResult | null = null;
  try {
    first = await deps.act();
  } catch {
    first = null;
  }
  if (first !== null && first.ok) return { done: true };
  if (first !== null && !first.ok && first.final !== true) return { done: false, message: first.error };
  try {
    const s = await deps.status();
    if (s.ok && s.status === wanted) return { done: true };
    if (s.ok && s.status === 'pending') return { done: false, message: CLAIM_UNSURE };
    if (s.ok) return { done: false, message: CLAIM_CLOSED_NOW };
    return { done: false, message: first !== null && !first.ok ? first.error : s.error };
  } catch {
    return { done: false, message: CLAIM_UNSURE };
  }
}

/** The strip's poll: ONE list call in flight, a stale answer dropped (the lobby line's `createPollGuard`). A failed call keeps the last list and reports one sentence. */
export function createClaimsPoller(deps: { list: () => Promise<ClaimListResult>; apply: (o: { claims: ClaimView[] } | { error: string }) => void }) {
  const guard = createPollGuard();
  const poll = async (): Promise<void> => {
    const seq = guard.begin();
    if (seq === null) return;
    try {
      const r = await deps.list();
      if (guard.accept(seq)) deps.apply(r.ok ? { claims: r.claims } : { error: r.error });
    } catch {
      if (guard.accept(seq)) deps.apply({ error: CLAIMS_NOT_LOADED });
    } finally {
      if (guard.end()) void poll();
    }
  };
  return { poll };
}

// ------------------------------------------------------------------------------------------------ the paying screen (ruling 6)

/**
 * What the paying screen of one session learns of its approved claims. A refusal, an old answer or a thrown call is an EMPTY list, never an error on the payment screen:
 * the cashier can always add the discount by hand as before. The answer carries no name and no full ID number.
 */
export async function loadApprovedClaims(call: (sessionId: string) => Promise<LobbyResult<{ claims: ApprovedClaimView[] }>>, sessionId: string): Promise<ApprovedClaimView[]> {
  try {
    const r = await call(sessionId);
    return r.ok ? r.claims : [];
  } catch {
    return [];
  }
}

/** A quick-pick on the discount sheet: "Senior · diner 2 · ID ****1187". It only chooses the kind and the diner number: the cashier still taps Add discount. */
export const claimOfferLabel = (c: ApprovedClaimView): string => `${c.kind === 'pwd' ? 'PWD' : 'Senior'} ${DOT} diner ${c.dinerNo} ${DOT} ID ****${c.idLast4}`;

/** The line under a diner's ID box when a lobby claim was approved for that very diner and kind, or null. The cashier still checks the card and types the name and number. */
export function claimHint(claims: readonly ApprovedClaimView[], d: { dinerNo: number; kind: string }): string | null {
  const c = claims.find((x) => x.dinerNo === d.dinerNo && x.kind === d.kind);
  return c ? `Approved at the lobby: the ID ends in ${c.idLast4}. Check it against the card.` : null;
}
