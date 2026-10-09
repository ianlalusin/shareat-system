/**
 * T-389 (DEF-617): the recurring-template form that keeps what was typed after a refused save. Not a `'use server'`
 * file, so the page and the action import one definition. Only user-editable controls: never storeId or templateId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** An existing recurring template's edit form. The record is the template id. */
export const RECURRING_TEMPLATE_EDIT = defineTypedForm({
  form: 'recurring.template',
  fields: [
    'name',
    'supplierId',
    'categoryId',
    'defaultAmount',
    'interval',
    'anchorDay',
    'defaultMoneyAccountId',
    'tillIsDeliberate',
  ],
});
