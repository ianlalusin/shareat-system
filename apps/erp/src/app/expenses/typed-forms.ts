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
