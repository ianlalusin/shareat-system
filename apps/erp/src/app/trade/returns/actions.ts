'use server';

/**
 * Server actions for the customer-returns screen — T-179.
 *
 * Thin adapters: parse `FormData`, call the domain, revalidate. ⭐ The actor comes from the
 * session, never the form (T-138) — authorization itself is `recordCustomerReturn`/
 * `voidCustomerReturn`'s own first statement, not repeated here.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { applyCredit, recordCustomerReturn, voidCustomerReturn } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(params: Record<string, string>): never {
  redirect(`/trade/returns?${new URLSearchParams(params).toString()}`);
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

  const result = await withOrgPrincipal(actor.orgId, (tx) =>
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

  // The refusal reaches the person as a banner, never a thrown error (a production build shows a thrown
  // server-action error as a digest): `{ok:false}` and a thrown RefusalError both end up in `?error=`.
  const store = str(fd, 'store');
  const keep: Record<string, string> = store ? { store } : {};
  let result: Awaited<ReturnType<typeof voidCustomerReturn>>;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => voidCustomerReturn(tx, actor, returnId, reason));
  } catch (err) {
    back({ ...keep, error: errorMessage(err) });
  }
  // The same redaction as the thrown path (an id inside a reason never reaches the page).
  if (!result!.ok) back({ ...keep, error: errorMessage(new Error(result!.reason ?? 'The return could not be voided.')) });

  revalidatePath('/trade/returns');
  back({ ...keep, ok: 'Return voided. The stock and the posting it made are reversed.' });
}

export async function applyCreditAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/returns');
  const tradeOrderId = str(fd, 'tradeOrderId');
  const moneyAccountId = str(fd, 'moneyAccountId');
  const amount = str(fd, 'amount');

  const result = await withOrgPrincipal(actor.orgId, (tx) =>
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
