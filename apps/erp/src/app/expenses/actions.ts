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
  createExpense,
  approveExpense,
  editExpense,
  voidExpense,
  deleteExpenseDraft,
  type ExpensePaymentMethod,
} from '@shareat/domain';
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

export async function createExpenseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const qs = carryQs(formData);

  const businessDate = str(formData, 'businessDate');
  const categoryId = str(formData, 'categoryId');
  const supplierId = str(formData, 'supplierId');
  const particulars = str(formData, 'particulars');
  const receiptPhotoUrl = str(formData, 'receiptPhotoUrl');

  const payments: { method: ExpensePaymentMethod; amount: string; staffId?: string; cashRequestId?: string; accountCode?: string; moneyAccountId?: string }[] = [];
  for (let i = 1; i <= PAYMENT_ROW_COUNT; i++) {
    const method = str(formData, `method_${i}`);
    const amount = str(formData, `amount_${i}`);
    if (!method || !amount) continue;
    if (!PAYMENT_METHODS.has(method)) continue;
    const staffId = str(formData, `staffId_${i}`);
    const cashRequestId = str(formData, `cashRequestId_${i}`);
    const moneyAccountId = str(formData, `moneyAccountId_${i}`);
    const office = formData.get(`office_${i}`) === 'on';
    payments.push({
      method: method as ExpensePaymentMethod,
      amount,
      staffId: staffId || undefined,
      cashRequestId: cashRequestId || undefined,
      moneyAccountId: moneyAccountId || undefined,
      accountCode: office ? 'office' : undefined,
    });
  }

  let newId: string;
  try {
    if (!storeId) throw new Error('Choose a store.');
    if (payments.length === 0) {
      throw new Error('At least one payment row (method + amount) is required.');
    }
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createExpense(tx, actor, {
        storeId,
        businessDate,
        categoryId,
        supplierId: supplierId || undefined,
        particulars,
        receiptPhotoUrl: receiptPhotoUrl || undefined,
        payments,
      }),
    );
    newId = result.id;
  } catch (err) {
    redirect(`/expenses/new?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses/${newId}?${qs}`);
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
  const receiptPhotoUrl = str(formData, 'receiptPhotoUrl');

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      editExpense(tx, actor, expenseId, {
        categoryId: categoryId || undefined,
        particulars: particulars || undefined,
        receiptPhotoUrl: receiptPhotoUrl || undefined,
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
