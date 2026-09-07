'use server';

/**
 * Server actions for the customer-returns screen — T-179.
 *
 * Thin adapters: parse `FormData`, call the domain, revalidate. ⭐ The actor comes from the
 * session, never the form (T-138) — authorization itself is `recordCustomerReturn`/
 * `voidCustomerReturn`'s own first statement, not repeated here.
 */
import { revalidatePath } from 'next/cache';
import { transaction } from '@shareat/db';
import { applyCredit, recordCustomerReturn, voidCustomerReturn } from '@shareat/domain';
import { requireActor } from '../../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function recordReturnAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/returns');
  const tradeOrderId = str(fd, 'tradeOrderId');
  const tradeOrderLineId = str(fd, 'tradeOrderLineId');
  const qty = str(fd, 'quantity');
  const reason = str(fd, 'reason');
  const saleable = str(fd, 'saleable') !== 'false';
  const refund = str(fd, 'refund') === 'true';
  const moneyAccountId = str(fd, 'moneyAccountId') || null;

  const result = await transaction((tx) =>
    recordCustomerReturn(tx, {
      tradeOrderId,
      returnedOn: new Date().toISOString().slice(0, 10),
      reason,
      lines: [{ tradeOrderLineId, quantity: qty, saleable }],
      refund,
      moneyAccountId,
      actor,
    }),
  );
  if (!result.ok) throw new Error(result.reason);

  revalidatePath('/trade/returns');
}

export async function voidReturnAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/returns');
  const returnId = str(fd, 'returnId');
  const reason = str(fd, 'reason');

  const result = await transaction((tx) => voidCustomerReturn(tx, actor, returnId, reason));
  if (!result.ok) throw new Error(result.reason ?? 'void refused');

  revalidatePath('/trade/returns');
}

export async function applyCreditAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/returns');
  const tradeOrderId = str(fd, 'tradeOrderId');
  const moneyAccountId = str(fd, 'moneyAccountId');
  const amount = str(fd, 'amount');

  const result = await transaction((tx) =>
    applyCredit(tx, actor, {
      tradeOrderId,
      amount,
      collectionDate: new Date().toISOString().slice(0, 10),
      moneyAccountId,
    }),
  );
  if (!result.ok) throw new Error(result.reason ?? 'credit application refused');

  revalidatePath('/trade/returns');
}
