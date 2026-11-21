'use server';

/**
 * T-623 - the manager marks a wallet payment "to check" as checked (they saw the money arrive). No pairing, online only: the T-623 domain function authorizes
 * `approve_pos_correction` at the store and owns every refusal sentence. ⛔ No rule here. A domain refusal comes back as a RESULT, never a thrown error.
 */
import { checkWalletPayment } from '@shareat/domain';
import { requireActor } from '@/lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { withOrgPrincipal } from '../../expenses/lib';
import { actionStore } from '../_shell/action-store';

export type CheckResult = { ok: true } | { ok: false; error: string };

export async function checkWalletPaymentAction(input: { storeId: string; paymentId: string }): Promise<CheckResult> {
  const actor = await requireActor('/pos/receipts');
  const store = await actionStore(actor, input?.storeId);
  if ('error' in store) return { ok: false, error: store.error };
  try {
    await withOrgPrincipal(actor.orgId, (tx) => checkWalletPayment(tx, actor, { storeId: store.storeId, paymentId: String(input.paymentId ?? '') }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
