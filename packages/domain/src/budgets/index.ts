/**
 * Expense budgets — setting a cap, and reading what is left. T-215.
 *
 * ⛔ **Nothing here posts.** A budget is an intention; the ledger records facts. There is no
 * `postEntry` call in this module and no `journal_entry_id` on its table, and that is what keeps
 * the whole feature cheap. If a future change starts to feel expensive, this is the line to
 * re-read before adding a posting.
 *
 * ⛔ **And a cap never refuses an expense.** T-175 settled the pattern for this codebase — *a
 * finding replaces v1's block: nag whoever can act, never block whoever cannot.* A cashier who
 * cannot buy gas because a cap was set wrong buys it with their own money, and then the expense
 * leaves the system entirely. Warning is the control; blocking is the failure.
 */
import { budgetsRepo, transaction, type Tx } from '@shareat/db';
import type { ReissueInterval } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { compare, ZERO } from '@shareat/core/money';
import { parseDecimalInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

export interface SetBudgetInput {
  storeId: string;
  categoryId: string;
  /** `YYYYMM`. */
  periodKey: string;
  amount: string;
  autoReissue?: boolean;
  reissueInterval?: ReissueInterval | null;
}

/**
 * Set or replace one store's cap for one category in one period.
 *
 * ⚠️ **Zero is accepted and means "spend nothing here".** It is not the same as no row at all,
 * which means "no cap" — bible §6's *a rate of 0 is a legitimate value, never 'unset'*, applied
 * to a place where the two readings lead to opposite screens.
 */
export async function setExpenseBudget(
  tx: Tx | null,
  actor: Actor,
  input: SetBudgetInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_expense_budgets', { storeId: input.storeId });

    if (!/^\d{6}$/.test(input.periodKey)) {
      throw new Error(`setExpenseBudget: '${input.periodKey}' is not a YYYYMM period.`);
    }
    // T-371 R5/R6/C4: parsed after authorize() into the column's numeric(14,2) brand. `expense_budgets.amount` is
    // NOT NULL with no default, so a blank is refused in words — never the `Number('') === 0` cap of zero it used to
    // become (and "1.234" is refused, not silently rounded by `toFixed(2)`).
    const amount = parseDecimalInput(input.amount, '14,2', 'setExpenseBudget: the cap', 'The cap', { blank: 'refuse' });
    if (compare(amount, ZERO) < 0) {
      throw refuse(
        'setExpenseBudget: a cap cannot be negative. Zero means "spend nothing here".',
        'A cap cannot be negative. Zero means "spend nothing here".',
      );
    }
    const autoReissue = input.autoReissue === true;
    const reissueInterval = input.reissueInterval ?? null;
    // ⚠️ The database refuses this too (`expense_budgets_reissue_interval_check`) — this exists so
    // the person reading the screen gets a sentence instead of a constraint name. ⛔ It is NOT a
    // second source of truth: the constraint is the rule, and deleting this check would change the
    // message, not the outcome.
    if (autoReissue && reissueInterval === null) {
      throw new Error(
        'setExpenseBudget: an auto-reissuing budget must say how often. Without an interval the ' +
          'reissue job skips it silently and the cap simply stops existing next period.',
      );
    }

    return budgetsRepo.setBudget(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      categoryId: input.categoryId,
      periodKey: input.periodKey,
      amount,
      autoReissue,
      reissueInterval,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Remove a cap entirely.
 *
 * ⚠️ Deliberately a DELETE, not an amount of zero — they mean opposite things, and a screen that
 * cannot express "no cap" would leave every category ever budgeted capped forever. ⭐ A budget is
 * not a financial record (nothing posted, no balance moved), so bible §13 row 125's rule for a
 * draft expense applies: everything POSTED is reversed and never removed; this was never posted.
 */
export async function removeExpenseBudget(
  tx: Tx | null,
  actor: Actor,
  input: { budgetId: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const budget = await budgetsRepo.getById(trx, actor.orgId, input.budgetId);
    if (!budget) throw new Error('removeExpenseBudget: that budget does not exist.');
    await authorize(trx, actor, 'manage_expense_budgets', { storeId: budget.storeId });
    await budgetsRepo.removeBudget(trx, actor.orgId, input.budgetId);
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** `YYYYMM` for a `YYYY-MM-DD` business date. */
export function periodKeyOf(businessDate: string): string {
  return businessDate.slice(0, 4) + businessDate.slice(5, 7);
}

/** The period after `YYYYMM`, for a given interval. ⚠️ Only the PERIOD family advances a key. */
export function nextPeriodKey(periodKey: string, interval: ReissueInterval): string | null {
  const year = Number(periodKey.slice(0, 4));
  const month = Number(periodKey.slice(4, 6));
  const add = interval === 'monthly' ? 1 : interval === 'quarterly' ? 3 : interval === 'annually' ? 12 : 0;
  if (add === 0) return null;
  const zero = year * 12 + (month - 1) + add;
  return `${String(Math.floor(zero / 12)).padStart(4, '0')}${String((zero % 12) + 1).padStart(2, '0')}`;
}

/**
 * How long a reset window is, in days. ⚠️ `bi_weekly` is 14 days, not "half a month" — v1's
 * interval list is a list of DURATIONS, and reading it as calendar halves would drift every month
 * with 31 days in it.
 */
export function resetWindowDays(interval: ReissueInterval): number | null {
  return interval === 'daily' ? 1 : interval === 'weekly' ? 7 : interval === 'bi_weekly' ? 14 : null;
}
