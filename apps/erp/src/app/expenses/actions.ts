'use server';

/**
 * Server actions for the expenses screens — docs/tasks/122-expenses.md.
 *
 * Every action here is a thin adapter: parse `FormData`, build the domain layer's own
 * input shape, run it inside `withOrgPrincipal` (real RLS — see lib.ts's top comment for
 * why `orgId`/`actingPersonId` are read from the submitted form rather than a session),
 * and redirect. No business rule is re-implemented here — `createExpense` / `approveExpense`
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
import { withOrgPrincipal } from './lib';

const PAYMENT_ROW_COUNT = 4;
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
function carryQs(fd: FormData): string {
  const params = new URLSearchParams();
  const org = str(fd, 'orgId');
  const store = str(fd, 'storeId');
  const as = str(fd, 'actingPersonId');
  if (org) params.set('org', org);
  if (store) params.set('store', store);
  if (as) params.set('as', as);
  return params.toString();
}

export async function createExpenseAction(formData: FormData): Promise<void> {
  const orgId = str(formData, 'orgId');
  const storeId = str(formData, 'storeId');
  const actingPersonId = str(formData, 'actingPersonId');
  const qs = carryQs(formData);

  const businessDate = str(formData, 'businessDate');
  const categoryId = str(formData, 'categoryId');
  const supplierId = str(formData, 'supplierId');
  const particulars = str(formData, 'particulars');
  const receiptPhotoUrl = str(formData, 'receiptPhotoUrl');

  const payments: { method: ExpensePaymentMethod; amount: string; staffId?: string; cashRequestId?: string; accountCode?: string }[] = [];
  for (let i = 1; i <= PAYMENT_ROW_COUNT; i++) {
    const method = str(formData, `method_${i}`);
    const amount = str(formData, `amount_${i}`);
    if (!method || !amount) continue;
    if (!PAYMENT_METHODS.has(method)) continue;
    const staffId = str(formData, `staffId_${i}`);
    const cashRequestId = str(formData, `cashRequestId_${i}`);
    const office = formData.get(`office_${i}`) === 'on';
    payments.push({
      method: method as ExpensePaymentMethod,
      amount,
      staffId: staffId || undefined,
      cashRequestId: cashRequestId || undefined,
      accountCode: office ? 'office' : undefined,
    });
  }

  let newId: string;
  try {
    if (!orgId || !storeId || !actingPersonId) {
      throw new Error('Organization, store and "acting as" are all required.');
    }
    if (payments.length === 0) {
      throw new Error('At least one payment row (method + amount) is required.');
    }
    const result = await withOrgPrincipal(orgId, (tx) =>
      createExpense(tx, { personId: actingPersonId, orgId }, {
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
  const orgId = str(formData, 'orgId');
  const actingPersonId = str(formData, 'actingPersonId');
  const expenseId = str(formData, 'expenseId');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(orgId, (tx) => approveExpense(tx, { personId: actingPersonId, orgId }, expenseId));
  } catch (err) {
    redirect(`/expenses/${expenseId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses/${expenseId}?${qs}`);
}

export async function voidExpenseAction(formData: FormData): Promise<void> {
  const orgId = str(formData, 'orgId');
  const actingPersonId = str(formData, 'actingPersonId');
  const expenseId = str(formData, 'expenseId');
  const reason = str(formData, 'reason');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(orgId, (tx) => voidExpense(tx, { personId: actingPersonId, orgId }, expenseId, reason));
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
  const orgId = str(formData, 'orgId');
  const actingPersonId = str(formData, 'actingPersonId');
  const expenseId = str(formData, 'expenseId');
  const qs = carryQs(formData);

  const categoryId = str(formData, 'categoryId');
  const particulars = str(formData, 'particulars');
  const receiptPhotoUrl = str(formData, 'receiptPhotoUrl');

  try {
    await withOrgPrincipal(orgId, (tx) =>
      editExpense(tx, { personId: actingPersonId, orgId }, expenseId, {
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
  const orgId = str(formData, 'orgId');
  const actingPersonId = str(formData, 'actingPersonId');
  const expenseId = str(formData, 'expenseId');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(orgId, (tx) => deleteExpenseDraft(tx, { personId: actingPersonId, orgId }, expenseId));
  } catch (err) {
    redirect(`/expenses/${expenseId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/expenses?${qs}`);
}
