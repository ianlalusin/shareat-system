/**
 * T-455 S7b - the cashier-side rules of a diner's senior / PWD discount claim (pure: no React, no Firebase, no fetch).
 * docs/tasks/455-customer-lobby.md S7b rulings; T-426 capture rules. Also imported by the claim-reject route for the fixed reasons.
 * The screens decide nothing themselves; the flows below take their writers as arguments so they are testable without a DOM.
 */
import { normalizeIdNo } from '@/lib/statutory/capture';

export const CLAIMS_UNAVAILABLE = 'Discount claims need the POS server. Record the senior / PWD discount by hand as usual.';
export const CLAIM_RETRY_MESSAGE = 'Saved on this bill. The claim is not confirmed yet. Try again when the POS server is back.';
export const CLAIMS_REFRESH_FAILED = 'Discount claims could not refresh. Try again in a moment.';
export const CLAIM_CLOSED_MESSAGE = 'That discount claim can no longer be changed.';
export const CARD_ON_BILL_MESSAGE = 'This card is already on this bill.';
const GENERIC_ERROR = 'Could not reach the discount claims. Try again.';
const DOT = '·';

/** The fixed reject list: the diner only ever reads the sentence for a code. Each sentence is at most 80 chars (the domain cap). */
export const LOBBY_REJECT_REASONS = [
  { code: 'card_not_shown', label: 'We could not see your ID card. Please show it to the cashier.' },
  { code: 'id_mismatch', label: 'The ID number did not match the card.' },
  { code: 'card_not_valid', label: 'This card cannot be used for the discount.' },
  { code: 'already_claimed', label: 'This card was already used for this table.' },
] as const;

export type RejectCode = (typeof LOBBY_REJECT_REASONS)[number]['code'];

/** The sentence for a known code; anything else (free text, a label, junk, a non-string) is null. */
export function rejectReasonText(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  return LOBBY_REJECT_REASONS.find((r) => r.code === code)?.label ?? null;
}

export type ClaimKind = 'senior' | 'pwd';

export interface ClaimListItem {
  claimId: string;
  entryId: string;
  code: string;
  standLabel: string | null;
  kind: ClaimKind;
  idMasked: string;
}

export interface ClaimCounts { count: number; seniors: number; pwds: number }

/** Pending claims per lobby entry id. */
export function claimsByEntry(rows: readonly { entryId: string; kind: string }[]): Record<string, ClaimCounts> {
  const out: Record<string, ClaimCounts> = {};
  for (const r of rows) {
    const c = Object.prototype.hasOwnProperty.call(out, r.entryId) ? out[r.entryId]! : (out[r.entryId] = { count: 0, seniors: 0, pwds: 0 });
    c.count += 1;
    if (r.kind === 'senior') c.seniors += 1;
    else if (r.kind === 'pwd') c.pwds += 1;
  }
  return out;
}

export function claimBadgeLabel(c: ClaimCounts | undefined): string | null {
  if (!c || c.count < 1) return null;
  return c.count === 1 ? '1 SC/PWD claim' : `${c.count} SC/PWD claims`;
}

const MASKED = /^\*{4}[A-Za-z0-9]{1,4}$/;

/** "4821 · Stand 7 · Senior · ****1187". Only these four fields are read; a masked field that is not ****last4 prints as ****. */
export function claimListLine(row: Pick<ClaimListItem, 'code' | 'standLabel' | 'kind' | 'idMasked'>): string {
  const parts = [String(row.code)];
  if (typeof row.standLabel === 'string' && row.standLabel.trim() !== '') parts.push(`Stand ${row.standLabel.trim()}`);
  parts.push(row.kind === 'pwd' ? 'PWD' : 'Senior');
  parts.push(typeof row.idMasked === 'string' && MASKED.test(row.idMasked) ? row.idMasked : '****');
  return parts.join(` ${DOT} `);
}

export interface OpenedClaim {
  claimId: string;
  kind: ClaimKind;
  holderName: string;
  idNumber: string;
  sessionRef: string | null;
  partySize?: number;
}

