/**
 * T-389 (DEF-617): each sales channel's edit form keeps what was typed after a refused save. Not a 'use server'
 * file, so the page and the action import one definition. The record is the channel id; never the hidden ids.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const SALES_CHANNEL_EDIT = defineTypedForm({
  form: 'salesChannel.edit',
  fields: ['name', 'isRemittedDaily', 'receivableAccountCode', 'wastageTypeMode'],
});
