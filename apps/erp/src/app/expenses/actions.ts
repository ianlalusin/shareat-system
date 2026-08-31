'use server';

/**
 * Server actions for the expenses screens — docs/tasks/122-expenses.md.
 *
 * Every action here is a thin adapter: parse `FormData`, build the domain layer's own input
 * shape, run it inside `withOrgPrincipal` (real RLS), and redirect.
 *
 * ⭐ **The actor comes from `requireActor()`, never from the form** (T-138, bible §7.1). Until
 * 2026-08-25 these read a person the browser supplied, which made the create/approve segregation
 * unenforceable. No business rule is re-implemented here — `createExpense` / `approveExpense`
 * / `editExpense` / `voidExpense` (packages/domain/src/expenses/*.ts) already own every
 * invariant; this file only wires HTML forms to them.
 */
import { redirect } from 'next/navigation';
import {
  approveExpense,
  createExpense,
  editExpense,
  voidExpense,
  deleteExpenseDraft,
  recordExpenseForInvoice,
  type ExpensePaymentMethod,
} from '@shareat/domain';
import { apRepo } from '@shareat/db';
import { withOrgPrincipal, PAYMENT_ROW_COUNT } from './lib';
import { requireActor } from '../../lib/session';

const PAYMENT_METHODS = new Set<string>(['cash', 'online', 'credit', 'reimbursable', 'other', 'ar_collection']);

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every action ends up back on a page carrying `org`/`store`/`as` (the "acting as"
 *  filter state the reports screens already use for org/store) so the picker state
 *  survives the round trip. */
/** Only filter state travels in the URL now — the org and the person come from the session. */
function carryQs(fd: FormData): string {
  const params = new URLSearchParams();
  const store = str(fd, 'storeId');
  if (store) params.set('store', store);
  return params.toString();
}

interface ParsedExpenseForm {
  storeId: string;
  supplierId: string;
  supplierInvoiceId: string;
  categoryId: string;
  particulars: string;
  payments: { method: ExpensePaymentMethod; amount: string; staffId?: string; cashRequestId?: string; moneyAccountId?: string }[];
  returnTo: string;
  qs: string;
}

/**
 * ⭐ Shared by both actions below — the two forms differ only in WHAT they call once the fields
 * are in hand (create a draft vs. record-and-post against an already-verified invoice), never in
 * how they are parsed. `supplierId` is resolved from the invoice when the form did not supply it
 * (the invoice already names its supplier — the form only has to pick ONE thing).
 */
async function parseExpenseForm(
  formData: FormData,
  actor: { orgId: string },
  fallbackReturnTo: string,
): Promise<ParsedExpenseForm> {
  const storeId = str(formData, 'storeId');
  const qs = carryQs(formData);
  // ⭐ Each form names where it actually lives (`/expenses/new` or `/ap/invoices/[id]`) — a
  // hardcoded error redirect back to one screen silently drops the other caller onto the wrong
  // page with every field wiped (caught in the browser, not by a test: an overdraft rejection
  // while smoketesting the embedded form). `fallbackReturnTo` only covers a form that omitted it.
  const returnTo = str(formData, 'returnTo') || fallbackReturnTo;

  const categoryId = str(formData, 'categoryId');
  let supplierId = str(formData, 'supplierId');
  const supplierInvoiceId = str(formData, 'supplierInvoiceId');
  const particulars = str(formData, 'particulars');

  const payments: ParsedExpenseForm['payments'] = [];
  for (let i = 1; i <= PAYMENT_ROW_COUNT; i++) {
    const method = str(formData, `method_${i}`);
    const amount = str(formData, `amount_${i}`);
    if (!method || !amount) continue;
    if (!PAYMENT_METHODS.has(method)) continue;
    const staffId = str(formData, `staffId_${i}`);
    const cashRequestId = str(formData, `cashRequestId_${i}`);
    const moneyAccountId = str(formData, `moneyAccountId_${i}`);
    payments.push({
      method: method as ExpensePaymentMethod,
      amount,
      staffId: staffId || undefined,
      cashRequestId: cashRequestId || undefined,
      moneyAccountId: moneyAccountId || undefined,
    });
  }

  if (!storeId) throw new Error('Choose a store.');
  if (!supplierInvoiceId) throw new Error('Choose a supplier invoice.');
  if (payments.length === 0) {
    throw new Error('At least one payment row (method + amount) is required.');
  }
  if (!supplierId) {
    const invoice = await withOrgPrincipal(actor.orgId, (tx) =>
      apRepo.getSupplierInvoiceById(tx, actor.orgId, supplierInvoiceId),
    );
    if (!invoice) throw new Error(`Supplier invoice ${supplierInvoiceId} does not exist.`);
    supplierId = invoice.supplierId;
  }

  return { storeId, supplierId, supplierInvoiceId, categoryId, particulars, payments, returnTo, qs };
}

