/**
 * T-440 field rules for app/cash-requests (S6). One set per form: ask, approve, refuse, hand over, close the float.
 * Cross-field checks (returned or short must be given; a shortage needs a reason) stay server refusals (Q4).
 */
import { defineFieldRules } from './check';

export const CASH_REQUEST_CREATE_RULES = defineFieldRules('cash-requests.create', {
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  requestedFor: { label: 'The person holding the money', kind: 'text', requires: 'Say who is holding the money.' },
  purpose: { label: 'The purpose', kind: 'text', requires: 'Say what the money is for.' },
  amount: { label: 'The amount requested', kind: 'money', min: 0.01 },
  on: { label: 'The date', kind: 'date' },
});

export const CASH_REQUEST_APPROVE_RULES = defineFieldRules('cash-requests.approve', {
  amount: { label: 'The approved amount', kind: 'money', min: 0.01 },
});

export const CASH_REQUEST_REFUSE_RULES = defineFieldRules('cash-requests.refuse', {
  reason: { label: 'The reason', kind: 'text', requires: 'A refusal needs a reason.' },
});

export const CASH_REQUEST_RELEASE_RULES = defineFieldRules('cash-requests.release', {
  amount: { label: 'The amount released', kind: 'money', min: 0.01 },
  fromMoneyAccountId: { label: 'The account', kind: 'text', requires: 'Choose the account the cash comes from.' },
  on: { label: 'The date', kind: 'date' },
});

export const CASH_REQUEST_SETTLE_RULES = defineFieldRules('cash-requests.settle', {
  returnedAmount: { label: 'The returned amount', optional: true, kind: 'money' },
  shortAmount: { label: 'The short amount', optional: true, kind: 'money' },
  on: { label: 'The date', kind: 'date' },
});