export interface ClaimForm { kind: ClaimKind; name: string; idNo: string; cardSeen: boolean }

/** The dialog's form before anything is typed or after it closes: no name, no ID number, tick off. */
export const emptyClaimForm = (): ClaimForm => ({ kind: 'senior', name: '', idNo: '', cardSeen: false });

/** The tick always starts OFF: the cashier sees the card every time. */
export function prefillFromClaim(o: Pick<OpenedClaim, 'kind' | 'holderName' | 'idNumber'>): ClaimForm {
  return { kind: o.kind, name: o.holderName, idNo: o.idNumber, cardSeen: false };
}

export type SaveBlock = { ok: true } | { ok: false; reason: 'card-not-seen' | 'name' | 'id' | 'needs-seat'; message: string };

export function claimSaveBlock(form: { name: string; idNo: string; cardSeen: unknown }, sessionRef: string | null | undefined): SaveBlock {
  if (typeof sessionRef !== 'string' || sessionRef.trim() === '') return { ok: false, reason: 'needs-seat', message: 'Seat the party and start its table session first.' };
  if (typeof form.name !== 'string' || form.name.trim() === '') return { ok: false, reason: 'name', message: 'Enter the full name.' };
  if (typeof form.idNo !== 'string' || normalizeIdNo(form.idNo) === '') return { ok: false, reason: 'id', message: 'Enter the ID number.' };
  if (form.cardSeen !== true) return { ok: false, reason: 'card-not-seen', message: 'Tick the box once you have seen the card.' };
  return { ok: true };
}

export type ClaimFailure = { kind: 'unavailable' | 'refused' | 'error'; message: string };

/** 503 and "no answer" (status 0) are the one claims sentence; a 409 keeps the server's sentence; anything else is generic (never the raw message). */
export function claimFailure(err: { status?: unknown; message?: unknown } | null | undefined): ClaimFailure {
  const status = err && typeof err.status === 'number' ? err.status : null;
  if (status === 503 || status === 0) return { kind: 'unavailable', message: CLAIMS_UNAVAILABLE };
  if (status === 409) {
    const m = err && typeof err.message === 'string' && err.message.trim() !== '' ? err.message : GENERIC_ERROR;
    return { kind: 'refused', message: m };
  }
  return { kind: 'error', message: GENERIC_ERROR };
}

/** What a failed claims poll means for the screen: 503 / no answer hides the strip; anything else keeps the old list and shows one notice. */
export function claimPollOutcome(err: { status?: unknown; message?: unknown } | null | undefined): { down: boolean; notice: string | null } {
  return claimFailure(err).kind === 'unavailable' ? { down: true, notice: null } : { down: false, notice: CLAIMS_REFRESH_FAILED };
}

export type ApproveResult =
  | { done: true; dinerId: string }
  | { done: false; reason: 'blocked' | 'closed' | 'card-on-bill' | 'unavailable' | 'diner' | 'retry' | 'refused' | 'error'; message: string; dinerId?: string };

export interface ApproveFlowInput {
  open: OpenedClaim;
  form: ClaimForm;
  /** The diners already on the session (re-read before a retry). */
  diners: readonly { id: string; idNo: string; name?: string; kind?: string }[];
  /** Writes the T-426 diner through the one transactional writer. */
  addDiner: (e: { kind: ClaimKind; name: string; idNo: string }) => Promise<{ dinerId: string }>;
  approve: (b: { claimId: string; cardSeen: true; sessionRef: string; statutoryDinerRef: string }) => Promise<unknown>;
  /** Read BEFORE anything is written: only a `pending` claim goes on. */
  getStatus?: (claimId: string) => Promise<string>;
  /** After a 409: has the claim in fact been approved (a retry whose first call worked but whose answer was lost)? Optional. */
  isApproved?: (claimId: string) => Promise<boolean>;
}

/**
 * Writes the T-426 diner (once: a retry finds it by normalised ID), THEN approves the claim. If approve is refused the diner stays on the bill.
 * Never throws; the result never carries the holder name or the ID number.
 */
