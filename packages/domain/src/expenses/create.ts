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
 *
 * ⭐ T-130 — `supplierInvoiceId` is now required and gates creation itself.
 * `docs/tasks/130-accounts-payable.md` Invariant 2: no expense — cash or credit — may be
 * created until its `supplier_invoices` row EXISTS and has capacity for this amount, and is not
 * VOIDED. Checked HERE for a clean, named error; the hand-written
 * `expenses_check_invoice_open_for_recording` trigger (migration, DEF-073) is the actual
 * backstop regardless of which code path writes the row. `businessDate` is never taken from the
 * caller when an invoice is named — receipt-date authority (Invariant 3, ported from v1's
 * `expense.actions.ts:179-197`) forces it from the invoice's own `invoiceDate`, server-side,
 * always.
 *
 * ⭐ T-196 — the invoice no longer has to be VERIFIED to create a draft against it. The gate
 * moved from existence to posting: `assertOpenForRecording(..., 'draft')` below only refuses a
 * missing or voided invoice, or one already full; a `pending` invoice is fine, which is the
 * whole point — a cashier holding only `create_expense` can now draft against the paper they are
 * holding, with no manager and no verification wait. `approveExpense` is where `'posted'` is
 * checked, and that is what still requires `verified`.
 *
 * In the ordinary flow this is called immediately followed by `approveExpense` in the SAME
 * transaction — `packages/domain/src/ap`'s `recordExpenseForInvoice` does exactly that, which is
 * what makes Ian's *"expense may already be posted, no need for draft"* true from the caller's
 * side without this file or `approve.ts` needing a second, parallel posting path.
 *
 * ⭐ T-361 / DEF-492 — the cash-on-delivery rule (no credit line against a supplier with no terms)
 * is enforced HERE, for every caller, not only the web action's own copy.
 */
import { authorize, type Actor } from '@shareat/auth';
import { apRepo, expensesRepo, transaction, type Tx } from '@shareat/db';
import { add } from '@shareat/core/money';
import { logger } from '@shareat/core/logger';
import { assertLivePaymentMethod, type ExpensePaymentMethod } from './routing';
import { refuse, gone } from '../shared/refusal';
import { parseDecimalInput } from '../shared/money-input';
import { cashOnDeliverySentence } from '../shared/money-lines';

/**
 * S2/R2's `savepointLookup` (`packages/auth/src/authorize.ts`), applied here: `createExpense`
 * can run inside a CALLER-owned transaction (`ap/index.ts:634`'s `recordExpenseForInvoice`), so a
 * refusal-path naming lookup that errors must not abort that whole transaction — `.catch(() =>
 * undefined)` alone does not un-abort an already-aborted Postgres transaction (22P02). Runs the
 * lookup inside its own SAVEPOINT (`tx.transaction()`, a nested Postgres transaction); a failed
 * lookup rolls back only itself and is logged once at `warn`, then swallowed, so the refusal it
 * decorates still reaches the caller with its fallback wording (code-review item 5, 2026-09-26).
 */
