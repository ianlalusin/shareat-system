/**
 * T-389 (DEF-617): the trade-order forms that keep what was typed after a refused save. Not a `'use server'` file, so the
 * page and `actions.ts` import the same definition. Only user-editable controls are listed: never a hidden id.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** The BIR booklet number on a trade order. The record is the order id. */
export const BIR_INVOICE_NO = defineTypedForm({
  form: 'tradeorder.birno',
  fields: ['birInvoiceNo'],
});
