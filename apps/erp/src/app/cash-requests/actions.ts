'use server';

/**
 * Server actions for the cash-request screens. T-144.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import { redirect } from 'next/navigation';
import {
  cancelCashRequest,
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
  settleCashRequest,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function createRequestAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const storeId = str(formData, 'storeId');
    if (!storeId) throw new Error('Choose a store.');
    const requestedFor = str(formData, 'requestedFor');
    if (!requestedFor) throw new Error('Say who is holding the money.');
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
    back('/cash-requests', { error: errorMessage(err) });
  }
  back(`/cash-requests/${id}`, {
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
      const reason = str(formData, 'reason');
      if (!reason) throw new Error('A refusal needs a reason.');
      await withOrgPrincipal(actor.orgId, (tx) =>
        decideCashRequest(tx, actor, { requestId: id, decision: 'reject', reason }),
      );
      message = 'Refused. Nothing posted.';
    } else {
      const amount = str(formData, 'amount');
      await withOrgPrincipal(actor.orgId, (tx) =>
        decideCashRequest(tx, actor, { requestId: id, decision: 'approve', amount }),
      );
      // ⚠️ Said plainly, because "approved" reads to most people as "handed over".
      message = `Approved for ₱${amount}. ⚠️ Still nothing has moved — release it to hand the cash over.`;
    }
  } catch (err) {
    back(`/cash-requests/${id}`, { error: errorMessage(err) });
  }
  back(`/cash-requests/${id}`, { ok: message });
}

export async function releaseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'requestId');
  let message = '';
  try {
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
    back(`/cash-requests/${id}`, { error: errorMessage(err) });
  }
  back(`/cash-requests/${id}`, { ok: message });
}

export async function settleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'requestId');
  let message = '';
  try {
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
    back(`/cash-requests/${id}`, { error: errorMessage(err) });
  }
  back(`/cash-requests/${id}`, { ok: message });
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
    back(`/cash-requests/${id}`, { error: errorMessage(err) });
  }
  back(`/cash-requests/${id}`, { ok: 'Withdrawn. Nothing posted, so nothing to undo.' });
}
