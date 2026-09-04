/**
 * voidExpense — the only correction path for a POSTED expense. docs/tasks/122-expenses.md
 * §7, invariant 5.
 *
 * "Void, never edit" — a posted expense is never edited (edit.ts's own status check
 * already makes that true structurally; this is the other half). Voiding reverses the
 * journal entry through the real `reverseEntry`, same discipline the ledger itself uses,
 * for the same reason: a correction is a new, dated fact, never a quiet rewrite of
 * history.
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, transaction, type Tx } from '@shareat/db';
import { reverseEntry } from '../ledger/reverse-entry';
import { retireAssetFromVoidedExpense } from '../fixed-assets/capitalize';

export interface VoidExpenseResult {
  reversalEntryId: string;
  /** false means this expense was already voided — nothing new was written. */
  created: boolean;
}

export async function voidExpense(
  tx: Tx | null,
  actor: Actor,
  expenseId: string,
  reason: string,
): Promise<VoidExpenseResult> {
  if (tx) return runVoidExpense(tx, actor, expenseId, reason);
  return transaction((trx) => runVoidExpense(trx, actor, expenseId, reason));
}

async function runVoidExpense(tx: Tx, actor: Actor, expenseId: string, reason: string): Promise<VoidExpenseResult> {
  const expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw new Error(`voidExpense: expense ${expenseId} does not exist in org ${actor.orgId}`);
  }

  await authorize(tx, actor, 'void_expense', { storeId: expense.storeId });

  if (expense.status === 'draft') {
    throw new Error(
      `voidExpense: expense ${expenseId} is a draft — nothing has been posted yet to void; edit or discard it instead`,
    );
  }
  if (!expense.journalEntryId) {
    throw new Error(`voidExpense: expense ${expenseId} is ${expense.status} but carries no journalEntryId — data inconsistency`);
  }

  const trimmedReason = (reason ?? '').trim();
  if (!trimmedReason) {
    throw new Error('voidExpense: reason is required and cannot be empty or whitespace-only');
  }

  const result = await reverseEntry(tx, {
    entryId: expense.journalEntryId,
    reason: trimmedReason,
    reversedBy: actor.personId,
  });

  if (result.created) {
    await expensesRepo.markExpenseVoided(tx, actor.orgId, expenseId, {
      voidedBy: actor.personId,
      voidReason: trimmedReason,
    });
    // DEF-160: a CAPEX expense may have auto-capitalised a fixed asset (approve.ts). Retire that
    // register row as a consequence of the void — see capitalize.ts's own header for why this
    // must not post a second cost-removal entry.
    await retireAssetFromVoidedExpense(tx, actor, {
      expenseId,
      expenseBusinessDate: expense.businessDate,
      reason: trimmedReason,
    });
  }

  return { reversalEntryId: result.reversalEntryId, created: result.created };
}
