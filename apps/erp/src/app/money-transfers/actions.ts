'use server';

/**
 * Server actions for the money-transfers screen. T-139, bible row 150.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ **The manager-level rule is NOT
 * enforced here** — `createMoneyTransfer` and `voidMoneyTransfer` call `authorize()` themselves.
 * A gate in a server action protects one caller; a gate in the domain protects every caller there
 * will ever be.
 *
 * ⭐ The actor comes from `requireActor()`, never the form (T-138, bible §7.1).
 */
import { redirect } from 'next/navigation';
import { createMoneyTransfer, voidMoneyTransfer } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The message a person should read.
 *
 * ⚠️ Domain errors are prefixed with the function that threw — `createMoneyTransfer: ...` — which
 * is exactly right in a log and useless on screen. Strips a leading camelCase identifier and its
 * colon, and nothing else: the sentence after it is already written for a human.
 */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

export async function createMoneyTransferAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const amountOut = str(formData, 'amountOut');
    if (!amountOut) throw new Error('Enter the amount that left the source account.');

    // ⭐ A blank "amount that arrived" means the transfer cost nothing — the ordinary case, and by
    // far the common one. The field stays visible and labelled rather than hidden behind a
    // "has a fee?" toggle, because the fee is exactly what a person is checking for when they
    // reconcile the two statements. Blank is a shortcut, not a default that hides a decision.
    const amountIn = str(formData, 'amountIn') || amountOut;

    await withOrgPrincipal(actor.orgId, (tx) =>
      createMoneyTransfer(tx, actor, {
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        toMoneyAccountId: str(formData, 'toMoneyAccountId'),
        amountOut,
        amountIn,
        transferDate: str(formData, 'transferDate'),
        reference: str(formData, 'reference') || null,
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    redirect(`/money-transfers?error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect('/money-transfers?ok=created');
}

export async function voidMoneyTransferAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const reason = str(formData, 'reason');
    if (!reason) {
      throw new Error('Say why this transfer is being reversed — a reversal with no reason is a gap.');
    }
    await withOrgPrincipal(actor.orgId, (tx) =>
      voidMoneyTransfer(tx, actor, {
        moneyTransferId: str(formData, 'moneyTransferId'),
        reason,
      }),
    );
  } catch (err) {
    redirect(`/money-transfers?error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect('/money-transfers?ok=voided');
}
