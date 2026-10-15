/**
 * T-401 S4: the typed form on /menu. A refused category save keeps what was typed, so the record reopens holding it
 * (T-389, lib/keep-typing.ts). The key is shared by the action (`keepTyping`) and the page (`typedFor`).
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const MENU_CATEGORY = defineTypedForm({
  form: 'menu.category',
  fields: ['name', 'sortOrder'],
});
