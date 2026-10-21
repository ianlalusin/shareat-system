/**
 * T-440 field rules for app/items. Sentences are the ones the server already speaks (constraint-messages for the item
 * columns, the code-allocation shape sentence), so a refusal reads the same on the screen and after Save.
 */
import { defineFieldRules } from './check';

const NAME_SAYS = 'Give the item a name people will recognise.';
const CODE_SHAPE = 'An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001.';
const UNIT_SAYS = 'Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll.';
const KIND_SAYS = 'Choose what kind of item this is.';
/** A code as the form takes it (case is folded by the server); the 000 number is never issued. */
const CODE_PATTERN = '^[A-Za-z0-9]{4}-(?!000)[0-9]{3}$';

/** Request a new item, or (super-admin) add it directly: both buttons of one form. The code is the optional override. */
export const ITEMS_REQUEST_RULES = defineFieldRules('items.requestItem', {
  name: { label: 'The item name', kind: 'text', requires: NAME_SAYS },
  kind: { label: 'The kind', kind: 'text', requires: KIND_SAYS },
  baseUnit: { label: 'The unit', kind: 'text', requires: UNIT_SAYS },
  code: { label: 'The item code', optional: true, kind: 'pattern', pattern: CODE_PATTERN, patternSays: 'like CHWN-001', requires: CODE_SHAPE },
});

/**
 * Approve a pending request. The unit is always posted by the form, but the server treats an absent unit as "keep the
 * request's own" (T-378 R5), so it is not required here; a blank one posted is still refused by the item_requests CHECK.
 */
export const ITEMS_APPROVE_RULES = defineFieldRules('items.approveItemRequest', {
  code: { label: 'The item code', optional: true, kind: 'pattern', pattern: CODE_PATTERN, patternSays: 'like CHWN-001', requires: CODE_SHAPE },
  baseUnit: { label: 'The unit', optional: true, kind: 'text' },
});

/** Reject a pending request: the note is the requester's only explanation. */
export const ITEMS_REJECT_RULES = defineFieldRules('items.rejectItemRequest', {
  note: { label: 'The note', kind: 'text', requires: 'Say why, so the requester knows what to do instead.' },
});

/** Rename an item (name and code, super-admin). */
export const ITEMS_RENAME_RULES = defineFieldRules('items.renameItem', {
  name: { label: 'The item name', kind: 'text', requires: NAME_SAYS },
  code: { label: 'The item code', kind: 'text', requires: 'Give the item a code.' },
});

/** Change an item's unit (super-admin). */
export const ITEMS_UNIT_RULES = defineFieldRules('items.changeItemUnit', {
  baseUnit: { label: 'The unit', kind: 'text', requires: UNIT_SAYS },
});
