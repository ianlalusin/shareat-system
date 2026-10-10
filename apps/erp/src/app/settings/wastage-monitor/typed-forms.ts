/**
 * T-389 (DEF-617): the Wastage Monitor form keeps what was picked after a refused save. Not a 'use server' file,
 * so the page and the action import one definition. The record is the store id; never the hidden storeId or label.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const WASTAGE_MONITOR_EDIT = defineTypedForm({
  form: 'wastageMonitor.edit',
  fields: ['personId'],
});
