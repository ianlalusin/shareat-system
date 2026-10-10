/**
 * T-389 (DEF-617): the sales-day form that keeps what was typed after a refused save. Not a `'use server'` file, so the
 * page and the action import one definition. Only user-editable controls: never storeId or salesDayId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** A POS-feed day's platform sales: one amount box and one "no sales" tick per channel (the channel's UUID in the name). The record is the sales day id. */
export const PLATFORM_SALES_EDIT = defineTypedForm({
  form: 'salesDay.platform',
  fields: [/^(channel|nosales)_[0-9a-f-]{36}$/],
});
