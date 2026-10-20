/**
 * T-440 field rules for app/menu. The name sentences are `requireName`'s own ("A category needs a name."); the whole-number
 * sentences are `wholeNumber`'s ("The sort order must be a whole number."). Every figure is optional here because the menu
 * forms mean "a blank box is not sent" and the mode-dependent ones (prices, depletion) are judged by the domain.
 */
import { defineFieldRules } from './check';

/** Add a category (/menu) and edit one (EditableRecord): the same two boxes. */
export const MENU_CATEGORY_RULES = defineFieldRules('menu.category', {
  name: { label: 'The category name', kind: 'text', requires: 'A category needs a name.' },
  sortOrder: { label: 'The sort order', optional: true, kind: 'number', integer: true },
});

/** Add an item (/menu, super-admin). */
export const MENU_ITEM_ADD_RULES = defineFieldRules('menu.createItem', {
  categoryId: { label: 'The category', kind: 'text', requires: 'Choose a category for the item.' },
  name: { label: 'The item name', kind: 'text', requires: 'An item needs a name.' },
});

/** Edit an item's details (/menu/items/[id]). */
export const MENU_ITEM_EDIT_RULES = defineFieldRules('menu.item', {
  name: { label: 'The item name', kind: 'text', requires: 'An item needs a name.' },
  sortOrder: { label: 'The sort order', optional: true, kind: 'number', integer: true },
});

/** What a sale uses up. The quantity is only needed in "a stock item" mode; the domain decides, and parses six decimals. */
export const MENU_DEPLETION_RULES = defineFieldRules('menu.setDepletionRule', {
  quantityPerSale: { label: 'The quantity per sale', optional: true, kind: 'number', min: 0 },
});

/** Add a variant. */
export const MENU_VARIANT_RULES = defineFieldRules('menu.addVariant', {
  label: { label: 'The variant name', kind: 'text', requires: 'A variant needs a name.' },
});

/** Add or rename an option value. */
export const MENU_OPTION_VALUE_RULES = defineFieldRules('menu.optionValue', {
  name: { label: 'The option name', kind: 'text', requires: 'An option needs a name.' },
});

/** Add or edit an option group. */
export const MENU_OPTION_GROUP_RULES = defineFieldRules('menu.optionGroup', {
  name: { label: 'The group name', kind: 'text', requires: 'An option group needs a name.' },
  minSelections: { label: 'The minimum', optional: true, kind: 'number', integer: true },
  maxSelections: { label: 'The maximum', optional: true, kind: 'number', integer: true },
});

/** Set a price (/menu/prices). Which figures apply depends on the channel and the item type, so all are optional here. */
export const MENU_PRICE_RULES = defineFieldRules('menu.setPrice', {
  amount: { label: 'The price', optional: true, kind: 'money', min: 0 },
  markupPercent: { label: 'The percent over', optional: true, kind: 'number' },
  fixedMarkupAmount: { label: 'The pesos over', optional: true, kind: 'money' },
  bundleHeads: { label: 'The number of guests in a bundle', optional: true, kind: 'number', integer: true, min: 1 },
  extraHeadAmount: { label: 'The price for each extra guest', optional: true, kind: 'money', min: 0 },
});

/** Set an option's price change. A blank is allowed because the Withdraw button posts this form too. */
export const MENU_OPTION_PRICE_RULES = defineFieldRules('menu.setOptionPrice', {
  priceDelta: { label: 'The price change', optional: true, kind: 'money' },
});

/** Ask for a new menu item (/menu/requests). */
export const MENU_REQUEST_RULES = defineFieldRules('menu.requestMenuItem', {
  name: { label: 'The item name', kind: 'text', requires: 'The item needs a name.' },
});

/** Reject a request: the reason goes back to the requester. */
export const MENU_REQUEST_REJECT_RULES = defineFieldRules('menu.rejectMenuItemRequest', {
  note: { label: 'The reason', kind: 'text', requires: 'Say why the request is rejected, so the requester knows.' },
});
