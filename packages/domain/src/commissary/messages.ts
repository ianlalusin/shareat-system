/**
 * The conversation that belongs to an order — T-175.
 *
 * ⭐ A discrepancy or a substitution gets discussed somewhere, and in v1 that somewhere was a phone
 * call. Putting it on the order means the reason a line changed survives the people who changed it.
 *
 * ⚠️ **Append-only, and that is the whole value.** It is the audit trail of a commercial
 * conversation between two stores, and an editable audit trail is not one. Enforced by
 * `trade_order_messages_append_only_trg` rather than by this module — DEF-041's lesson stated
 * plainly: *an invariant phrased as "our code does not do X" is a convention, not an invariant.*
 *
 * ⛔ **No attachments, no read receipts, no notifications.** In-app notification is its own
 * deferred gap in `CAPABILITY-GAPS.md`; bolting half of it on here is how a trail stops being one.
 */
import { lowStockRepo, type Tx } from '@shareat/db';
import type { Outcome } from './outcome';

export interface PostMessageInput {
  readonly orgId: string;
  readonly orderId: string;
  readonly body: string;
  readonly authorId: string;
  /** The stores this principal may act for. ⭐ Either side of the order is legitimate. */
  readonly actorStoreIds: readonly string[];
}

export const MAX_MESSAGE_LENGTH = 2000;

export async function postOrderMessage(
  tx: Tx,
  input: PostMessageInput,
): Promise<Outcome<{ id: string }>> {
  const body = input.body.trim();
  if (body.length === 0) return { ok: false, reason: 'a message needs something in it' };
  if (body.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: `a message is at most ${MAX_MESSAGE_LENGTH} characters` };
  }

  const parties = await lowStockRepo.orderParties(tx, input.orderId);
  if (!parties) return { ok: false, reason: `order ${input.orderId} does not exist` };

  // ⭐ BOTH sides are in this conversation — T-173 invariant 8's rule, applied to talking as well
  // as to confirming. ⚠️ A one-sided check would break the highest-volume commissary flow: the
  // branch reporting a short crate is exactly the message worth having.
  const allowed = new Set([parties.commissaryStoreId, parties.branchStoreId].filter(Boolean) as string[]);
  if (!input.actorStoreIds.some((id) => allowed.has(id))) {
    return { ok: false, reason: 'only the two stores on this order can talk about it' };
  }

  const row = await lowStockRepo.postMessage(tx, {
    orgId: input.orgId, orderId: input.orderId, body, authorId: input.authorId,
  });
  return { ok: true, id: row.id };
}

export async function listOrderMessages(
  tx: Tx,
  input: { orderId: string; actorStoreIds: readonly string[] },
): Promise<Outcome<{ messages: readonly { id: string; body: string; authorId: string; createdAt: Date }[] }>> {
  const parties = await lowStockRepo.orderParties(tx, input.orderId);
  if (!parties) return { ok: false, reason: `order ${input.orderId} does not exist` };
  const allowed = new Set([parties.commissaryStoreId, parties.branchStoreId].filter(Boolean) as string[]);
  if (!input.actorStoreIds.some((id) => allowed.has(id))) {
    return { ok: false, reason: 'only the two stores on this order can read it' };
  }
  return { ok: true, messages: await lowStockRepo.listMessages(tx, input.orderId) };
}
