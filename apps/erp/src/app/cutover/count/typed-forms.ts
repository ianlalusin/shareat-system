/**
 * T-389 S4 (DEF-617): a saved opening count keeps what was typed after a refused save. Not a `'use server'` file.
 * The record is `itemId:locationId` (the page is already one store; the room matters: bible row 300, DEF-630); never the hidden ids.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const CUTOVER_COUNT = defineTypedForm({ form: 'cutover.count', fields: ['quantity', 'unitCost'] });
