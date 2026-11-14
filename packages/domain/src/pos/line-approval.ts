/**
 * T-576 - the manager approval on a LINE action (cancel a line, give or remove a line discount, discount every line), switched by the business rule
 * `pos.require_pin_line_actions`.
 *
 * The PIN never rides in an outbox event. While online the till first asks `grantLineApproval` (POST /api/pos/line-approval): it checks the PIN as the whole-table void does
 * (a wrong PIN is charged and committed there and then, and refused at once) and answers a signed token good for LINE_APPROVAL_TTL_MS, bound to the store, the pairing, the
 * approver, the action and the one target. The event carries `approval: { token, approverId, exp }`; `gateLineAction` checks the signature and the expiry.
 *
 * Rule OFF (the default) -> `gateLineAction` returns {} and does nothing, so today's behaviour is untouched.
 * Rule ON  -> { approvedBy } when approved; with no approval and `offline: true` the action goes through and `pos.line_action_unapproved` is audited for a manager (the server cannot see
 *            whether the till really was offline, so it trusts the flag but never silently); with no approval otherwise it is refused. An approval that is sent must always be good.
 * A replayed quarantined event: the replaying manager, who holds approve_pos_correction, is the approval (`replayApprovedBy`).
 * Carry-over (T-563): the token is signed for the pairing the event was MADE on (`madeOnPairingId`), so an event made on P1 and drained under cookie P2 of the same store after a re-pair still applies.
 * The fail-closed window: a token minted under P2 for an event still stamped P1 (before the snapshot rebinds the till) does not match, is refused, and the event quarantines for a manager's replay.
 */
import { authorize, can, posLineApprovalMatches, signPosLineApproval, verifyPosManagerApproval, POS_TERMINAL_NOT_REGISTERED, type Actor } from '@shareat/auth';
import { posV2Repo, type Tx } from '@shareat/db';
import { money, toCentavos } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { parseDecimalInput } from '../shared/money-input';
import { audit, businessDateAndRules, requireContext, uuidInput, wholeNumber, type PosDeps } from './shared';

export const LINE_ACTION_NEEDS_PIN = 'A manager PIN is needed for this. Ask a manager.';
export const LINE_APPROVAL_INVALID = 'That manager approval has expired or does not fit this action. Ask a manager again.';
/** A security window, not a business setting: how long a manager's approval stays good once given. */
export const LINE_APPROVAL_TTL_MS = 15 * 60_000;
export const LINE_ACTIONS = ['line.cancelled', 'discount.added', 'discount.removed', 'discount.applied_to_all'] as const;
export type LineAction = (typeof LINE_ACTIONS)[number];

/** What the route hands the till, and what the till puts in the event. */
export interface LineApprovalGrant {
  token: string;
  approverId: string;
  /** Epoch milliseconds. */
  exp: number;
}

/** What a device (or the replay) may add to a line action's input. */
export interface LineApprovalInput {
  approval?: LineApprovalGrant;
  offline?: boolean;
  /** Set only by the inbox's replay, never from a device payload (the event schema refuses it). */
  replayApprovedBy?: string;
  /** Set only by the inbox: the pairing the event was made under (for a carried-over event, the origin tablet's). Never from a device payload. */
  madeOnPairingId?: string;
}

const NO_TX = null;

/** The discount fields an approval is bound to (raw, from a request body or from the event's own payload). */
export interface LineDetailInput {
  kind?: unknown;
  presetId?: unknown;
  valueType?: unknown;
  value?: unknown;
  qty?: unknown;
  /** discount.added only: the line the discount goes on. */
  lineId?: unknown;
}

/**
 * The ONE place the signed "what was approved" text is built, used by both the grant and the gate, so a token for 10% cannot pay for 100%, nor a swapped preset.
 * `kind|presetId|valueType|value|qty|lineId`; the value is whole centavos (basis points for a percent), never the raw string. A preset's own value is the server's, so it is not in the text.
 * Apply-to-all is a preset on every line: no kind, value or units to name. Cancel and remove: ''.
 */
