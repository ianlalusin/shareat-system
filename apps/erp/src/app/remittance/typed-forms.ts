/**
 * T-389 (DEF-617): the remittance form that keeps what was typed after a refused save. Not a `'use server'` file, so the
 * page and the action import one definition. Only user-editable controls: never the hidden storeId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** A store's cash policy. The record is the store id. */
export const CASH_POLICY_EDIT = defineTypedForm({
  form: 'remittance.cashPolicy',
  fields: ['remittanceCadence', 'unremittedCeiling'],
});
