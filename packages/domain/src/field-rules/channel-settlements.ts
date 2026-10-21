/**
 * T-440 field rules for app/channel-settlements (S6): record a settlement, void one, point a channel at its payout account.
 * The six deduction boxes are templated from data (`name={d.name}`) and stay in the guard's EXEMPT list (S8).
 */
import { defineFieldRules } from './check';

export const CHANNEL_SETTLEMENT_RECORD_RULES = defineFieldRules('channel-settlements.record', {
  grossAmount: { label: 'The gross settled', kind: 'money' },
  netDeposited: { label: 'The net deposited', kind: 'money' },
  loanAmount: { label: 'The amount docked', optional: true, kind: 'money', min: 0 },
  reference: { label: 'The payout reference', optional: true, kind: 'text', max: 120 },
  settledOn: { label: 'The settlement date', kind: 'date' },
});

export const CHANNEL_SETTLEMENT_VOID_RULES = defineFieldRules('channel-settlements.void', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this settlement is being voided — a reversal with no reason is a gap.' },
});

export const CHANNEL_PAYOUT_DESTINATION_RULES = defineFieldRules('channel-settlements.payoutDestination', {
  moneyAccountId: { label: 'The payout account', kind: 'text', requires: 'Choose the account this channel pays into.' },
});
