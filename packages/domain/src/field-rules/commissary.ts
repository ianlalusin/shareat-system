/**
 * T-440 field rules for app/commissary. One set per form family. Quantities and rates are plain non-negative numbers here;
 * the domain parses them to their exact decimal shapes and refuses a zero or too many decimals in its own words.
 * The repeated line rows (itemId / quantity / rate that share a name down a page, and the signed-for quantities) are a
 * repeated line family and stay with S8.
 */
import { defineFieldRules } from './check';

const QUANTITY_SAYS = 'The quantity cannot be negative: use a number of 0 or more, with at most three decimal places.';

/** Link a branch to the commissary (/commissary/catalogue). */
export const COMMISSARY_LINK_RULES = defineFieldRules('commissary.upsertCommissaryLink', {
  branchStoreId: { label: 'The branch', kind: 'text', requires: 'Choose the branch to link.' },
});

/** Offer an item. The row toggles post this action too, carrying the stored item and cost in hidden boxes. */
export const COMMISSARY_OFFERING_RULES = defineFieldRules('commissary.upsertOffering', {
  itemId: { label: 'The item', kind: 'text', requires: 'Choose the item to offer.' },
  manualCost: { label: 'The manual cost', optional: true, kind: 'number', min: 0 },
});

/** Map a commissary item to a branch item. */
export const COMMISSARY_MAP_RULES = defineFieldRules('commissary.upsertMap', {
  commissaryItemId: { label: 'The commissary item', kind: 'text', requires: 'Choose the commissary item.' },
  branchItemId: { label: 'The branch item', kind: 'text', requires: 'Choose the branch item it becomes.' },
});

/** Defer a transit discrepancy. */
export const COMMISSARY_DEFER_RULES = defineFieldRules('commissary.deferDiscrepancy', {
  deferredTo: { label: 'The date to decide by', kind: 'date' },
});

/** Return a counted-over extra: the note says who carried it back and when (the domain's own sentence). */
export const COMMISSARY_RETURN_RULES = defineFieldRules('commissary.returnDiscrepancy', {
  note: {
    label: 'The note',
    kind: 'text',
    requires: 'A return must say what happened — who carried the extra back and when, or that the branch recounted.',
  },
});

/** Draft a new branch order: only the date is a single named box (the item rows share names down the page). */
export const COMMISSARY_ORDER_NEW_RULES = defineFieldRules('commissary.saveBranchOrderDraft', {
  orderDate: { label: 'The order date', kind: 'date' },
});

/** Add a line to a draft (branch) or propose one (commissary). */
export const COMMISSARY_ORDER_LINE_RULES = defineFieldRules('commissary.orderLine', {
  itemId: { label: 'The item', kind: 'text', requires: 'Choose the item.' },
  quantity: { label: 'The quantity', kind: 'number', min: 0, requires: QUANTITY_SAYS },
  rate: { label: 'The rate', optional: true, kind: 'number', min: 0 },
});

/** Change a draft line (branch) or pack a line (commissary). */
export const COMMISSARY_LINE_EDIT_RULES = defineFieldRules('commissary.orderLineEdit', {
  quantity: { label: 'The quantity', kind: 'number', min: 0, requires: QUANTITY_SAYS },
  rate: { label: 'The rate', optional: true, kind: 'number', min: 0 },
});

/** Withdraw, cancel or void an order: the reason is kept on the order. */
export const COMMISSARY_WITHDRAW_RULES = defineFieldRules('commissary.voidTradeOrder', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this order is being withdrawn.' },
});

/** Reject an order: the branch reads the reason. */
export const COMMISSARY_REJECT_RULES = defineFieldRules('commissary.rejectOrder', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why — the branch reads this.' },
});

/** Confirm receipt: the date defaults to today when left blank. */
export const COMMISSARY_RECEIVE_RULES = defineFieldRules('commissary.receiveTradeOrder', {
  receivedOn: { label: 'The received date', optional: true, kind: 'date' },
});
