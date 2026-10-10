/**
 * T-389 (DEF-617): the money-accounts form that keeps what was typed after a refused save. Not a `'use server'` file,
 * so the page and the action import one definition. Only user-editable controls: never the hidden moneyAccountId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** A foundation account's rename form. The record is the money account id. */
export const MONEY_ACCOUNT_RENAME = defineTypedForm({
  form: 'moneyAccount.rename',
  fields: ['name', 'overdraftLimit'],
});
