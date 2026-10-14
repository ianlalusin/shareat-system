/**
 * T-401 S4: the one typed form on /menu/requests. A request that is held back for a look-alike (or refused) keeps what the
 * manager typed, so "Send request anyway" and a corrected resubmit need no retyping. The key is shared by the action
 * (`keepTyping`) and the page (`typedFor`), so it cannot drift. Docs: lib/keep-typing.ts, docs/tasks/389-refused-save-keeps-typing.md.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const ITEM_REQUEST = defineTypedForm({
  form: 'menu.itemRequest',
  fields: ['storeId', 'name', 'itemType', 'categoryId', 'note'],
  singleton: true,
});
