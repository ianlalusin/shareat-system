'use server';

/**
 * Server actions for the cash-request screens. T-144.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import {
  assertFieldRules,
  cancelCashRequest,
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
  settleCashRequest,
} from '@shareat/domain';
import {
  CASH_REQUEST_APPROVE_RULES,
  CASH_REQUEST_CREATE_RULES,
  CASH_REQUEST_REFUSE_RULES,
  CASH_REQUEST_RELEASE_RULES,
  CASH_REQUEST_SETTLE_RULES,
} from '@shareat/domain/field-rules';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createRequestAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  // T-387 S4: the two field refusals are judged before the try - a redirect thrown inside it would be caught below.
  const storeId = str(formData, 'storeId');
  if (!storeId) return await redirectWithFlash('/cash-requests', {}, { error: 'Choose a store.', field: 'store' });
  const requestedFor = str(formData, 'requestedFor');
  if (!requestedFor) return await redirectWithFlash('/cash-requests', {}, { error: 'Say who is holding the money.', field: 'requested-for' });
  try {
    // T-440: the same rule set the screen shows (one definition); the domain keeps its own money/date parsing.
    assertFieldRules(CASH_REQUEST_CREATE_RULES, formData);
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createCashRequest(tx, actor, {
        storeId,
        requestedFor,
        purpose: str(formData, 'purpose'),
        amount: str(formData, 'amount'),
        on: str(formData, 'on'),
        notes: str(formData, 'notes') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    return await redirectWithFlash('/cash-requests', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/cash-requests/${id}`, {}, {
    ok: 'Requested. ⚠️ No money has moved — asking is not a financial event.',
  });
}

export async function decideAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'requestId');
  const decision = str(formData, 'decision');
  let message = '';
  try {
    if (decision === 'reject') {
      assertFieldRules(CASH_REQUEST_REFUSE_RULES, formData);
      const reason = str(formData, 'reason');
      await withOrgPrincipal(actor.orgId, (tx) =>
        decideCashRequest(tx, actor, { requestId: id, decision: 'reject', reason }),
      );
      message = 'Refused. Nothing posted.';
    } else {
      assertFieldRules(CASH_REQUEST_APPROVE_RULES, formData);
      const amount = str(formData, 'amount');
      await withOrgPrincipal(actor.orgId, (tx) =>
        decideCashRequest(tx, actor, { requestId: id, decision: 'approve', amount }),
      );
      // ⚠️ Said plainly, because "approved" reads to most people as "handed over".
      message = `Approved for ₱${amount}. ⚠️ Still nothing has moved — release it to hand the cash over.`;
    }
  } catch (err) {
    return await redirectWithFlash(`/cash-requests/${id}`, {}, { error: errorMessage(err) });
  }
  // Only an approval is stamped: the q5 table has no word for a refusal.
  return await redirectWithFlash(
    `/cash-requests/${id}`,
    {},
    decision === 'reject' ? { ok: message } : { stamp: 'APPROVED', ok: message },
  );
}

export async function releaseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'requestId');
  let message = '';
  try {
    assertFieldRules(CASH_REQUEST_RELEASE_RULES, formData);
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      releaseCashRequest(tx, actor, {
        requestId: id,
        amount: str(formData, 'amount'),
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        on: str(formData, 'on'),
      }),
    );
    message = 'Released. The float is out and has to come back.';
    // ⚠️ The overdraw warning is surfaced, not swallowed — a cashier account can legitimately read
    // short because its count is unverified, which is why this warns rather than blocks (row 154).
    if (result.warning) message += ` ⚠️ ${result.warning}`;
  } catch (err) {
    return await redirectWithFlash(`/cash-requests/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/cash-requests/${id}`, {}, { stamp: 'RELEASED', ok: message });
}

export async function settleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'requestId');
  let message = '';
  try {
    assertFieldRules(CASH_REQUEST_SETTLE_RULES, formData);
    const returnedAmount = str(formData, 'returnedAmount');
    const shortAmount = str(formData, 'shortAmount');
    if (!returnedAmount && !shortAmount) {
      throw new Error('Enter what came back, what is short, or both.');
    }
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      settleCashRequest(tx, actor, {
        requestId: id,
        ...(returnedAmount ? { returnedAmount } : {}),
        ...(shortAmount ? { shortAmount } : {}),
        ...(str(formData, 'shortReason') ? { shortReason: str(formData, 'shortReason') } : {}),
        ...(str(formData, 'toMoneyAccountId')
          ? { toMoneyAccountId: str(formData, 'toMoneyAccountId') }
          : {}),
        on: str(formData, 'on'),
      }),
    );
    // ⭐ Reports the LEDGER's answer, not the form's arithmetic. Zero closes the request, and the
    // screen says so because the ledger says so.
    message = result.liquidated
      ? 'Settled. The float is back to zero and the request is closed.'
      : `Recorded. ₱${result.outstanding} is still out with the holder.`;
  } catch (err) {
    return await redirectWithFlash(`/cash-requests/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/cash-requests/${id}`, {}, { ok: message });
}

export async function cancelAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'requestId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      cancelCashRequest(tx, actor, {
        requestId: id,
        ...(str(formData, 'reason') ? { reason: str(formData, 'reason') } : {}),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(`/cash-requests/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/cash-requests/${id}`, {}, { ok: 'Withdrawn. Nothing posted, so nothing to undo.' });
}
