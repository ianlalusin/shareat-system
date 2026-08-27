/**
 * createExpense — captures a draft expense document. docs/tasks/122-expenses.md §1, §6.
 *
 * Deliberately thin and deliberately NOT a posting path: a draft is pure document
 * capture, no ledger writes, no routing validation (invariants 6-10 only ever run at
 * `approve` time — a category with no mapped account, or a payment method with no
 * account, may sit in a DRAFT; it only BLOCKS *posting*, per §4/§3's own wording).
 *
 * `totalAmount` is never accepted from the caller — it is the sum of the payments
 * supplied, computed here, so the two can never disagree at the moment of creation
 * (the alternative, accepting both and checking they match, is exactly the class of
 * inconsistency `convert.ts`'s `unbalanced_source_group` exists to catch in ALREADY-
 * WRITTEN v1 documents; a freshly-created v2 one need never produce that state at all).
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, transaction, type Tx } from '@shareat/db';
import { add, money } from '@shareat/core/money';
import type { ExpensePaymentMethod } from './routing';

export interface CreateExpensePaymentInput {
  method: ExpensePaymentMethod;
  /** Decimal string, e.g. "1200.00". */
  amount: string;
  staffId?: string | null;
  /** ⭐ WHICH wallet an online payment leaves (ADR-010). Required for `online`; `routeExpense`
   *  blocks the posting without it, naming the payment row. */
  moneyAccountId?: string | null;
  cashRequestId?: string | null;
  accountCode?: string | null;
}

export interface CreateExpenseInput {
  storeId: string;
  /** YYYY-MM-DD. */
  businessDate: string;
  categoryId: string;
  supplierId?: string | null;
  /**
   * ⭐ T-127: which owner a PERSONAL expense is a drawing against. Null for every other category.
   * ⚠️ Not validated here — a DRAFT may legitimately exist before the owner is chosen. `approve`
   * blocks, naming the reason, the same way an unmapped category does (invariant 7).
   */
  ownerId?: string | null;
  particulars: string;
  receiptPhotoUrl?: string | null;
  payments: CreateExpensePaymentInput[];
}

export interface CreateExpenseResult {
  id: string;
}

export async function createExpense(
  tx: Tx | null,
  actor: Actor,
  input: CreateExpenseInput,
): Promise<CreateExpenseResult> {
  if (tx) return runCreateExpense(tx, actor, input);
  return transaction((trx) => runCreateExpense(trx, actor, input));
}

async function runCreateExpense(tx: Tx, actor: Actor, input: CreateExpenseInput): Promise<CreateExpenseResult> {
  // Bible §7 rule 1 — the first statement. store-scoped, so this alone proves the actor
  // may record spend for THIS store before anything else runs.
  await authorize(tx, actor, 'create_expense', { storeId: input.storeId });

  const particulars = input.particulars.trim();
  if (!particulars) {
    throw new Error('createExpense: particulars is required — what the spend was actually for');
  }
  if (input.payments.length === 0) {
    throw new Error('createExpense: at least one payment is required');
  }

  const category = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
  if (!category) {
    throw new Error(`createExpense: category ${input.categoryId} does not exist in org ${actor.orgId}`);
  }

  const amounts = input.payments.map((p) => money(p.amount));
  const totalAmount = add(...amounts);

  const { id } = await expensesRepo.insertExpense(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    businessDate: input.businessDate,
    totalAmount,
    categoryId: input.categoryId,
    supplierId: input.supplierId ?? null,
    ownerId: input.ownerId ?? null,
    particulars,
    receiptPhotoUrl: input.receiptPhotoUrl ?? null,
    createdBy: actor.personId,
  });

  await expensesRepo.insertPayments(
    tx,
    id,
    input.payments.map((p, i) => ({
      method: p.method,
      amount: amounts[i]!,
      accountCode: p.accountCode ?? null,
      staffId: p.staffId ?? null,
      moneyAccountId: p.moneyAccountId ?? null,
      cashRequestId: p.cashRequestId ?? null,
    })),
  );

  return { id };
}
