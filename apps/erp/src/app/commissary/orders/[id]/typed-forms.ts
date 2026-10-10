/**
 * T-389 S4 (DEF-617): the two per-line commissary forms keep what was typed after a refused save. Not a `'use server'`
 * file. The record is the line id (every line is its own record); never the hidden orderId or lineId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const COMMISSARY_LINE_UPDATE = defineTypedForm({ form: 'commissary.lineUpdate', fields: ['quantity', 'rate'] });
export const COMMISSARY_LINE_FULFIL = defineTypedForm({ form: 'commissary.lineFulfil', fields: ['quantity', 'rate', 'sourceLocationId'] });