export async function approveClaimFlow(i: ApproveFlowInput): Promise<ApproveResult> {
  const block = claimSaveBlock(i.form, i.open.sessionRef);
  if (!block.ok) return { done: false, reason: 'blocked', message: block.message };
  const sessionRef = i.open.sessionRef as string;
  if (i.getStatus) {
    try {
      const status = await i.getStatus(i.open.claimId);
      if (status === 'approved') {
        // A lost-answer retry: approved, and this very person (ID, name, kind) is already on the bill. Done; nothing more is written or called.
        const wantedId = normalizeIdNo(i.form.idNo);
        const nm = (n: string) => n.trim().replace(/\s+/g, ' ').toUpperCase();
        const there = i.diners.find((d) => typeof d.idNo === 'string' && normalizeIdNo(d.idNo) === wantedId && typeof d.name === 'string' && nm(d.name) === nm(i.form.name) && d.kind === i.form.kind);
        if (there) return { done: true, dinerId: there.id };
      }
      if (status !== 'pending') return { done: false, reason: 'closed', message: CLAIM_CLOSED_MESSAGE };
    } catch (err) {
      const f = claimFailure(err as { status?: unknown; message?: unknown });
      return { done: false, reason: f.kind === 'unavailable' ? 'unavailable' : 'error', message: f.message };
    }
  }
  const wanted = normalizeIdNo(i.form.idNo);
  const sameName = (n: string) => n.trim().replace(/\s+/g, ' ').toUpperCase();
  const onBill = i.diners.find((d) => typeof d.idNo === 'string' && normalizeIdNo(d.idNo) === wanted);
  let dinerId: string | undefined;
  if (onBill) {
    // The same card is reused only when it is the same person and kind (a retry of this very claim); anything else is a different record.
    const same = typeof onBill.name === 'string' && sameName(onBill.name) === sameName(i.form.name) && onBill.kind === i.form.kind;
    if (!same) return { done: false, reason: 'card-on-bill', message: CARD_ON_BILL_MESSAGE };
    dinerId = onBill.id;
  }
  if (!dinerId) {
    try {
      dinerId = (await i.addDiner({ kind: i.form.kind, name: i.form.name.trim(), idNo: i.form.idNo.trim() })).dinerId;
    } catch (err) {
      const m = err instanceof Error && err.message.trim() !== '' ? err.message : 'Could not save the diner on this bill.';
      return { done: false, reason: 'diner', message: m };
    }
  }
  try {
    await i.approve({ claimId: i.open.claimId, cardSeen: true, sessionRef, statutoryDinerRef: dinerId });
    return { done: true, dinerId };
  } catch (err) {
    const f = claimFailure(err as { status?: unknown; message?: unknown });
    if (f.kind === 'unavailable') return { done: false, reason: 'retry', message: CLAIM_RETRY_MESSAGE, dinerId };
    if (f.kind === 'refused') {
      // A retry whose first call succeeded but whose answer was lost: the claim is already approved, so show it as done.
      if (i.isApproved) {
        try {
          if (await i.isApproved(i.open.claimId)) return { done: true, dinerId };
        } catch {
          /* fall through to the refusal */
        }
      }
      return { done: false, reason: 'refused', message: f.message, dinerId };
    }
    return { done: false, reason: 'error', message: f.message, dinerId };
  }
}

export type RejectResult = { done: true } | { done: false; reason: 'blocked' | 'failed'; message: string };

/** Rejects with a fixed reason code only; an unknown code is blocked before any call. Never throws. */
export async function rejectClaimFlow(i: {
  claimId: string;
  reasonCode: unknown;
  reject: (b: { claimId: string; reasonCode: string }) => Promise<unknown>;
}): Promise<RejectResult> {
  if (rejectReasonText(i.reasonCode) === null) return { done: false, reason: 'blocked', message: 'Choose one of the reasons.' };
  try {
    await i.reject({ claimId: i.claimId, reasonCode: i.reasonCode as string });
    return { done: true };
  } catch (err) {
    return { done: false, reason: 'failed', message: claimFailure(err as { status?: unknown; message?: unknown }).message };
  }
}
