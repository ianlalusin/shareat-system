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
import { apRepo, expensesRepo, transaction, type Tx } from '@shareat/db';
import { add, money } from '@shareat/core/money';
import { logger } from '@shareat/core/logger';
import type { CreateExpensePaymentInput } from './create';
import { refuse, gone } from '../shared/refusal';
import { cashOnDeliverySentence } from '../shared/money-lines';

/** S2/R2's `savepointLookup` (`packages/auth/src/authorize.ts`), same reasoning as
 *  `expenses/create.ts`'s own copy: a refusal-path naming lookup here must not abort a
 *  caller-owned transaction on a Postgres error (22P02) — run inside its own SAVEPOINT, logged
 *  once at `warn` on failure, then swallowed (code-review item 5, 2026-09-26). */
async function savepointLookup<T>(tx: Tx, run: (t: Tx) => Promise<T>): Promise<T | undefined> {
  return tx.transaction(run).catch((err: unknown) => {
    logger.warn({ err }, 'editExpense: a refusal-branch naming lookup failed inside its savepoint');
    return undefined;
  });
}

/** v1's own edit window, preserved (CAPABILITY-MATRIX.md: "Time-boxed — v1 gives
 *  cashiers 48h on their own. Preserve the window"). Exported so a test can compute
 *  "outside the window" without duplicating the constant. */
