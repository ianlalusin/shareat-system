/**
 * T-440 field rules for app/owners: record an owner, the money movements on an owner's page and the monthly close.
 * Existing server sentences are kept verbatim through `requires`.
 */
import { defineFieldRules } from './check';

/** Record an owner. Percentage: above 0 and at most 100 (three decimal places are the domain's own check). */
export const OWNERS_CREATE_RULES = defineFieldRules('owners.createOwner', {
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  personId: { label: 'The person', kind: 'text', requires: 'Choose who this is.' },
  ownershipPercentage: { label: 'The ownership percentage', optional: true, kind: 'number', min: 0.001, max: 100 },
  drawingLimit: { label: 'The drawing limit', optional: true, kind: 'money', min: 0.01 },
});

/**
 * Settle what an owner owes. The administrator PIN is only needed for a write-off (a cross-field fact, Q4: the server decides),
 * so it is optional here: blank passes, a typed one must be 6 digits.
 */
export const OWNERS_SETTLE_RULES = defineFieldRules('owners.settle', {
  how: { label: 'How this is settled', kind: 'text', requires: 'Choose how this is being settled.' },
  amount: { label: 'The amount settled', kind: 'money', min: 0.01 },
  on: { label: 'The date', kind: 'date' },
  adminPin: { label: 'The administrator PIN', optional: true, kind: 'digits', min: 6, max: 6, requires: 'A PIN must be exactly 6 digits.' },
});

/** Capital in. */
export const OWNERS_CONTRIBUTION_RULES = defineFieldRules('owners.contribution', {
  amount: { label: 'The contribution amount', kind: 'money', min: 0.01 },
  intoMoneyAccountId: { label: 'The account', kind: 'text' },
  on: { label: 'The date', kind: 'date' },
});

/** Drawing out. */
export const OWNERS_DRAWING_RULES = defineFieldRules('owners.drawing', {
  amount: { label: 'The drawing amount', kind: 'money', min: 0.01 },
  fromMoneyAccountId: { label: 'The account', kind: 'text' },
  on: { label: 'The date', kind: 'date' },
});

/** The monthly drawings close. A blank agreed amount means "agree with the ledger". */
export const OWNERS_CLOSE_MONTH_RULES = defineFieldRules('owners.closeMonth', {
  acknowledgedAmount: { label: 'The agreed amount', optional: true, kind: 'money', min: 0 },
  on: { label: 'The date', kind: 'date' },
});
