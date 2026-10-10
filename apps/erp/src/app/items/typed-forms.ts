/**
 * T-389 S4 (DEF-617): the item-page forms that keep what was typed after a refused save. Not a `'use server'` file,
 * so the page and the actions import one definition. Only user-editable controls: never the hidden itemId or storeId.
 * The record is the item id, except store sellability, whose record is the store id (the page is already one item).
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const ITEM_RENAME = defineTypedForm({ form: 'item.rename', fields: ['name', 'code', 'adoptSuggestedCode'] });
export const ITEM_UNIT = defineTypedForm({ form: 'item.unit', fields: ['baseUnit'] });
export const ITEM_FLAGS = defineTypedForm({ form: 'item.flags', fields: ['isPurchasable', 'sellableRetail', 'sellableWholesale'] });
export const ITEM_STORE_SELLABILITY = defineTypedForm({
  form: 'item.storeSellability',
  fields: ['isPurchasable', 'sellableRetail', 'sellableWholesale', 'note'],
});
