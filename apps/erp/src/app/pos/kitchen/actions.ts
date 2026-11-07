'use server';

/**
 * T-529 R1 - the Kitchen tab's writes: mark a line served, or a whole card ("All out"). A kitchen browser has no pairing and works online only (A9), so
 * each call is T-524 `serveLine` with `pairingId: null`, which authorizes `serve_pos_ticket` at the store. ⛔ No rule is re-implemented here.
 * A domain refusal comes back as a RESULT with the domain's own sentence (the caller is a client component, which must not see a thrown error).
 */
import { serveLine } from '@shareat/domain';
import { requireActor } from '@/lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { withOrgPrincipal } from '../../expenses/lib';
import { actionStore } from '../_shell/action-store';

const ROUTE = '/pos/kitchen';
/** More lines than one card can hold. A guard on the request, not a business setting. */
const MAX_LINES = 200;

export type ServeResult = { ok: true; wrote: boolean } | { ok: false; error: string };
export interface ServeAllResult {
  ok: boolean;
  saved: string[];
  alreadyServed: string[];
  failed: { lineId: string; error: string }[];
}

export async function serveLineAction(input: { storeId: string; lineId: string }): Promise<ServeResult> {
  const actor = await requireActor(ROUTE);
  const store = await actionStore(actor, input?.storeId);
  if ('error' in store) return { ok: false, error: store.error };
  try {
    const r = await withOrgPrincipal(actor.orgId, (tx) => serveLine(tx, actor, { storeId: store.storeId, pairingId: null, lineId: input.lineId, servedAtDevice: new Date() }));
    return { ok: true, wrote: r.wrote };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** One `serveLine` per line, each in its OWN transaction: a refusal on one line never undoes another. Every list keeps the order of `lineIds`. */
export async function serveAllAction(input: { storeId: string; lineIds: string[] }): Promise<ServeAllResult> {
  const actor = await requireActor(ROUTE);
  const out: ServeAllResult = { ok: true, saved: [], alreadyServed: [], failed: [] };
  const lineIds = Array.isArray(input?.lineIds) ? input.lineIds.filter((l): l is string => typeof l === 'string').slice(0, MAX_LINES) : [];
  const store = await actionStore(actor, input?.storeId);
  if ('error' in store) return { ok: false, saved: [], alreadyServed: [], failed: lineIds.map((lineId) => ({ lineId, error: store.error })) };
  for (const lineId of lineIds) {
    try {
      const r = await withOrgPrincipal(actor.orgId, (tx) => serveLine(tx, actor, { storeId: store.storeId, pairingId: null, lineId, servedAtDevice: new Date() }));
      (r.wrote ? out.saved : out.alreadyServed).push(lineId);
    } catch (err) {
      out.failed.push({ lineId, error: errorMessage(err) });
    }
  }
  out.ok = out.failed.length === 0;
  return out;
}
