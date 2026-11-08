/**
 * T-440 field rules for app/channel-settlements (S6): record a settlement, void one, point a channel at its payout account.
 * The six deduction boxes are templated from data (`name={d.name}`) and stay in the guard's EXEMPT list (S8).
 */
import { defineFieldRules } from './check';

/** The longest payout reference a settlement keeps (a Grab settlement id, a Foodpanda invoice number); the staged-day mapping cuts to it. */
export const CHANNEL_SETTLEMENT_REFERENCE_MAX = 120;

export const CHANNEL_SETTLEMENT_RECORD_RULES = defineFieldRules('channel-settlements.record', {
  grossAmount: { label: 'The gross settled', kind: 'money' },
  netDeposited: { label: 'The net deposited', kind: 'money' },
  loanAmount: { label: 'The amount docked', optional: true, kind: 'money', min: 0 },
  reference: { label: 'The payout reference', optional: true, kind: 'text', max: CHANNEL_SETTLEMENT_REFERENCE_MAX },
  settledOn: { label: 'The settlement date', kind: 'date' },
});

export const CHANNEL_SETTLEMENT_VOID_RULES = defineFieldRules('channel-settlements.void', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this settlement is being voided — a reversal with no reason is a gap.' },
});

export const CHANNEL_PAYOUT_DESTINATION_RULES = defineFieldRules('channel-settlements.payoutDestination', {
  moneyAccountId: { label: 'The payout account', kind: 'text', requires: 'Choose the account this channel pays into.' },
});

/**
 * T-511 S6a: the reason a person gives when they accept a difference between the payout and the day, past tolerance, either sign (it replaces the old gain tick).
 * Stored trimmed in channel_settlements.difference_reason; the cap is the reject-day reason's.
 */
export const SETTLEMENT_DIFFERENCE_REASON_MAX = 500;
export const SETTLEMENT_DIFFERENCE_RULES = defineFieldRules('channel-settlements.difference', {
  reason: {
    label: 'The reason',
    kind: 'text',
    plainText: true,
    max: SETTLEMENT_DIFFERENCE_REASON_MAX,
    requires: `Say why you accept this difference. The reason can be up to ${SETTLEMENT_DIFFERENCE_REASON_MAX} characters.`,
  },
});

/** T-511 S5b: rejecting one staged settlement day. The reason is kept with the decision. */
export const SETTLEMENT_DAY_REJECT_REASON_MAX = 500;
export const SETTLEMENT_DAY_REJECT_RULES = defineFieldRules('channel-settlements.rejectDay', {
  reason: { label: 'The reason', kind: 'text', plainText: true, max: SETTLEMENT_DAY_REJECT_REASON_MAX, requires: 'A rejection needs a reason. Say what is wrong with this day.' },
});

/** T-511 S6b: the reason kept with a platform sales correction (row and journal memo). Same plain-text rules and cap as the other settlement reasons. */
export const PLATFORM_CORRECTION_REASON_MAX = 500;
export const PLATFORM_CORRECTION_RULES = defineFieldRules('channel-settlements.platformCorrection', {
  reason: {
    label: 'The reason',
    kind: 'text',
    plainText: true,
    max: PLATFORM_CORRECTION_REASON_MAX,
    requires: `Say why the correction is needed. The reason can be up to ${PLATFORM_CORRECTION_REASON_MAX} characters.`,
  },
});
