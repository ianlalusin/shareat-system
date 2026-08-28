/**
 * editExpense — mutates a DRAFT expense. docs/tasks/122-expenses.md §6-§7, invariants
 * 12-13.
 *
 * Two capabilities cover the one action, chosen by WHO is editing and WHEN, never by
 * role name directly:
 *   - the creator, inside 48 hours of creating it -> `edit_own_expense`.
 *   - anyone else (or the creator, once the 48h window has closed) -> `edit_any_expense`.
 *
 * A POSTED or VOIDED expense can never be edited by anyone, including an admin
 * (invariant 13) — there is no branch here that reaches `authorize()` for a non-draft
 * row; the status check runs first and throws.
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, transaction, type Tx } from '@shareat/db';
import { add, money } from '@shareat/core/money';
import type { CreateExpensePaymentInput } from './create';

/** v1's own edit window, preserved (CAPABILITY-MATRIX.md: "Time-boxed — v1 gives
 *  cashiers 48h on their own. Preserve the window"). Exported so a test can compute
 *  "outside the window" without duplicating the constant. */
export const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface EditExpenseInput {
  businessDate?: string;
  categoryId?: string;
  /** ⭐ T-130: `supplierId` and `supplierInvoiceId` travel together now — a draft naming one
   *  without the other would leave the row inconsistent with the create-time invariant. */
  supplierId?: string;
  supplierInvoiceId?: string;
  particulars?: string;
  /** Omit to leave payments unchanged; supply to REPLACE the full set (totalAmount is
   *  recomputed from this set, same "never accepted from the caller" rule as create). */
  payments?: CreateExpensePaymentInput[];
}

export async function editExpense(
  tx: Tx | null,
  actor: Actor,
  expenseId: string,
  input: EditExpenseInput,
): Promise<void> {
  if (tx) return runEditExpense(tx, actor, expenseId, input);
  return transaction((trx) => runEditExpense(trx, actor, expenseId, input));
}

async function runEditExpense(tx: Tx, actor: Actor, expenseId: string, input: EditExpenseInput): Promise<void> {
  // Org-scoped read BEFORE authorize(): the capability is store-scoped, and the store is
  // a property of the resource itself — there is no way to name the right ctx.storeId
  // without reading it first. The read cannot leak another org's expense (it is filtered
  // by actor.orgId already), so nothing is exposed ahead of the authorization decision.
  const expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw new Error(`editExpense: expense ${expenseId} does not exist in org ${actor.orgId}`);
  }

  if (expense.status !== 'draft') {
    throw new Error(
      `editExpense: expense ${expenseId} is ${expense.status} — only a draft may be edited (invariant 13); void it instead`,
    );
  }

  const isCreator = actor.personId === expense.createdBy;
  const withinWindow = Date.now() - expense.createdAt.getTime() <= EDIT_WINDOW_MS;

  if (isCreator && withinWindow) {
    await authorize(tx, actor, 'edit_own_expense', { storeId: expense.storeId });
  } else {
    await authorize(tx, actor, 'edit_any_expense', { storeId: expense.storeId });
  }

  const patch: Parameters<typeof expensesRepo.updateExpenseDraft>[3] = {};
  if (input.businessDate !== undefined) patch.businessDate = input.businessDate;
  if (input.categoryId !== undefined) {
    const category = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
    if (!category) throw new Error(`editExpense: category ${input.categoryId} does not exist in org ${actor.orgId}`);
    patch.categoryId = input.categoryId;
  }
  if (input.supplierId !== undefined) patch.supplierId = input.supplierId;
  if (input.supplierInvoiceId !== undefined) patch.supplierInvoiceId = input.supplierInvoiceId;
  if (input.particulars !== undefined) {
    const trimmed = input.particulars.trim();
    if (!trimmed) throw new Error('editExpense: particulars cannot be blank');
    patch.particulars = trimmed;
  }

  if (input.payments !== undefined) {
    if (input.payments.length === 0) {
      throw new Error('editExpense: at least one payment is required');
    }
    const amounts = input.payments.map((p) => money(p.amount));
    patch.totalAmount = add(...amounts);
    await expensesRepo.replacePayments(
      tx,
      expenseId,
      input.payments.map((p, i) => ({
        method: p.method,
        amount: amounts[i]!,
        accountCode: p.accountCode ?? null,
        staffId: p.staffId ?? null,
        moneyAccountId: p.moneyAccountId ?? null,
        cashRequestId: p.cashRequestId ?? null,
      })),
    );
  }

  if (Object.keys(patch).length > 0) {
    await expensesRepo.updateExpenseDraft(tx, actor.orgId, expenseId, patch);
  }
}
