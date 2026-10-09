/**
 * T-389 (DEF-617): the budgets form that keeps what was typed after a refused save. Not a `'use server'` file, so the
 * page and the action import one definition. Only user-editable controls: never storeId, periodKey or categoryId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** A category's cap. The record is the category id (the page is one store and one period). */
export const BUDGET_CAP_EDIT = defineTypedForm({
  form: 'budget.cap',
  fields: ['amount', 'autoReissue', 'reissueInterval'],
});
