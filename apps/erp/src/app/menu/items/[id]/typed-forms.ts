/**
 * T-401 S4: the typed forms on /menu/items/[id]. A refused save keeps what was typed, so the record reopens holding it
 * (T-389, lib/keep-typing.ts). Each key is shared by its action (`keepTyping`) and the page (`typedFor`).
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const MENU_ITEM = defineTypedForm({
  form: 'menu.item',
  fields: ['name', 'description', 'categoryId', 'sortOrder', 'status'],
});

export const MENU_OPTION_GROUP = defineTypedForm({
  form: 'menu.optionGroup',
  fields: ['name', 'selectionMode', 'minSelections', 'maxSelections'],
});

export const MENU_OPTION_VALUE = defineTypedForm({
  form: 'menu.optionValue',
  fields: ['name'],
});
