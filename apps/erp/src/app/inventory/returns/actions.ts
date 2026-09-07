'use server';

/**
 * Server actions for the supplier-returns screen — T-170.
 *
 * Thin adapters: parse `FormData`, call the domain, revalidate. ⭐ The actor comes from the
 * session, never the form (T-138) — authorization itself is `recordReturn`/`voidReturn`'s own
 * first statement, not repeated here.
 */
import { revalidatePath } from 'next/cache';
import { transaction } from '@shareat/db';
import { quantity, recordReturn, refundSupplierCredit, voidReturn } from '@shareat/domain';
import { requireActor } from '../../../lib/session';

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

  const result = await transaction((tx) =>
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

  const result = await transaction((tx) => voidReturn(tx, actor, returnId, reason));
  if (!result.ok) throw new Error(result.reason ?? 'void refused');

  revalidatePath('/inventory/returns');
}

export async function refundCreditAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/returns');
  const storeId = str(fd, 'storeId');
  const supplierId = str(fd, 'supplierId');
  const moneyAccountId = str(fd, 'moneyAccountId');
  const amount = str(fd, 'amount');

  const result = await transaction((tx) =>
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
