/**
 * T-440 field rules for app/cutover. The figure and asset sentences are the ones the opening-balance domain already speaks
 * ("An opening figure has to be greater than zero."); a count of zero is a real answer, so it is allowed.
 */
import { defineFieldRules } from './check';

/** Add an opening figure (/cutover/opening). Which accounts take a party, and which are generated, is the domain's call. */
export const CUTOVER_FIGURE_RULES = defineFieldRules('cutover.addOpeningFigure', {
  accountCode: { label: 'The account', kind: 'text', requires: 'Choose the account.' },
  storeId: { label: 'The store', kind: 'text', requires: 'Choose the store.' },
  direction: { label: 'Owns or owes', kind: 'text', requires: 'Choose whether the business has this or owes it.' },
  amount: { label: 'This amount', kind: 'money', min: 0.01 },
});

/** Value one pending asset at book value. */
export const CUTOVER_ASSET_RULES = defineFieldRules('cutover.valueOpeningAsset', {
  bookValue: { label: 'The book value', kind: 'money', min: 0.01 },
  remainingLifeMonths: {
    label: 'The remaining life',
    kind: 'number',
    integer: true,
    min: 1,
    max: 600,
    requires: 'The remaining life has to be a whole number of months, from 1 to 600.',
  },
  salvageValue: { label: 'The salvage value', optional: true, kind: 'money', min: 0 },
});

/** One opening count row. A blank cost is allowed (the cost source stays empty); a zero count is a real answer. */
export const CUTOVER_COUNT_RULES = defineFieldRules('cutover.recordOpeningCount', {
  quantity: { label: 'The count', kind: 'number', min: 0, requires: 'A count cannot be negative: use a number of 0 or more, with at most three decimal places.' },
  unitCost: { label: 'The cost per unit', optional: true, kind: 'number', min: 0 },
});
