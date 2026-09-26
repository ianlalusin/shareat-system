/**
 * deleteExpenseDraft — removes a DRAFT expense outright. Ian 2026-08-25: *"delete for
 * simplicity."*
 *
 * ## Why deleting is allowed here and nowhere else
 *
 * Bible §4: posted financial records are never deleted; a correction is a reversal, and
 * the original stays visible. **A draft is not a financial record.** It has no journal
 * entry, has touched no balance, and has been asserted by nobody — it is a form somebody
 * started filling in. Nothing about it needs to survive, and keeping it would leave every
 * mistaken draft sitting in the list forever, which is the problem this removes.
 *
 * `voidExpense` refuses a draft ("nothing has been posted yet to void; edit or discard it
 * instead") and until now there WAS no discard, so a mistaken draft had no ending.
 *
 * ## Authorization: deleting a draft is the LAST EDIT you can make to it
 *
 * Deliberately no new capability. The gate is `editExpense`'s exactly — creator inside the
 * 48-hour window needs `edit_own_expense`, anyone else needs `edit_any_expense` — because
 * a capability answers "what may you do" (bible row 120), and there is no coherent answer
 * under which a person may rewrite every field of a draft but not remove it. Reusing the
 * pair also inherits v1's edit window for free rather than inventing a second one that
 * could drift from it.
 *
 * A cashier can therefore undo their own mistake without finding a manager, which is the
 * point — friction on a self-correction is what produces the abandoned drafts instead.
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, transaction, type Tx } from '@shareat/db';
import { EDIT_WINDOW_MS } from './edit';
import { refuse, gone } from '../shared/refusal';

export async function deleteExpenseDraft(tx: Tx | null, actor: Actor, expenseId: string): Promise<void> {
  if (tx) return runDeleteExpenseDraft(tx, actor, expenseId);
  return transaction((trx) => runDeleteExpenseDraft(trx, actor, expenseId));
}

async function runDeleteExpenseDraft(tx: Tx, actor: Actor, expenseId: string): Promise<void> {
  // Org-scoped read BEFORE authorize(), same reasoning as editExpense: the capability is
  // store-scoped and the store is a property of the resource, so it must be read to name
  // the right ctx.storeId. The read is already filtered by actor.orgId.
  const expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw gone(`deleteExpenseDraft: expense ${expenseId} does not exist in org ${actor.orgId}`, 'expense');
  }

  // ⚠️ Status FIRST, before authorize() — a posted or voided expense is not deletable by
  // anyone, including an admin, so there must be no branch that even reaches an
  // authorization decision for one. This mirrors invariant 13's treatment of editing: the
  // restriction is on the RECORD's state, not on the person.
  if (expense.status !== 'draft') {
    throw refuse(
      `deleteExpenseDraft: expense ${expenseId} is ${expense.status} — only a draft may be deleted. ` +
        'A posted expense is voided, which REVERSES it and leaves both entries standing (bible §4).',
      `Only a draft can be deleted — this expense is ${expense.status}. Void a posted expense instead.`,
    );
  }

  const isCreator = actor.personId === expense.createdBy;
  const withinWindow = Date.now() - expense.createdAt.getTime() <= EDIT_WINDOW_MS;

  if (isCreator && withinWindow) {
    await authorize(tx, actor, 'edit_own_expense', { storeId: expense.storeId });
  } else {
    await authorize(tx, actor, 'edit_any_expense', { storeId: expense.storeId });
  }

  await expensesRepo.deleteExpenseDraft(tx, actor.orgId, expenseId);
}