export const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface EditExpenseInput {
  /**
   * ⛔ REMOVED at T-130 — an invoice-linked expense's business date is the invoice's own date
   * (receipt-date authority), so accepting one here was accepting a value that must always lose.
   * It is derived below from whichever invoice the row names.
   */
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
    throw gone(`editExpense: expense ${expenseId} does not exist in org ${actor.orgId}`, 'expense');
  }

  if (expense.status !== 'draft') {
    throw refuse(
      `editExpense: expense ${expenseId} is ${expense.status} — only a draft may be edited (invariant 13); void it instead`,
      `Only a draft can be edited — this expense is ${expense.status}. Void it instead.`,
    );
  }

  const isCreator = actor.personId === expense.createdBy;
  const withinWindow = Date.now() - expense.createdAt.getTime() <= EDIT_WINDOW_MS;

  if (isCreator && withinWindow) {
    await authorize(tx, actor, 'edit_own_expense', { storeId: expense.storeId });
  } else {
    await authorize(tx, actor, 'edit_any_expense', { storeId: expense.storeId });
  }

  // ⭐ T-367 S2 / R4 (DEF-396) — lock BEFORE `updateExpenseDraft`'s own UPDATE, not after. The
  // `expenses_check_invoice_open_for_recording` trigger is BEFORE UPDATE, so it fires AFTER
  // Postgres has already taken the expense row's own tuple lock — without this, an edit locks
  // expense-then-invoice (E→I) while `voidInvoice`/`createExpense`/`approveExpense` all lock
  // invoice-then-expense (I→E), and the two orders deadlock under concurrent load. Locking the
  // invoice HERE, before any write, makes `editExpense` I→E like every other writer.
  //
  // When the edit RE-POINTS the expense at a different invoice, BOTH are locked, in id order: two
  // concurrent edits crossing the same pair of invoices in opposite directions would otherwise
  // deadlock on whichever one each edit locks second.
  const currentInvoiceId = expense.supplierInvoiceId;
  const nextInvoiceId = input.supplierInvoiceId ?? currentInvoiceId;
  if (nextInvoiceId === currentInvoiceId) {
    await apRepo.lockInvoiceForRecording(tx, actor.orgId, currentInvoiceId);
  } else {
    for (const id of [currentInvoiceId, nextInvoiceId].sort()) {
      await apRepo.lockInvoiceForRecording(tx, actor.orgId, id);
    }
  }

  const patch: Parameters<typeof expensesRepo.updateExpenseDraft>[3] = {};
  if (input.categoryId !== undefined) {
    const category = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
    if (!category) throw gone(`editExpense: category ${input.categoryId} does not exist in org ${actor.orgId}`, 'expense category');
    patch.categoryId = input.categoryId;
  }

  /**
   * ⭐ T-130 receipt-date authority, enforced on the EDIT path too.
   *
   * ⚠️ `create` forces `businessDate` from the invoice and refuses the caller's value, but this
   * function accepted it raw — so the one field the invariant says can never be client-supplied
   * was editable the moment the row existed. Re-pointing the invoice had the mirror bug: the
   * expense kept the OLD invoice's date. Both are closed here by deriving the date from whichever
   * invoice the row ends up naming, and never from `input`.
   */
  if (input.supplierInvoiceId !== undefined || input.supplierId !== undefined) {
    const invoiceId = input.supplierInvoiceId ?? expense.supplierInvoiceId;
    const invoice = await apRepo.getSupplierInvoiceById(tx, actor.orgId, invoiceId);
    if (!invoice) {
      throw gone(`editExpense: supplier invoice ${invoiceId} does not exist in org ${actor.orgId}`, 'supplier invoice');
    }
    // Same single-source-of-truth rule as create: the invoice owns the supplier.
    const supplierId = input.supplierId ?? invoice.supplierId;
    if (supplierId !== invoice.supplierId) {
      // Refusal-path only, S5 rule 6: neither name is loaded elsewhere in this function, so both
      // need a fresh lookup here; each falls back to a deictic phrase on failure. Savepointed
      // (code-review item 5): a Postgres error here must not abort a caller-owned tx. ⛔ Sequential,
      // never Promise.all — two savepoints on the SAME tx/connection cannot run concurrently
      // (code-review item 9).
      const invoiceSupplier = await savepointLookup(tx, (t) => apRepo.getSupplierById(t, actor.orgId, invoice.supplierId));
      const picked = await savepointLookup(tx, (t) => apRepo.getSupplierById(t, actor.orgId, supplierId));
      throw refuse(
        `editExpense: supplier ${supplierId} does not own supplier invoice ${invoiceId} — ` +
          `that invoice belongs to supplier ${invoice.supplierId}.`,
        `That invoice is from ${invoiceSupplier?.name ?? 'its own supplier'}, not ${picked?.name ?? 'the supplier you picked'}. An expense takes its supplier from its invoice.`,
      );
    }
    patch.supplierInvoiceId = invoiceId;
    patch.supplierId = invoice.supplierId;
    patch.businessDate = invoice.invoiceDate;
  }

  // T-361 / DEF-492 — R3: the same cash-on-delivery rule `createExpense` holds, so a draft cannot
  // be walked around it by editing it afterward. Judged only when payments or the supplier/invoice
  // actually changed — an edit that touches neither gains no query. The payments judged are the
  // ones this edit leaves in place: the replacement set if given, otherwise the row's current set.
  if (input.payments !== undefined || input.supplierInvoiceId !== undefined || input.supplierId !== undefined) {
    const judgedPayments = input.payments ?? (await expensesRepo.getPaymentsForExpense(tx, expenseId));
    if (judgedPayments.some((p) => p.method === 'credit')) {
      const supplierId = patch.supplierId ?? expense.supplierId;
      const supplier = await apRepo.getSupplierById(tx, actor.orgId, supplierId);
      // `supplier` is only ever undefined if the row is gone — `expenses.supplier_id` is NOT NULL
      // (T-130) and org-filtered here, and a supplier is deactivated, never deleted, so this guard
      // never silently skips a real cash-on-delivery supplier.
      if (supplier && supplier.creditTermsDays === null) {
        throw refuse(
          `editExpense: ${supplier.name} is cash-on-delivery (credit_terms_days is null) — a credit payment cannot be recorded against it`,
          cashOnDeliverySentence(supplier.name),
        );
      }
    }
  }

  if (input.particulars !== undefined) {
    const trimmed = input.particulars.trim();
    if (!trimmed) throw refuse('editExpense: particulars cannot be blank', 'Particulars cannot be blank.');
    patch.particulars = trimmed;
  }

  if (input.payments !== undefined) {
    if (input.payments.length === 0) {
      throw refuse('editExpense: at least one payment is required', 'At least one payment is required.');
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
