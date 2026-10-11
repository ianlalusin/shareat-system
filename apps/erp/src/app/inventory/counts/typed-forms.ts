/**
 * T-389 S4 (DEF-617): a counted line keeps what was typed after a refused save. Not a `'use server'` file.
 * The record is the count line's own id (count_lines.id: one uuid, safe when a session counts several rooms);
 * never the hidden sessionId, itemId or locationId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const COUNT_LINE = defineTypedForm({ form: 'count.line', fields: ['countedQuantity'] });
