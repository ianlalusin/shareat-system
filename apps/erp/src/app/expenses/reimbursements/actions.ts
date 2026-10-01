'use server';

/**
 * Server action for the staff reimbursement payout screen. T-369 S1 (DEF-198).
 *
 * Thin adapter: parse `FormData`, call the domain, redirect with a banner. ⛔ **No rule is enforced
 * here** — `payReimbursement` calls `authorize()` first and owns the cap, the cross-store gate and
 * the lock. A gate in an action protects one caller; a gate in the domain protects every caller.
 *
 * ⭐ The actor comes from `requireActor()`, never the form (bible §7.1). The form supplies the
 * figures, the account, the date and the `payoutId` the page minted for THIS render — a second
 * submit of the same form carries the same `payoutId` and so posts once.
 */
import { redirect } from 'next/navigation';
import { payReimbursement } from '@shareat/domain';
import { parseMoneyInput } from '@shareat/domain/money-input';
import { displayNameOf, peso, withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

const BASE = '/expenses/reimbursements';

export async function payReimbursementAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const back = (params: Record<string, string>): string =>
    `${BASE}?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), ...params }).toString()}`;

  // The redirect is computed inside the try and issued after it: `redirect()` throws, and a throw
  // inside the try would be caught by our own catch (DEF-422).
  let target: string;
  try {
    const amount = str(formData, 'amount');
    if (!amount) throw new Error('Enter the amount to pay.');

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      payReimbursement(tx, actor, {
        storeId,
        employeeId: str(formData, 'employeeId'),
        amount,
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        on: str(formData, 'on'),
        payoutId: str(formData, 'payoutId'),
        memo: str(formData, 'memo') || undefined,
      }),
    );

    // The payout has committed; a failed name lookup must not turn that into an error banner.
    const name = (await displayNameOf(actor.orgId, str(formData, 'employeeId')).catch(() => '')) || 'this person';
    const still = `Still owed: ${peso(result.outstanding)}.`;
    const ok = result.created
      ? `Paid ${peso(parseMoneyInput(amount, 'payReimbursementAction: the amount', 'The reimbursement amount'))} to ${name}. ${still}`
      : `This payout to ${name} was already recorded. ${still}`;
    target = back({ ok, ...(result.warning ? { warning: result.warning } : {}) });
  } catch (err) {
    target = back({ error: errorMessage(err) });
  }
  redirect(target);
}