export function lineApprovalDetail(action: LineAction, d: LineDetailInput = {}): string {
  if (action === 'discount.applied_to_all') return ['preset', uuidInput(d.presetId, 'The discount'), '', '', ''].join('|');
  if (action !== 'discount.added') return '';
  const qty = `${wholeNumber(d.qty, { what: 'The number of units', min: 1, max: 999 })}|${uuidInput(d.lineId, 'The line')}`;
  if (d.kind === 'preset') return ['preset', uuidInput(d.presetId, 'The discount'), '', '', qty].join('|');
  if (d.kind === 'custom' && (d.valueType === 'percent' || d.valueType === 'fixed')) {
    const cents = toCentavos(money(parseDecimalInput(String(d.value ?? ''), '14,2', 'pos: the discount value', 'The discount')));
    return ['custom', '', d.valueType, String(cents), qty].join('|');
  }
  throw refuse('pos: approval for an unknown discount', 'A manager approves a preset or a custom discount here.');
}

/** Checks the manager's PIN for one line action and signs the approval. A wrong PIN is charged and committed at once, whatever happens to the caller's transaction. */
export async function grantLineApproval(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; pairingId: string | null; pin: unknown; action: unknown; targetId: unknown; /** The discount's kind / presetId / valueType / value / qty (discount.added), or the presetId (apply to all). */ detail?: LineDetailInput },
  deps?: PosDeps,
): Promise<LineApprovalGrant> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const action = LINE_ACTIONS.find((a) => a === input.action);
  if (!action) throw refuse('pos: unknown line action', 'That action is not one a manager approves here.');
  const targetId = uuidInput(input.targetId, 'The line');
  const detail = lineApprovalDetail(action, input.detail);
  if (typeof input.pin !== 'string' || input.pin === '') throw refuse('pos: approval without a PIN', LINE_ACTION_NEEDS_PIN);
  // As the void does (audit F8): the PIN bucket a wrong PIN charges is the store's own registered terminal, never a value the device names.
  const terminalPersonId = await posV2Repo.getActiveTerminalPersonId(tx, actor.orgId, input.storeId);
  if (!terminalPersonId) throw refuse('pos: no terminal link for the store', POS_TERMINAL_NOT_REGISTERED);
  const { approverPersonId } = await verifyPosManagerApproval(NO_TX, { orgId: actor.orgId, erpStoreId: input.storeId, pin: input.pin, terminalPersonId });
  const exp = (deps?.now?.() ?? new Date()).getTime() + LINE_APPROVAL_TTL_MS;
  const token = signPosLineApproval({ orgId: actor.orgId, storeId: input.storeId, pairingId: pairingId!, approverId: approverPersonId, action, targetId, exp, detail });
  return { token, approverId: approverPersonId, exp };
}

export async function gateLineAction(
  tx: Tx,
  actor: Actor,
  o: { storeId: string; pairingId: string | null; sessionId: string; lineIds: string[]; action: LineAction; /** The one thing approved: the line, the NEW discount's id (discount.added: single-use), the discount removed, or (apply to all) the table. */ targetId: string; /** The discount fields from the event's own payload; the gate recomputes the signed detail from them. */ detail?: LineDetailInput; at?: Date; deps: PosDeps | undefined; input: LineApprovalInput },
): Promise<{ approvedBy?: string }> {
  const { rules } = await businessDateAndRules(tx, actor.orgId, o.storeId, o.deps, o.at);
  if (rules.requirePinLineActions !== true) return {};
  if (o.input.replayApprovedBy) return { approvedBy: o.input.replayApprovedBy };
  if (await can(tx, actor, 'approve_pos_correction', { storeId: o.storeId })) return { approvedBy: actor.personId };
  const a = o.input.approval;
  if (a) {
    const detail = lineApprovalDetail(o.action, o.detail);
    const claim = { orgId: actor.orgId, storeId: o.storeId, pairingId: o.input.madeOnPairingId ?? o.pairingId ?? '', approverId: a.approverId, action: o.action, targetId: o.targetId, exp: a.exp, detail };
    if (!posLineApprovalMatches(claim, a.token) || a.exp <= (o.deps?.now?.() ?? new Date()).getTime()) throw refuse('pos: line approval not valid', LINE_APPROVAL_INVALID);
    return { approvedBy: a.approverId };
  }
  if (o.input.offline !== true) throw refuse('pos: line action needs a manager PIN', LINE_ACTION_NEEDS_PIN);
  for (const lineId of o.lineIds) {
    await audit(tx, actor, 'pos.line_action_unapproved', { storeId: o.storeId, entityId: lineId, pairingId: o.pairingId, at: o.at ?? new Date(), after: { tableId: o.sessionId, lineId, action: o.action } });
  }
  return {};
}
