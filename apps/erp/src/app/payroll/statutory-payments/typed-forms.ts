/**
 * T-193 S5 / T-389: the record-a-payment form keeps what was typed after a refused save. Not a `'use server'` file, so the page and
 * the action import one definition. Only user-editable controls: never the form's own id, the agency or the month (those ride in
 * the page's own navigation). A singleton: the form has no record yet, so its record is ''.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const STATUTORY_PAYMENT_RECORD = defineTypedForm({
  form: 'statutoryPayment.record',
  singleton: true,
  fields: [
    'paidOn',
    'moneyAccountId',
    'referenceNo',
    'penalty',
    'notes',
    'lineStoreId',
    'lineAmount',
    'periodOverrideConfirm',
    'periodOverrideReason',
    'periodOverrideNote',
  ],
});
