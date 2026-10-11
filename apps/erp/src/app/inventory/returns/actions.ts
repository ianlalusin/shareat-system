'use server';

/**
 * Server actions for the supplier-returns screen — T-170.
 *
 * Thin adapters: parse `FormData`, call the domain, revalidate. ⭐ The actor comes from the
 * session, never the form (T-138) — authorization itself is `recordReturn`/`voidReturn`'s own
 * first statement, not repeated here.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { redirectWithFlash, type Nav } from '@/lib/flash';
import { revalidatePath } from 'next/cache';
import { recordReturn, refundSupplierCredit, voidReturn } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function recordReturnAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/returns');
  const storeId = str(fd, 'storeId');
  const supplierId = str(fd, 'supplierId');
  const deliveryId = str(fd, 'deliveryId') || null;
  const deliveryLineId = str(fd, 'deliveryLineId') || null;
  const itemId = str(fd, 'itemId');
  const itemKind = str(fd, 'itemKind');
  const locationId = str(fd, 'locationId');
  const qty = str(fd, 'quantity');
  const reason = str(fd, 'reason');

  // T-376 S2: like voidReturnAction, a refusal ({ok:false} or a thrown RefusalError) reaches the person as a
  // `?error=` banner, never a thrown error (a production build shows that as a digest); success says so.
  const keep: Nav = storeId ? { store: storeId } : {};
  let result: Awaited<ReturnType<typeof recordReturn>>;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordReturn(tx, {
        storeId,
        supplierId,
        deliveryId,
        returnedOn: toBusinessDate(),
        reason,
        // T-371 S3: the raw figure goes to the domain, which parses it after `authorize()` (R5).
        lines: [{ itemId, itemKind, locationId, quantity: qty, deliveryLineId }],
        actor,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/inventory/returns', keep, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash('/inventory/returns', keep, { error: errorMessage(new Error(result.reason ?? 'The return could not be recorded.')) });

  revalidatePath('/inventory/returns');
  return await redirectWithFlash('/inventory/returns', keep, { ok: 'Return recorded. The stock is taken out, and the supplier owes us the credit.' });
}

export async function voidReturnAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/returns');
  const returnId = str(fd, 'returnId');
  const reason = str(fd, 'reason');

  // The refusal reaches the person as a banner, never a thrown error (a production build shows a thrown
  // server-action error as a digest): `{ok:false}` and a thrown RefusalError both end up in `?error=`.
  const store = str(fd, 'store');
  const keep: Nav = store ? { store } : {};
  let result: Awaited<ReturnType<typeof voidReturn>>;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => voidReturn(tx, actor, returnId, reason));
  } catch (err) {
    return await redirectWithFlash('/inventory/returns', keep, { error: errorMessage(err) });
  }
  // The same redaction as the thrown path (an id inside a reason never reaches the page).
  if (!result.ok) return await redirectWithFlash('/inventory/returns', keep, { error: errorMessage(new Error(result.reason ?? 'The return could not be voided.')) });

  revalidatePath('/inventory/returns');
  return await redirectWithFlash('/inventory/returns', keep, { stamp: 'VOID', ok: 'Return voided. The stock is given back and the credit it held is reversed.' });
}

export async function refundCreditAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/returns');
  const storeId = str(fd, 'storeId');
  const supplierId = str(fd, 'supplierId');
  const moneyAccountId = str(fd, 'moneyAccountId');
  const amount = str(fd, 'amount');

  const keep: Nav = storeId ? { store: storeId } : {};
  let result: Awaited<ReturnType<typeof refundSupplierCredit>>;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      refundSupplierCredit(tx, {
        storeId,
        supplierId,
        moneyAccountId,
        amount,
        businessDate: toBusinessDate(),
        actor,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/inventory/returns', keep, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash('/inventory/returns', keep, { error: errorMessage(new Error(result.reason ?? 'The refund could not be recorded.')) });

  revalidatePath('/inventory/returns');
  return await redirectWithFlash('/inventory/returns', keep, { ok: "Refund recorded. The supplier's credit is reduced by what they paid back." });
}
