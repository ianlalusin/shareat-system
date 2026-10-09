/**
 * T-389 (DEF-617): the POS-link forms that keep what was typed after a refused save. Not a `'use server'` file, so the
 * page and the actions import the same definitions and the form keys cannot drift. Only user-editable controls are
 * listed: never a hidden id (storeId, tenderId, version, storeName).
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** One tender's edit form. The record is the tender id. */
export const TENDER_EDIT = defineTypedForm({
  form: 'tender.edit',
  fields: ['name', 'kind', 'moneyAccountId', 'posV1Alias'],
});

/** A linked store's link record. The record is the store id. `posStoreName` exists only while the POS bridge is down. */
export const POS_LINK_EDIT = defineTypedForm({
  form: 'posLink.edit',
  fields: ['posStoreId', 'posStoreName', 'salesChannelId', 'posTaxType'],
});
