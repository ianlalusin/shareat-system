'use server';

/**
 * The order's actions — T-175's thread, and since 2026-09-03 the whole T-172 conversation
 * (DEF-136): the branch's draft edits, submit, its answer to a proposal, its withdrawal and its
 * receipt; the commissary's accept, reject, fulfilment, proposal, ready and dispatch.
 *
 * ⭐ Thin adapters, every one. The actor comes from the session, never the form; each domain
 * function authorises the right capability at the RIGHT STORE as its first statement — the branch
 * side against `requested_by_store_id`, the commissary side against `store_id` — which is how
 * "each field has exactly one owner" (T-172 invariant 10) is enforced. Nothing here decides who
 * may do what; it only says what happened, or why not.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { authorize, type Actor } from '@shareat/auth';
import { lowStockRepo, schema, type Tx } from '@shareat/db';
import { SHORTAGE_REASONS, type ShortageReason } from '@shareat/db/schema';
import {
  acceptOrder,
  addBranchOrderLine,
  decideProposedLine,
  dispatchBranchOrder,
  fulfilLine,
  markReady,
  postOrderMessage,
  proposeLine,
  receiveTradeOrder,
  rejectOrder,
  removeBranchOrderLine,
  submitOrder,
  updateBranchOrderLine,
  voidTradeOrder,
} from '@shareat/domain';
import { requireActor } from '../../../../lib/session';
import { errorMessageOf, withOrgPrincipal } from '../lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

function back(orderId: string, params: Record<string, string>): never {
  redirect(`/commissary/orders/${orderId}?${new URLSearchParams(params).toString()}`);
}

/** One shape for every action: run the domain under the org principal, then say what happened. */
async function perform(orderId: string, fn: (tx: Tx, actor: Actor) => Promise<string>): Promise<void> {
  const actor = await requireActor(`/commissary/orders/${orderId}`);
  let message = '';
  try {
    message = await withOrgPrincipal(actor.orgId, (tx) => fn(tx, actor));
  } catch (err) {
    back(orderId, { error: errorMessageOf(err) });
  }
  revalidatePath('/commissary/orders');
  revalidatePath(`/commissary/orders/${orderId}`);
  back(orderId, { ok: message });
}

// ---- T-175: the thread ---------------------------------------------------------------------------

export async function postMessageAction(fd: FormData): Promise<void> {
  const actor = await requireActor();
  const orderId = str(fd, 'orderId');
  const body = typeof fd.get('body') === 'string' ? String(fd.get('body')) : '';

  const result = await withOrgPrincipal(actor.orgId, async (tx) => {
    const parties = await lowStockRepo.orderParties(tx, orderId);
    if (!parties) return { ok: false as const, reason: 'that order does not exist' };

    // ⚠️ The actor's OWN scope, read from the database — never from the form. It is both the
    // authorisation input and the "are you on this order" input, so a client-supplied value would
    // defeat the two-sided check entirely (T-138, and `no-client-supplied-actor` holds it closed).
    const scope = await tx
      .select({ storeId: schema.personStoreScope.storeId })
      .from(schema.personStoreScope)
      .where(eq(schema.personStoreScope.personId, actor.personId));
    const actorStoreIds = scope.map((s) => s.storeId);

    // ⭐ Authorise against the store that is actually ON the order. An earlier draft looped over
    // every scope and broke on the first success — which fell through silently when NONE
    // succeeded, authorising nobody. One explicit intersection, one check.
    const onThisOrder = actorStoreIds.find(
      (id) => id === parties.commissaryStoreId || id === parties.branchStoreId,
    );
    if (!onThisOrder) {
      return { ok: false as const, reason: 'only the two stores on this order can talk about it' };
    }
    await authorize(tx, actor, 'post_order_message', { storeId: onThisOrder });

    return postOrderMessage(tx, {
      orgId: actor.orgId,
      orderId,
      body,
      authorId: actor.personId,
      actorStoreIds,
    });
  });

  if (!result.ok) {
    redirect(`/commissary/orders/${orderId}?error=${encodeURIComponent(result.reason)}`);
  }
  revalidatePath(`/commissary/orders/${orderId}`);
}

// ---- The branch's side ----------------------------------------------------------------------------

export async function addLineAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await addBranchOrderLine(tx, actor, {
      orderId,
      itemId: str(fd, 'itemId'),
      quantity: str(fd, 'quantity'),
      rate: str(fd, 'rate') || null,
    });
    return 'Line added.';
  });
}

