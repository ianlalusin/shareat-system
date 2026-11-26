/**
 * T-389 (DEF-617) for `/admin/pos-tablets`: the forms that keep what was typed after a refused save. Not a `'use server'` file, so the page and the actions
 * import the same definitions and the form keys cannot drift. Only user-editable controls are listed: never a hidden id (chargeOptionId, storeId).
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** T-634: one charge of the org's list, its Edit (amount and per unit; the name is fixed). The record is the charge option id. */
export const CHARGE_OPTION_EDIT = defineTypedForm({
  form: 'chargeOption.edit',
  fields: ['amount', 'perUnit'],
});