async function savepointLookup<T>(tx: Tx, run: (t: Tx) => Promise<T>): Promise<T | undefined> {
  return tx.transaction(run).catch((err: unknown) => {
    logger.warn({ err }, 'createExpense: a refusal-branch naming lookup failed inside its savepoint');
    return undefined;
  });
}

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
  /**
   * YYYY-MM-DD. ⚠️ IGNORED — always overridden server-side from
   * `supplierInvoices.invoiceDate` (receipt-date authority). Accepted only so a caller has one
   * shape to fill in before the invoice is loaded; never trusted.
   */
  businessDate: string;
  categoryId: string;
  /** ⭐ T-130: required. Every expense names a real supplier now. */
  supplierId: string;
  /** ⭐ T-130: required — the verified invoice this expense is recorded against. */
  supplierInvoiceId: string;
  /**
   * ⭐ T-127: which owner a PERSONAL expense is a drawing against. Null for every other category.
   * ⚠️ Not validated here — a DRAFT may legitimately exist before the owner is chosen. `approve`
   * blocks, naming the reason, the same way an unmapped category does (invariant 7).
   */
  ownerId?: string | null;
  particulars: string;
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
    throw refuse(
      'createExpense: particulars is required — what the spend was actually for',
      'Particulars is required — what the spend was actually for.',
    );
  }
  if (input.payments.length === 0) {
    throw refuse('createExpense: at least one payment is required', 'At least one payment is required.');
  }
  // T-367 S5 (DEF-054): a retired or unknown method is refused with its own sentence before any write.
  for (const p of input.payments) assertLivePaymentMethod(p.method, refuse, 'createExpense');

  const category = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
  if (!category) {
    throw gone(`createExpense: category ${input.categoryId} does not exist in org ${actor.orgId}`, 'expense category');
  }

  // T-371 (R5, R6, C3): each payment amount is parsed AFTER authorize() into its column's (14,2) brand. A typed `abc`
  // or a blank (`expense_payments.amount` is NOT NULL with no default) is a sentence naming the row, not a raw throw.
  const amounts = input.payments.map((p, i) => parsePaymentAmount(p.amount, i, 'createExpense'));
  const totalAmount = add(...amounts);

  // ⭐ T-130 Invariant 2 — the gate, checked here for a clean error; the DB trigger is the
  // backstop. Also resolves receipt-date authority: the invoice's own date wins, always.
  // ⭐ T-196 — target 'draft': a PENDING invoice is fine here. Only 'posted' (approveExpense)
  // still requires 'verified'.
  const invoice = await apRepo.getSupplierInvoiceById(tx, actor.orgId, input.supplierInvoiceId);
  // ⭐ T-367 S2 / R7 (DEF-508) — a store mismatch reads as NOT FOUND (Ian, T-364 Q1 (a): one
  // uniform refusal), checked IMMEDIATELY after the lookup, before assertOpenForRecording and
  // every supplier check below. `gone()`'s userMessage is the same fixed sentence either way —
  // never the invoice number, the other store's name, or any id — so a manager at store A probing
  // store B's invoice id learns nothing beyond "does not exist".
  if (!invoice || invoice.storeId !== input.storeId) {
    throw gone(
      `createExpense: supplier invoice ${input.supplierInvoiceId} does not exist in org ${actor.orgId} at store ${input.storeId}`,
      'supplier invoice',
    );
  }
  // ⭐ T-367 S2 / R4 (DEF-396) — lock the invoice row BEFORE checking capacity, so a concurrent
  // voidInvoice (lockInvoiceForUpdate) or another recording on this SAME invoice serialises here
  // instead of both racing a stale capacity read.
  await apRepo.lockInvoiceForRecording(tx, actor.orgId, input.supplierInvoiceId);
  await apRepo.assertOpenForRecording(tx, actor.orgId, input.supplierInvoiceId, totalAmount, 'draft');

  // ⛔ The invoice names its supplier, so the caller's `supplierId` is a SECOND source of truth
  // for the same fact — and two copies of one fact drift (bible §16.1's whole argument). Nothing
  // validated them against each other before this, so an expense could carry supplier A's party
  // on its 2110 credit while consuming supplier B's invoice capacity and inheriting B's due date
  // for aging. Refused outright rather than silently preferring one: a caller that disagrees with
  // the invoice is confused about which bill it is recording, and guessing which half it got
  // right is how the wrong supplier gets paid.
  // ⭐ Ian, 2026-08-28, requirement 1: an expense may only be recorded against an EXISTING and
  // ACTIVE supplier. Checked here and not only at `recordInvoice`, because a supplier can be
  // deactivated between logging the bill and recording the spend against it — and the second is
  // the step that moves money.
  const supplier = await apRepo.getSupplierById(tx, actor.orgId, invoice.supplierId);
  if (!supplier) {
    throw gone(`createExpense: supplier ${invoice.supplierId} does not exist in org ${actor.orgId}`, 'supplier');
  }
  if (supplier.status !== 'active') {
    throw refuse(
      `createExpense: ${supplier.name} is ${supplier.status}, not active — an expense cannot be ` +
        'recorded against a supplier the business has stopped buying from.',
      `${supplier.name} is ${supplier.status}, not active — an expense cannot be recorded against a supplier the business has stopped buying from.`,
    );
  }

  if (input.supplierId !== invoice.supplierId) {
    // Refusal-path only: `supplier` above is already the invoice's own supplier, reused; the
    // picked supplier's name needs a fresh lookup that never runs on the success path (S5 rule 6),
    // savepointed since this function can run inside a caller-owned tx (code-review item 5).
    const picked = await savepointLookup(tx, (t) => apRepo.getSupplierById(t, actor.orgId, input.supplierId));
    throw refuse(
      `createExpense: supplier ${input.supplierId} does not own supplier invoice ` +
        `${input.supplierInvoiceId} — that invoice belongs to supplier ${invoice.supplierId}. ` +
        'An expense takes its supplier from the invoice it is recorded against.',
      `That invoice is from ${supplier.name}, not ${picked?.name ?? 'the supplier you picked'}. An expense takes its supplier from its invoice.`,
    );
  }

  // T-361 / DEF-492 — R2: after the supplier-mismatch refusal (so a picked/invoice-supplier
  // disagreement still wins) and before any write. `supplier` above is already the invoice's own
  // supplier — the authoritative one, never the caller's `input.supplierId`.
  if (input.payments.some((p) => p.method === 'credit') && supplier.creditTermsDays === null) {
    throw refuse(
      `createExpense: ${supplier.name} is cash-on-delivery (credit_terms_days is null) — a credit payment cannot be recorded against it`,
      cashOnDeliverySentence(supplier.name),
    );
  }

  const { id } = await expensesRepo.insertExpense(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    businessDate: invoice.invoiceDate,
    totalAmount,
    categoryId: input.categoryId,
    supplierId: input.supplierId,
    supplierInvoiceId: input.supplierInvoiceId,
    ownerId: input.ownerId ?? null,
    particulars,
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

/**
 * T-371 — one payment row's amount, parsed into `expense_payments.amount`'s (14,2) brand. Shared by `editExpense`, which
 * replaces the same rows. The column is NOT NULL with no default, so a blank is refused (R6), never an invented zero.
 */
export function parsePaymentAmount(raw: string, index: number, fn: string) {
  return parseDecimalInput(raw, '14,2', `${fn}: payment ${index + 1}'s amount`, `Payment ${index + 1}'s amount`, {
    blank: 'refuse',
  });
}
