/**
 * T-389 S4 (DEF-617): a saved opening count keeps what was typed after a refused save. Not a `'use server'` file.
 * The record is the item id (the page is already one store); never the hidden storeId or itemId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const CUTOVER_COUNT = defineTypedForm({ form: 'cutover.count', fields: ['quantity', 'unitCost'] });
