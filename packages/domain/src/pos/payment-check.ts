/**
 * T-623 - the manager checks a wallet payment marked "to check". docs/tasks/623-pos-wallet-payments-check.md.
 *
 * A wallet payment taken without the internet is marked `to_check` (a reference number is required). "Checked" means a person holding `approve_pos_correction` at the store saw the
 * money arrive in the store's wallet account under that reference. The columns `checked_by` / `checked_at` go NULL -> a value ONCE (the trigger refuses anything else), so a checked
 * payment cannot be unchecked. If the money did not arrive the manager does not check it; they use Correct payment to move it to the right method. No ledger posting, no deadline: the
 * Z only counts the ones still unchecked (`receiptFigures`).
 */
import { authorize, can, type Actor } from '@shareat/auth';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { posV2Repo, type Tx } from '@shareat/db';
import { gone, refuse } from '../shared/refusal';
import { audit, requireStoreScope, uuidInput } from './shared';

/** How far back the "to check" list reaches (days). */
export const PAYMENT_CHECK_DAYS = 7;
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const receiptNoOf = (storeCode: string, r: { terminalNo: number; terminalSeq: number }) => `${storeCode}-${pad(r.terminalNo, 2)}-${pad(r.terminalSeq, 6)}`;

export const NOT_TO_CHECK = 'This payment is not marked "to check".';
const checkedSentence = (by: string | null, at: Date | null) =>
  `This payment was already checked${by ? ` by ${by}` : ''}${at ? ` at ${formatBusinessDateTime(at, { timeStyle: 'short' })}` : ''}.`;

export interface WalletPaymentToCheck {
  paymentId: string;
  receiptNo: string;
  issuedAtDevice: Date;
  tenderName: string;
  amount: string;
  referenceNo: string;
}

/** The unchecked "to check" wallet payments of the last 7 days, newest first. A person without the right gets `canCheck: false` and nothing (the screen hides the section). */
export async function listWalletPaymentsToCheck(tx: Tx, actor: Actor, input: { storeId: string; now?: Date }): Promise<{ canCheck: boolean; payments: WalletPaymentToCheck[] }> {
  await requireStoreScope(tx, actor, input.storeId);
  if (!(await can(tx, actor, 'approve_pos_correction', { storeId: input.storeId }))) return { canCheck: false, payments: [] };
  const since = new Date((input.now ?? new Date()).getTime() - PAYMENT_CHECK_DAYS * 86_400_000);
  const storeCode = (await posV2Repo.getStoreCode(tx, actor.orgId, input.storeId)) ?? '';
  const rows = await posV2Repo.listPaymentsToCheck(tx, actor.orgId, input.storeId, since);
  return {
    canCheck: true,
    payments: rows.map((r) => ({ paymentId: r.paymentId, receiptNo: receiptNoOf(storeCode, r), issuedAtDevice: r.issuedAtDevice, tenderName: r.tenderName, amount: r.amount, referenceNo: r.referenceNo ?? '' })),
  };
}

export async function checkWalletPayment(tx: Tx, actor: Actor, input: { storeId: string; paymentId: string }): Promise<{ wrote: true }> {
  const { storeId } = input;
  await authorize(tx, actor, 'approve_pos_correction', { storeId });
  const paymentId = uuidInput(input.paymentId, 'The payment');
  const refuseBy = (p: posV2Repo.PaymentCheckRow) => refuse('pos: payment already checked', checkedSentence(p.checkedByName, p.checkedAt));
  const payment = await posV2Repo.getPaymentForCheck(tx, actor.orgId, storeId, paymentId);
  if (!payment) throw gone(`pos: payment ${paymentId} not found at store ${storeId}`, 'that payment');
  if (!payment.toCheck) throw refuse('pos: payment not marked to check', NOT_TO_CHECK);
  if (payment.checkedAt) throw refuseBy(payment);
  const at = new Date();
  if (!(await posV2Repo.markPaymentChecked(tx, { orgId: actor.orgId, storeId, paymentId, checkedBy: actor.personId, at }))) {
    // Lost a race to a second manager: say who checked it, write nothing.
    const now = await posV2Repo.getPaymentForCheck(tx, actor.orgId, storeId, paymentId);
    throw now ? refuseBy(now) : gone(`pos: payment ${paymentId} not found at store ${storeId}`, 'that payment');
  }
  const storeCode = (await posV2Repo.getStoreCode(tx, actor.orgId, storeId)) ?? '';
  await audit(tx, actor, 'pos.payment_checked', {
    storeId, entityId: paymentId, pairingId: null, at,
    after: { receiptNo: receiptNoOf(storeCode, payment), amount: payment.amount, referenceNo: payment.referenceNo },
  });
  return { wrote: true };
}