export async function updateLineAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await updateBranchOrderLine(tx, actor, {
      orderId,
      lineId: str(fd, 'lineId'),
      quantity: str(fd, 'quantity'),
      rate: str(fd, 'rate') || null,
    });
    return 'Line updated.';
  });
}

export async function removeLineAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await removeBranchOrderLine(tx, actor, { orderId, lineId: str(fd, 'lineId') });
    return 'Line removed.';
  });
}

export async function submitOrderAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await submitOrder(tx, actor, { orderId });
    return 'Submitted. The commissary will accept it and pack it; you will see what they change here.';
  });
}

export async function decideLineAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  const decision = str(fd, 'decision') === 'approved' ? 'approved' : 'rejected';
  await perform(orderId, async (tx, actor) => {
    await decideProposedLine(tx, actor, { orderId, lineId: str(fd, 'lineId'), decision });
    return decision === 'approved'
      ? 'Approved — the line now counts toward the order.'
      : 'Declined — the line will not be sent or charged.';
  });
}

/** Withdraw (branch) or cancel (commissary) before dispatch; void after it. One domain function. */
export async function withdrawOrderAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    const result = await voidTradeOrder(tx, actor, { orderId, reason: str(fd, 'reason') });
    return result.reversedEntryId
      ? 'Voided. The dispatch posting is reversed — never deleted — and the stock is back on the commissary\'s shelf.'
      : 'Cancelled. Nothing had moved, so nothing needed reversing. The branch may order again.';
  });
}

export async function receiveOrderAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  const lineIds = strs(fd, 'lineId');
  const received = strs(fd, 'receivedQuantity');
  const reasons = strs(fd, 'shortageReason');
  const lines = lineIds
    .map((lineId, i) => ({
      lineId,
      receivedQuantity: received[i] || null,
      shortageReason: (SHORTAGE_REASONS as readonly string[]).includes(reasons[i] ?? '')
        ? (reasons[i] as ShortageReason)
        : null,
    }))
    .filter((l) => l.lineId);
  await perform(orderId, async (tx, actor) => {
    const result = await receiveTradeOrder(tx, actor, {
      orderId,
      receivedOn: str(fd, 'receivedOn') || undefined,
      lines: lines.length > 0 ? lines : undefined,
    });
    return result.entryId
      ? 'Receipt confirmed. Both stores\' books moved on what was actually signed for; any shortfall is an open transit discrepancy for the commissary to dispose of.'
      : 'Receipt recorded. Nothing was accepted into stock — every line was short to zero or blocked — so the value stays in transit.';
  });
}

// ---- The commissary's side ------------------------------------------------------------------------

export async function acceptOrderAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await acceptOrder(tx, actor, { orderId });
    return 'Accepted. Every line now carries the quantity asked for — adjust what you will actually send, then mark it ready.';
  });
}

export async function rejectOrderAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await rejectOrder(tx, actor, { orderId, reason: str(fd, 'reason') });
    return 'Rejected. The branch sees your reason on the thread and may order again.';
  });
}

export async function fulfilLineAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await fulfilLine(tx, actor, {
      orderId,
      lineId: str(fd, 'lineId'),
      quantity: str(fd, 'quantity'),
      rate: str(fd, 'rate') || null,
      sourceLocationId: str(fd, 'sourceLocationId') || null,
    });
    return 'Fulfilment saved.';
  });
}

export async function proposeLineAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await proposeLine(tx, actor, {
      orderId,
      itemId: str(fd, 'itemId'),
      quantity: str(fd, 'quantity'),
      rate: str(fd, 'rate') || null,
      sourceLocationId: str(fd, 'sourceLocationId') || null,
      replacesLineId: str(fd, 'replacesLineId') || null,
      note: str(fd, 'note') || null,
    });
    return 'Proposed. It counts toward nothing until the branch approves it, and the order cannot be marked ready until they answer.';
  });
}

export async function markReadyAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    await markReady(tx, actor, { orderId });
    return 'Marked ready — the list is final. A manager can now dispatch it.';
  });
}

export async function dispatchOrderAction(fd: FormData): Promise<void> {
  const orderId = str(fd, 'orderId');
  await perform(orderId, async (tx, actor) => {
    const result = await dispatchBranchOrder(tx, actor, { orderId });
    return (
      `Dispatched. The goods are in transit at cost (1340) and the commissary's stock is relieved` +
      ` — entry ${result.entryId.slice(0, 8)}…. Both stores' books move when the branch confirms what actually arrived.`
    );
  });
}
