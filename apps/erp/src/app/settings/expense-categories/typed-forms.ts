/**
 * T-389 (DEF-617): the two forms on each expense-category row keep what was typed after a refused save. Not a
 * 'use server' file, so the page and the actions import one definition. The record is the category id for both;
 * never the hidden categoryId or categoryLabel.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const EXPENSE_CATEGORY_RENAME = defineTypedForm({
  form: 'expenseCategory.rename',
  fields: ['category'],
});

export const EXPENSE_CATEGORY_ACCOUNT = defineTypedForm({
  form: 'expenseCategory.account',
  fields: ['accountCode'],
});
