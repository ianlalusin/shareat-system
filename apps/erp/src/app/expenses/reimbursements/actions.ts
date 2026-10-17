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
import { assertFieldRules, payReimbursement } from '@shareat/domain';
import { EXPENSE_REIMBURSEMENT_RULES } from '@shareat/domain/field-rules';
import { parseMoneyInput } from '@shareat/domain/money-input';
import { displayNameOf, peso, withOrgPrincipal } from './lib';
import { closedMonthOf, closedMonths, periodOverrideProblem, readPeriodOverride } from '../../../lib/period-override';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash, type Flash, type Nav } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

const BASE = '/expenses/reimbursements';

export async function payReimbursementAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const nav: Nav = storeId ? { store: storeId } : {};

  // The banner is computed inside the try and the redirect is issued after it: `redirect()` throws, and a
  // throw inside the try would be caught by our own catch (DEF-422).
  let flash: Flash;
  try {
    assertFieldRules(EXPENSE_REIMBURSEMENT_RULES, formData);
    const amount = str(formData, 'amount');

    // The override is forwarded only when the payout's date really is in a CLOSED month: otherwise an
    // ordinary save would leave an audit row for an override nobody needed.
    const on = str(formData, 'on');
    const asked = readPeriodOverride(formData);
    const inClosedMonth = !!closedMonthOf(await closedMonths(actor.orgId), on);
    const periodOverride = asked && inClosedMonth ? asked : undefined;
    // A ticked confirm box with the rest missing is an unfinished form: say what is missing.
    const problem = inClosedMonth ? periodOverrideProblem(formData) : null;
    if (problem) throw new Error(problem);

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      payReimbursement(tx, actor, {
        storeId,
        employeeId: str(formData, 'employeeId'),
        amount,
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        on,
        payoutId: str(formData, 'payoutId'),
        ...(periodOverride ? { periodOverride } : {}),
        memo: str(formData, 'memo') || undefined,
      }),
    );

    // The payout has committed; a failed name lookup must not turn that into an error banner.
    const name = (await displayNameOf(actor.orgId, str(formData, 'employeeId')).catch(() => '')) || 'this person';
    const still = `Still owed: ${peso(result.outstanding)}.`;
    const ok = result.created
      ? `Paid ${peso(parseMoneyInput(amount, 'payReimbursementAction: the amount', 'The reimbursement amount'))} to ${name}. ${still}`
      : `This payout to ${name} was already recorded. ${still}`;
    flash = { ok, ...(result.warning ? { warning: result.warning } : {}) };
  } catch (err) {
    flash = { error: errorMessage(err) };
  }
  return await redirectWithFlash(BASE, nav, flash);
}
