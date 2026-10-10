'use server';

/**
 * Server actions for `/budgets`. T-215.
 *
 * ⛔ The gate lives in the service (`manage_expense_budgets`), not here. A gate in a server action
 * protects one caller; a gate in the domain protects every caller there will ever be.
 */
import { removeExpenseBudget, setExpenseBudget } from '@shareat/domain';
import type { ReissueInterval } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { BUDGET_CAP_EDIT } from './typed-forms';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function setBudgetAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const periodKey = str(formData, 'periodKey');
  let message = '';
  try {
    const autoReissue = str(formData, 'autoReissue') === 'on';
    const interval = str(formData, 'reissueInterval');
    await withOrgPrincipal(actor.orgId, (tx) =>
      setExpenseBudget(tx, actor, {
        storeId,
        categoryId: str(formData, 'categoryId'),
        periodKey,
        amount: str(formData, 'amount'),
        autoReissue,
        // ⚠️ Sent only when auto-reissue is on. The database refuses the other combination
        // outright (`expense_budgets_reissue_interval_check`), so passing a stale interval with
        // the box unticked would be a silent lie in the row rather than an error anyone sees.
        reissueInterval: autoReissue && interval ? (interval as ReissueInterval) : null,
      }),
    );
    message = autoReissue
      ? 'Cap saved, and it renews on its own from now on.'
      : 'Cap saved. ⚠️ It applies to this period only — tick "renew automatically" if it should carry forward.';
  } catch (err) {
    return await redirectWithFlash('/budgets', { store: storeId, period: periodKey }, { error: errorMessage(err), typed: keepTyping(formData, BUDGET_CAP_EDIT, str(formData, 'categoryId'), { actorId: actor.personId }) });
  }
  return await redirectWithFlash('/budgets', { store: storeId, period: periodKey }, { ok: message });
}

export async function removeBudgetAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const periodKey = str(formData, 'periodKey');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      removeExpenseBudget(tx, actor, { budgetId: str(formData, 'budgetId') }),
    );
  } catch (err) {
    return await redirectWithFlash('/budgets', { store: storeId, period: periodKey }, { error: errorMessage(err) });
  }
  // ⚠️ Says which of the two states it left behind. "Removed" and "set to zero" look identical on
  // a screen and mean opposite things — no cap at all, versus spend nothing here.
  return await redirectWithFlash('/budgets', { store: storeId, period: periodKey }, {
    ok: 'Cap removed — this category now has NO cap, which is not the same as a cap of zero.',
  });
}
