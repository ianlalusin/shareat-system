'use server';

/**
 * Server actions for the supplier-returns screen — T-170.
 *
 * Thin adapters: parse `FormData`, call the domain, revalidate. ⭐ The actor comes from the
 * session, never the form (T-138) — authorization itself is `recordReturn`/`voidReturn`'s own
 * first statement, not repeated here.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { quantity, recordReturn, refundSupplierCredit, voidReturn } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(params: Record<string, string>): never {
  redirect(`/inventory/returns?${new URLSearchParams(params).toString()}`);
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

  const result = await withOrgPrincipal(actor.orgId, (tx) =>
    recordReturn(tx, {
      storeId,
      supplierId,
      deliveryId,
      returnedOn: new Date().toISOString().slice(0, 10),
      reason,
      lines: [{ itemId, itemKind, locationId, quantity: quantity(qty), deliveryLineId }],
      actor,
    }),
  );
  if (!result.ok) throw new Error(result.reason);

  revalidatePath('/inventory/returns');
}

export async function voidReturnAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/returns');
  const returnId = str(fd, 'returnId');
  const reason = str(fd, 'reason');

  // The refusal reaches the person as a banner, never a thrown error (a production build shows a thrown
  // server-action error as a digest): `{ok:false}` and a thrown RefusalError both end up in `?error=`.
  const store = str(fd, 'store');
  const keep: Record<string, string> = store ? { store } : {};
  let result: Awaited<ReturnType<typeof voidReturn>>;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => voidReturn(tx, actor, returnId, reason));
  } catch (err) {
    back({ ...keep, error: errorMessage(err) });
  }
  // The same redaction as the thrown path (an id inside a reason never reaches the page).
  if (!result!.ok) back({ ...keep, error: errorMessage(new Error(result!.reason ?? 'The return could not be voided.')) });

  revalidatePath('/inventory/returns');
  back({ ...keep, ok: 'Return voided. The stock is given back and the credit it held is reversed.' });
}

export async function refundCreditAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/returns');
  const storeId = str(fd, 'storeId');
  const supplierId = str(fd, 'supplierId');
  const moneyAccountId = str(fd, 'moneyAccountId');
  const amount = str(fd, 'amount');

  const result = await withOrgPrincipal(actor.orgId, (tx) =>
    refundSupplierCredit(tx, {
      storeId,
      supplierId,
      moneyAccountId,
      amount,
      businessDate: new Date().toISOString().slice(0, 10),
      actor,
    }),
  );
  if (!result.ok) throw new Error(result.reason);

  revalidatePath('/inventory/returns');
}