/**
 * ⭐ T-196 — creating no longer posts. `docs/tasks/196-draft-expense-on-a-pending-invoice.md` §3:
 * this now calls `createExpense`, never `recordExpenseForInvoice` — the result is a DRAFT, and
 * `create_expense` alone is sufficient to reach it. That is the whole point of the task: a
 * cashier can record what they spent, against the paper they are holding, with no manager
 * present and no verification wait. The invoice named may be `pending` OR `verified` — either
 * way this only ever drafts; posting still requires `approveExpense` (the expense's own detail
 * page offers it) or, for a pending invoice, waits for `verifyInvoice` to post it automatically.
 *
 * `recordExpenseForInvoiceAction` below is the OTHER entry point — unchanged, for the
 * already-verified case embedded on `/ap/invoices/[id]`, which still posts in one call.
 */
export async function createExpenseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let parsed: ParsedExpenseForm;
  try {
    parsed = await parseExpenseForm(formData, actor, '/expenses/new');
  } catch (err) {
    const qs = carryQs(formData);
    const returnTo = str(formData, 'returnTo') || '/expenses/new';
    redirect(`${returnTo}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }

  let newId: string;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createExpense(tx, actor, {
        storeId: parsed.storeId,
        businessDate: '', // ignored — createExpense forces this from the invoice's own date
        categoryId: parsed.categoryId,
        supplierId: parsed.supplierId,
        supplierInvoiceId: parsed.supplierInvoiceId,
        particulars: parsed.particulars,
        payments: parsed.payments,
      }),
    );
    newId = result.id;
  } catch (err) {
    redirect(`${parsed.returnTo}?${parsed.qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses/${newId}?${parsed.qs}`);
}

/**
 * ⭐ T-196 — `recordExpenseForInvoice` stays, unchanged, for the already-verified case: the
 * embedded "record an expense" form on `/ap/invoices/[id]`, only ever shown once its invoice is
 * `verified` (that page's own `canRecord` check). A manager holding both `create_expense` and
 * `approve_expense` against a verified invoice should not be made to click twice — create then
 * separately approve — when one call already does both, in one transaction.
 */
export async function recordExpenseForInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let parsed: ParsedExpenseForm;
  try {
    parsed = await parseExpenseForm(formData, actor, '/ap');
  } catch (err) {
    const qs = carryQs(formData);
    const returnTo = str(formData, 'returnTo') || '/ap';
    redirect(`${returnTo}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }

  let newId: string;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordExpenseForInvoice(tx, actor, {
        storeId: parsed.storeId,
        supplierId: parsed.supplierId,
        supplierInvoiceId: parsed.supplierInvoiceId,
        categoryId: parsed.categoryId,
        particulars: parsed.particulars,
        payments: parsed.payments,
      }),
    );
    newId = result.expenseId;
  } catch (err) {
    redirect(`${parsed.returnTo}?${parsed.qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses/${newId}?${parsed.qs}`);
}

export async function approveExpenseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(actor.orgId, (tx) => approveExpense(tx, actor, expenseId));
  } catch (err) {
    redirect(`/expenses/${expenseId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses/${expenseId}?${qs}`);
}

export async function voidExpenseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const reason = str(formData, 'reason');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(actor.orgId, (tx) => voidExpense(tx, actor, expenseId, reason));
  } catch (err) {
    redirect(`/expenses/${expenseId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses/${expenseId}?${qs}`);
}

/** The one edit surface this UI exposes: category, particulars and the receipt photo —
 *  covers the central draft-fixup case (attach a photo, correct the category) without
 *  building a full dynamic payment-row editor on top of the create form's (bible
 *  §0.2/§0.5 — "not licence for scope creep"). editExpense itself supports replacing
 *  payments too; a screen for that is a reasonable follow-up, not required for this task's
 *  smoketest. */
export async function updateDraftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const qs = carryQs(formData);

  const categoryId = str(formData, 'categoryId');
  const particulars = str(formData, 'particulars');

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      editExpense(tx, actor, expenseId, {
        categoryId: categoryId || undefined,
        particulars: particulars || undefined,
      }),
    );
  } catch (err) {
    redirect(`/expenses/${expenseId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses/${expenseId}?${qs}`);
}

/** Deleting a DRAFT — Ian 2026-08-25: "delete for simplicity." Redirects to the LIST, not
 *  back to the record: there is no record any more, and sending the browser to a page that
 *  now 404s would make a successful delete look like a failure. */
export async function deleteDraftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(actor.orgId, (tx) => deleteExpenseDraft(tx, actor, expenseId));
  } catch (err) {
    redirect(`/expenses/${expenseId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses?${qs}`);
}
