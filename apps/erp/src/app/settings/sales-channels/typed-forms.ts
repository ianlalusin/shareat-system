/**
 * T-389 (DEF-617): each sales channel's edit form keeps what was typed after a refused save. Not a 'use server'
 * file, so the page and the action import one definition. The record is the channel id; never the hidden ids.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const SALES_CHANNEL_EDIT = defineTypedForm({
  form: 'salesChannel.edit',
  fields: ['name', 'isRemittedDaily', 'receivableAccountCode', 'wastageTypeMode'],
});

/** T-564: the store's settlement wiring. The record is the store id. */
export const STORE_SETTLEMENT_EDIT = defineTypedForm({
  form: 'storeSettlement.edit',
  fields: ['storeKey', 'matchLabels', 'fileHints', 'wastageEmailIngestEnabled'],
});

/** T-564: a channel's bank names. The record is the channel id. */
export const BANK_HINTS_EDIT = defineTypedForm({
  form: 'salesChannel.bankHints',
  fields: ['bankHints'],
});
