/**
 * T-389 S4 (DEF-617): the saved low-stock threshold keeps what was typed after a refused save. Not a `'use server'`
 * file. The record is the item id (the page is already one store); never the hidden storeId or itemId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const LOW_STOCK_THRESHOLD = defineTypedForm({ form: 'lowStock.threshold', fields: ['threshold'] });
