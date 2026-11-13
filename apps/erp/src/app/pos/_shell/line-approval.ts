/**
 * T-576 - when the store's rule asks for a manager PIN on a line cancel / line discount / discount removal, what the till does. Pure: no React, no storage.
 *   none   - the rule is off (or an older cached snapshot does not carry it): nothing changes.
 *   pin    - the rule is on and the till is online: ask the server (POST /api/pos/line-approval) BEFORE the action is saved. A wrong PIN is refused on the spot and the action is not
 *            applied; a right one returns a signed token, and the event carries that token. The PIN itself is never put in the event, so it never sits in the tablet's outbox.
 *   review - the rule is on and the till is offline: go ahead, tell the cashier it needs manager review, and send `offline: true` (the server then writes a review row).
 */
export type LineApprovalMode = 'none' | 'pin' | 'review';

export const lineApprovalMode = (rule: boolean | null | undefined, online: boolean): LineApprovalMode => (rule !== true ? 'none' : online ? 'pin' : 'review');

export const REVIEW_NOTE = 'Needs manager review. It goes through now and a manager checks it later.';
export const PIN_LABEL = 'Manager PIN';
export const PIN_NEEDED = 'Type the manager PIN.';
export const APPROVAL_UNREACHABLE = 'Could not reach the server to check the manager PIN. Try again.';

/** The server's signed approval for one action on one target (the event's `approval`). */
export interface LineApprovalGrant {
  token: string;
  approverId: string;
  exp: number;
}
export type LineActionKind = 'line.cancelled' | 'discount.added' | 'discount.removed' | 'discount.applied_to_all';

/** The optional payload fields of an event. */
export type ApprovalFields = { approval?: LineApprovalGrant; offline?: true };

const isGrant = (v: unknown): v is LineApprovalGrant => {
  const g = v as Partial<LineApprovalGrant> | null;
  return !!g && typeof g.token === 'string' && typeof g.approverId === 'string' && typeof g.exp === 'number';
};

/**
 * The fields to put in the event, or the sentence to show in the dialog (and then do nothing). `none` -> no fields; `review` -> offline: true; `pin` -> ask the server with the typed PIN.
 * Never throws; a failed request is the one "could not reach" sentence.
 */
export async function resolveApproval(o: { mode: LineApprovalMode; pin: string; action: LineActionKind; targetId: string; /** A discount's kind / presetId / valueType / value / qty (apply to all: presetId): the server binds the token to them. */ detail?: Record<string, string | number | undefined>; fetch: typeof fetch }): Promise<{ fields: ApprovalFields } | { error: string }> {
  if (o.mode === 'review') return { fields: { offline: true } };
  if (o.mode !== 'pin') return { fields: {} };
  if (o.pin === '') return { error: PIN_NEEDED };
  try {
    const res = await o.fetch('/api/pos/line-approval', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...o.detail, pin: o.pin, action: o.action, targetId: o.targetId }),
    });
    const j = (await res.json().catch(() => null)) as ({ error?: unknown } & Partial<LineApprovalGrant>) | null;
    if (res.ok && isGrant(j)) return { fields: { approval: { token: j.token, approverId: j.approverId, exp: j.exp } } };
    return { error: typeof j?.error === 'string' && j.error !== '' ? j.error : APPROVAL_UNREACHABLE };
  } catch {
    return { error: APPROVAL_UNREACHABLE };
  }
}
