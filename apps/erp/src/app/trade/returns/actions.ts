'use server';

/**
 * Server actions for the customer-returns screen — T-179.
 *
 * Thin adapters: parse `FormData`, call the domain, revalidate. ⭐ The actor comes from the
 * session, never the form (T-138) — authorization itself is `recordCustomerReturn`/
 * `voidCustomerReturn`'s own first statement, not repeated here.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { revalidatePath } from 'next/cache';
import { applyCredit, assertFieldRules, recordCustomerReturn, voidCustomerReturn } from '@shareat/domain';
import { RETURN_VOID_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash, type Nav } from '@/lib/flash';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

const RETURN_OK: Record<string, string> = {
  cash_refund: 'Return recorded. The refund was paid out.',
  reduce_ar: 'Return recorded. It comes off what the customer owes.',
  store_credit: 'Return recorded. The customer has it as store credit.',
  mixed: 'Return recorded. Part comes off what the customer owes; the rest is store credit.',
  reverse_transfer: 'Return recorded. The transfer to the branch is reversed.',
};

export async function recordReturnAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/returns');
  const tradeOrderId = str(fd, 'tradeOrderId');
  const tradeOrderLineId = str(fd, 'tradeOrderLineId');
  const qty = str(fd, 'quantity');
  const reason = str(fd, 'reason');
  const saleable = str(fd, 'saleable') !== 'false';
  const refund = str(fd, 'refund') === 'true';
  const moneyAccountId = str(fd, 'moneyAccountId') || null;

  const store = str(fd, 'store');
  const keep: Nav = store ? { store } : {};
  let result: Awaited<ReturnType<typeof recordCustomerReturn>>;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordCustomerReturn(tx, {
        tradeOrderId,
        returnedOn: toBusinessDate(),
        reason,
        lines: [{ tradeOrderLineId, quantity: qty, saleable }],
        refund,
        moneyAccountId,
        actor,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/trade/returns', keep, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash('/trade/returns', keep, { error: errorMessage(new Error(result.reason)) });

  revalidatePath('/trade/returns');
  return await redirectWithFlash('/trade/returns', keep, { ok: RETURN_OK[result.settlement] ?? 'Return recorded.' });
}

export async function voidReturnAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/returns');
  const returnId = str(fd, 'returnId');
  const reason = str(fd, 'reason');

  // The refusal reaches the person as a banner, never a thrown error (a production build shows a thrown
  // server-action error as a digest): `{ok:false}` and a thrown RefusalError both end up in the flash banner.
  const store = str(fd, 'store');
  const keep: Nav = store ? { store } : {};
  let result: Awaited<ReturnType<typeof voidCustomerReturn>>;
  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store (not the form's `store`).
    const target = await loadDestructiveTarget(actor, 'customer_return', returnId, ['void_customer_return']);
    assertFieldRules(RETURN_VOID_RULES, fd);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(fd, 'adminPin'), capability: 'void_customer_return' });
    result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const voided = await voidCustomerReturn(tx, actor, returnId, reason);
      if (voided.ok) await recordApproval(tx, actor, approval, { capability: 'void_customer_return', entityType: 'customer_return', entityId: returnId, storeId: target.storeId });
      return voided;
    });
  } catch (err) {
    return await redirectWithFlash('/trade/returns', keep, { error: errorMessage(err) });
  }
  // The same redaction as the thrown path (an id inside a reason never reaches the page).
  if (!result.ok) return await redirectWithFlash('/trade/returns', keep, { error: errorMessage(new Error(result.reason ?? 'The return could not be voided.')) });

  revalidatePath('/trade/returns');
  return await redirectWithFlash('/trade/returns', keep, { stamp: 'VOID', ok: 'Return voided. The stock and the posting it made are reversed.' });
}

export async function applyCreditAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/returns');
  const tradeOrderId = str(fd, 'tradeOrderId');
  const moneyAccountId = str(fd, 'moneyAccountId');
  const amount = str(fd, 'amount');

  const store = str(fd, 'store');
  const keep: Nav = store ? { store } : {};
  let result: Awaited<ReturnType<typeof applyCredit>>;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      applyCredit(tx, actor, {
        tradeOrderId,
        amount,
        collectionDate: toBusinessDate(),
        moneyAccountId,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/trade/returns', keep, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash('/trade/returns', keep, { error: errorMessage(new Error(result.reason ?? 'The credit could not be applied.')) });

  revalidatePath('/trade/returns');
  return await redirectWithFlash('/trade/returns', keep, { ok: 'Credit applied to the order.' });
}
