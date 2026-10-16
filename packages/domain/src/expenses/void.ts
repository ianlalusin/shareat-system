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
import { apRepo, auditLogRepo, cashRequestsRepo, expensesRepo, journalRepo, personsRepo, transaction, type Tx } from '@shareat/db';
import { compare, formatMoney, money, ZERO } from '@shareat/core/money';
import { parseBusinessDate } from '@shareat/core/datetime';
import { reverseEntry } from '../ledger/reverse-entry';
import { retireAssetFromVoidedExpense } from '../fixed-assets/capitalize';
import { refuse, gone, internalFault, humanDate } from '../shared/refusal';
import { capAuditText } from '../shared/audit-text';
import { authorizeOtherStores } from '../ledger/inter-store';

export interface VoidExpenseResult {
  reversalEntryId: string;
  /** false means this expense was already voided — nothing new was written. */
  created: boolean;
}

/** ⭐ T-367 S2 / R6 audit fix — names the expense by its OWN content, never its id, so a
 *  `voidInvoice` cascade over several expenses says which bill is already paid (`repo/ap.ts`'s
 *  `invoicePhrase` is the same idea, one field over). Falls back to the bare particulars on an
 *  unparseable date rather than throwing out of a refusal path. */
function expensePhrase(expense: { particulars: string; businessDate: string }): string {
  try {
    return `${expense.particulars} (${humanDate(parseBusinessDate(expense.businessDate))})`;
  } catch {
    return expense.particulars;
  }
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
  let expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw gone(`voidExpense: expense ${expenseId} does not exist in org ${actor.orgId}`, 'expense');
  }

  await authorize(tx, actor, 'void_expense', { storeId: expense.storeId });

  // T-369 S9 A1 (DEF-573): an expense paid from another store's account moved that store's money; undoing it moves
  // it again, so the void needs `transfer_funds` at every OTHER store the posted entry's lines touch (also reached
  // from `voidInvoice`'s cascade). Authorize first, before any lock or business refusal (T-364). A draft has no
  // entry yet, skips this, and still meets its own draft refusal below.
  if (expense.journalEntryId) {
    await authorizeOtherStores(tx, actor, {
      lines: await journalRepo.findLinesForEntryWithAccountCodes(tx, expense.journalEntryId),
      documentStoreId: expense.storeId,
    });
  }

  // ⭐ T-367 S2 / R6 (DEF-519) — the SAME row lock `recordPayment` takes (`ap/index.ts:883`) on this
  // expense, so a payment allocating to it and a void of it serialise here; whichever waits re-reads
  // the other's committed result. `voidInvoice`'s cascade already holds this lock on every live
  // expense (in id order) before it calls `voidExpense`, so this is a no-op re-lock in that path, not
  // a second, differently-ordered one.
  await apRepo.lockExpensesForAllocation(tx, actor.orgId, [expenseId]);
  expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw internalFault(`voidExpense: expense ${expenseId} vanished between its first read and the lock`);
  }

  // ⭐ T-367 S2 / R6 (DEF-519) — a bill already paid cannot be voided out from under its payment:
  // voiding it would reverse the 2110 credit a `posted` ap_payment still allocates against, leaving
  // the control account short by exactly what was paid (a debit on a liability control — V5's mutant).
  // Checked with the lock already held above, so nothing can post a NEW allocation against this
  // expense between this read and `reverseEntry` below.
  const postedAllocated = money(await apRepo.postedAllocatedFor(tx, actor.orgId, expenseId));
  if (compare(postedAllocated, ZERO) > 0) {
    throw refuse(
      `voidExpense: expense ${expenseId} has ${formatMoney(postedAllocated)} allocated to a posted AP payment — void the payment first`,
      `${formatMoney(postedAllocated)} has already been paid against ${expensePhrase(expense)}. Void that payment first, then void the bill.`,
    );
  }

  if (expense.status === 'draft') {
    throw refuse(
      `voidExpense: expense ${expenseId} is a draft — nothing has been posted yet to void; edit or discard it instead`,
      'This expense is still a draft, so there is nothing posted to void. Edit or discard it instead.',
    );
  }
  if (!expense.journalEntryId) {
    throw internalFault(`voidExpense: expense ${expenseId} is ${expense.status} but carries no journalEntryId — data inconsistency`);
  }

  const trimmedReason = (reason ?? '').trim();
  if (!trimmedReason) {
    throw refuse(
      'voidExpense: reason is required and cannot be empty or whitespace-only',
      'Reason is required and cannot be empty or whitespace-only.',
    );
  }

  // ⭐ T-415 (DEF-661, ruling 4): voiding puts float money back on its cash request, so every request this expense drew on
  // must still be open. Locked (id order, de-duplicated) after the expense lock above and before the reversal, so a
  // settle that is closing the request is waited for, then read.
  const requestIds = [
    ...new Set((await expensesRepo.getPaymentsForExpense(tx, expenseId)).map((p) => p.cashRequestId).filter((id): id is string => !!id)),
  ];
  if (requestIds.length > 0) {
    for (const req of await cashRequestsRepo.lockForSpend(tx, actor.orgId, requestIds)) {
      if (req.status !== 'released') {
        const holder = (await personsRepo.getPersonById(tx, actor.orgId, req.requestedFor))?.displayName ?? 'The holder';
        throw refuse(
          `voidExpense: expense ${expenseId} drew on cash request ${req.id}, which is ${req.status}`,
          `${holder}'s cash request is ${req.status}, so this cannot be voided. The request must still be released.`,
        );
      }
    }
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
    // T-402 S3 (C4): the void step's event, same transaction, after its own writes.
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'expense.voided',
      storeId: expense.storeId,
      entityId: expenseId,
      before: { status: expense.status },
      after: { status: 'voided', amount: expense.totalAmount, reason: capAuditText(trimmedReason) },
      source: 'web',
    });
  }

  return { reversalEntryId: result.reversalEntryId, created: result.created };
}
