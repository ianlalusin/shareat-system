/**
 * approveExpense — the posting step. docs/tasks/122-expenses.md §2, §5, §6.
 *
 * "create · approve · void, posting via postEntry" (Scope) — approve IS the post: there
 * is no separate fourth verb. It is also where every routing invariant (6-10) and the
 * receipt-photo gate (invariant 11, DEF-055) actually run — a draft may sit with an
 * unmapped category or an unmapped payment method; only approving it is blocked.
 *
 * `idempotencyKey = expense:{id}:post`, exactly as the spec names it. Re-approving an
 * already-posted expense is a safe no-op (invariant 4) — this function short-circuits
 * before even loading the category/payments, mirroring `postEntry`'s own "idempotency
 * checked first" philosophy.
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, transaction, type Tx } from '@shareat/db';
import { money } from '@shareat/core/money';
import { postEntry } from '../ledger/post-entry';
import { routeExpense } from './routing';

export interface ApproveExpenseResult {
  journalEntryId: string;
  /** false means this expense was already posted — nothing new was written. */
  created: boolean;
}

export async function approveExpense(
  tx: Tx | null,
  actor: Actor,
  expenseId: string,
): Promise<ApproveExpenseResult> {
  if (tx) return runApproveExpense(tx, actor, expenseId);
  return transaction((trx) => runApproveExpense(trx, actor, expenseId));
}

async function runApproveExpense(tx: Tx, actor: Actor, expenseId: string): Promise<ApproveExpenseResult> {
  // Org-scoped read before authorize() — see edit.ts's identical comment: the capability
  // is store-scoped and the store is a property of the resource itself.
  const expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw new Error(`approveExpense: expense ${expenseId} does not exist in org ${actor.orgId}`);
  }

  await authorize(tx, actor, 'approve_expense', { storeId: expense.storeId });

  if (expense.status === 'posted') {
    if (!expense.journalEntryId) {
      throw new Error(`approveExpense: expense ${expenseId} is posted but carries no journalEntryId — data inconsistency`);
    }
    return { journalEntryId: expense.journalEntryId, created: false };
  }
  if (expense.status === 'voided') {
    throw new Error(`approveExpense: expense ${expenseId} is voided — cannot post`);
  }

  // Invariant 11 — no photo, no posting. Enforced HERE, server-side, at post — never
  // merely in the form (DEF-055: every expense recorded through this module is external
  // by construction, so the gate is simply "no photo, no posting", with no further
  // condition to evaluate).
  if (!expense.receiptPhotoUrl || !expense.receiptPhotoUrl.trim()) {
    throw new Error(
      `approveExpense: expense ${expenseId} has no receipt photo — cannot post (invariant 11, DEF-055)`,
    );
  }

  const category = await expensesRepo.getCategoryById(tx, actor.orgId, expense.categoryId);
  if (!category) {
    throw new Error(`approveExpense: category ${expense.categoryId} for expense ${expenseId} no longer exists`);
  }

  const payments = await expensesRepo.getPaymentsForExpense(tx, expenseId);

  const routed = routeExpense({
    totalAmount: money(expense.totalAmount),
    supplierId: expense.supplierId,
    categoryName: category.category,
    categoryAccountCode: category.accountCode,
    payments: payments.map((p) => ({
      method: p.method,
      amount: money(p.amount),
      staffId: p.staffId,
      cashRequestId: p.cashRequestId,
      accountCode: p.accountCode,
    })),
  });

  if (!routed.ok) {
    // Invariants 7, 8, 9, 10 all surface here, by name, never a bare exception. The
    // expense itself is UNCHANGED — still a draft, fixable and re-approvable.
    throw new Error(`approveExpense: expense ${expenseId} cannot post — ${routed.reason}`);
  }

  const result = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: expense.businessDate,
    // The real v1 sourceType (packages/etl/src/leg-mapping.ts's own finding: the spec's
    // pretty name "expense" is actually written as `expense_payment`) — reused here so
    // this module's postings sit in the same taxonomy POSTING-PATTERNS.md already
    // documents ("Expense payment (`expense_payment`) — 4,396 legs, #1").
    sourceType: 'expense_payment',
    sourceId: expenseId,
    idempotencyKey: `expense:${expenseId}:post`,
    memo: expense.particulars,
    postedBy: actor.personId,
    lines: routed.lines.map((l) => ({
      accountCode: l.accountCode,
      storeId: expense.storeId,
      partyType: l.partyType ?? null,
      partyId: l.partyId ?? null,
      debit: l.side === 'debit' ? l.amount : '0',
      credit: l.side === 'credit' ? l.amount : '0',
      lineMemo: l.lineMemo ?? null,
    })),
  });

  if (result.created) {
    await expensesRepo.markExpensePosted(tx, actor.orgId, expenseId, {
      journalEntryId: result.entryId,
      approvedBy: actor.personId,
    });
  }

  return { journalEntryId: result.entryId, created: result.created };
}
