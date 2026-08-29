'use server';

/**
 * The order thread's one action — T-175.
 *
 * ⭐ `postOrderMessage` owns the rule that BOTH stores on the order may talk about it (T-173
 * invariant 8, applied to talking as well as confirming). This file resolves WHICH of the actor's
 * stores that is, and authorises against it.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { authorize } from '@shareat/auth';
import { lowStockRepo, schema, transaction } from '@shareat/db';
import { postOrderMessage } from '@shareat/domain';
import { requireActor } from '../../../../lib/session';

export async function postMessageAction(fd: FormData): Promise<void> {
  const actor = await requireActor();
  const orderId = typeof fd.get('orderId') === 'string' ? String(fd.get('orderId')).trim() : '';
  const body = typeof fd.get('body') === 'string' ? String(fd.get('body')) : '';

  const result = await transaction(async (tx) => {
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
