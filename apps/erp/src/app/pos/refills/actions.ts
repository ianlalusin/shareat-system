'use server';

/**
 * T-529 R2 - a server's phone asks for a refill or confirms a table's head count (row 447). No pairing, online only: each call is the T-524 function with
 * `pairingId: null`, which authorizes `request_pos_refill` / `confirm_pos_heads` at the store and owns every refusal sentence. ⛔ No rule here.
 * The tablet does NOT use these: it sends `refill.requested` through the outbox. A domain refusal comes back as a RESULT, never a thrown error.
 */
import { confirmHeads, requestRefill } from '@shareat/domain';
import { requireActor } from '@/lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { withOrgPrincipal } from '../../expenses/lib';
import { actionStore } from '../_shell/action-store';

const ROUTE = '/pos/refills';

export type WriteResult = { ok: true; wrote: boolean } | { ok: false; error: string };

export async function requestRefillAction(input: { storeId: string; sessionId: string; lines: { lineId: string; menuItemId: string; qty: number; optionValueIds?: string[] }[] }): Promise<WriteResult> {
  const actor = await requireActor(ROUTE);
  const store = await actionStore(actor, input?.storeId);
  if ('error' in store) return { ok: false, error: store.error };
  try {
    const at = new Date();
    const lines = (Array.isArray(input.lines) ? input.lines : []).map((l) => ({ lineId: l.lineId, menuItemId: l.menuItemId, qty: l.qty, addedAtDevice: at, ...(l.optionValueIds ? { optionValueIds: l.optionValueIds } : {}) }));
    const r = await withOrgPrincipal(actor.orgId, (tx) => requestRefill(tx, actor, { storeId: store.storeId, pairingId: null, sessionId: input.sessionId, lines }));
    return { ok: true, wrote: r.wrote };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function confirmHeadsAction(input: { storeId: string; sessionId: string; headsServer: number }): Promise<WriteResult> {
  const actor = await requireActor(ROUTE);
  const store = await actionStore(actor, input?.storeId);
  if ('error' in store) return { ok: false, error: store.error };
  try {
    const r = await withOrgPrincipal(actor.orgId, (tx) => confirmHeads(tx, actor, { storeId: store.storeId, pairingId: null, sessionId: input.sessionId, headsServer: input.headsServer }));
    return { ok: true, wrote: r.wrote };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
