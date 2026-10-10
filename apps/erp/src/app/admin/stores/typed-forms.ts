/**
 * T-389 (DEF-617): the store-detail forms that keep what was typed after a refused save. Not a `'use server'` file,
 * so the page and the actions import one definition. Only user-editable controls: never the hidden storeId or
 * confirmedPlan. The record is the store id for all three.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const STORE_DETAILS = defineTypedForm({
  form: 'store.details',
  fields: ['name', 'timezone', 'address', 'contactNumber', 'tinBranchCode'],
});

/** Plain-error branches only; the confirm-to-proceed branch keeps its own keep keys. */
export const STORE_OPENING_DATE = defineTypedForm({
  form: 'store.openingDate',
  fields: ['openingDate'],
});

export const STORE_STOCK_MODEL = defineTypedForm({
  form: 'store.stockModel',
  fields: ['stockModel'],
});
