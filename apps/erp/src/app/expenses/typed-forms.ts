/**
 * T-389 (DEF-617): the expense draft form that keeps what was typed after a refused save. Not a `'use server'` file,
 * so the page and the action import one definition. Only user-editable controls: never storeId or expenseId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** "Correct this draft" (category + particulars). The record is the expense id. */
export const EXPENSE_DRAFT_EDIT = defineTypedForm({
  form: 'expense.draft',
  fields: ['categoryId', 'particulars'],
});

/**
 * T-475 R14: "Approve & post". A refused approval (a closed month, a blocker the page could not know) reopens with the
 * closed-month override tick, reason and note still filled in. The record is the expense id.
 */
export const EXPENSE_APPROVE = defineTypedForm({
  form: 'expense.approve',
  fields: ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote'],
});
