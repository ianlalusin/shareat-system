/**
 * T-440 field rules for app/money-transfers (S6): record a transfer, settle between stores, reverse a transfer.
 * The From/To pair is drawn by the shared two-way picker (names arrive as props) and stays out of the set.
 */
import { defineFieldRules } from './check';

export const TRANSFER_RECORD_RULES = defineFieldRules('money-transfers.record', {
  amountOut: { label: 'The amount that left', kind: 'money', min: 0.01 },
  amountIn: { label: 'The amount that arrived', optional: true, kind: 'money', min: 0.01 },
  transferDate: { label: 'The transfer date', kind: 'date' },
  reference: { label: 'The reference', optional: true, kind: 'text', max: 120 },
});

export const TRANSFER_SETTLE_RULES = defineFieldRules('money-transfers.settle', {
  fromMoneyAccountId: { label: "The paying store's account", kind: 'text', requires: "Choose the paying store's account." },
  toMoneyAccountId: { label: "The receiving store's account", kind: 'text', requires: "Choose the receiving store's account." },
  amountOut: { label: 'The amount that left', kind: 'money', min: 0.01 },
  amountIn: { label: 'The amount that arrived', optional: true, kind: 'money', min: 0.01 },
  transferDate: { label: 'The transfer date', kind: 'date' },
  reference: { label: 'The reference', optional: true, kind: 'text', max: 120 },
});

export const TRANSFER_VOID_RULES = defineFieldRules('money-transfers.void', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this transfer is being reversed - a reversal with no reason is a gap.' },
});
