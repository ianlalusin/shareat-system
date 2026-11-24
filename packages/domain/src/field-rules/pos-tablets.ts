/**
 * T-505 field rules for app/admin/pos-tablets: registering a POS v2 tablet. The device id is the uuid the tablet shows
 * (Settings, Terminal, Copy); the domain (`provisionPosTerminalLink`) checks it again and owns the same sentence.
 */
import { defineFieldRules } from './check';

const DEVICE_ID_SHAPE = "That device id is not valid. Copy it from the tablet's Settings page.";
/** A uuid as the tablet shows it (any case; the action lower-cases it). */
const DEVICE_ID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const POS_TABLET_REGISTER_RULES = defineFieldRules('posTablets.register', {
  deviceId: { label: 'The device id', kind: 'pattern', pattern: DEVICE_ID_PATTERN, patternSays: 'like 5561b32b-3c27-42a4-b80a-193f3d0abeda', requires: DEVICE_ID_SHAPE },
  terminalNo: {
    label: 'The terminal number', kind: 'number', integer: true, min: 1, max: 99,
    requires: 'The terminal number must be a whole number from 1 to 99.', rangeSays: 'The terminal number must be a whole number from 1 to 99.',
  },
});

/** T-546: adding a till (`createTerminal` checks the same range again and owns the sentence). */
export const POS_TILL_ADD_RULES = defineFieldRules('posTablets.addTill', {
  terminalNo: {
    label: 'The cash register number', kind: 'number', integer: true, min: 1, max: 99,
    requires: 'The cash register number must be a whole number from 1 to 99.', rangeSays: 'The cash register number must be a whole number from 1 to 99.',
  },
});

/**
 * T-622: adding or changing a named discount (`upsertPosDiscountPreset` checks the same limits again and owns the sentences). The value is a percent (1 to 100)
 * or pesos off each item, so only the amount shape and "above 0" are checked here; "a percent over 100" is the domain's sentence.
 */
export const POS_DISCOUNT_RULES = defineFieldRules('posTablets.discount', {
  name: { label: 'The discount name', kind: 'text', min: 1, max: 40, requires: 'A discount name must be 1 to 40 characters.' },
  value: { label: 'The discount value', kind: 'money', min: 0.01, requires: 'The discount value must be more than 0.', rangeSays: 'The discount value must be more than 0.' },
});

/**
 * T-627, T-634: adding a charge to the org's list (`createChargeOption` checks the same limits again and owns the sentences). The amount is pesos; whether the cashier
 * enters a quantity ("per unit") is a checkbox, not a text rule.
 */
export const POS_CHARGE_RULES = defineFieldRules('posTablets.charge', {
  name: { label: 'The charge name', kind: 'text', min: 1, max: 40, requires: 'A charge name must be 1 to 40 characters.' },
  amount: { label: 'The charge amount', kind: 'money', min: 0.01, max: 100000, requires: 'The charge amount must be more than 0.', rangeSays: 'The charge amount must be more than 0 and at most 100,000.' },
});

/**
 * T-634: changing the amount of a charge on the org's master list (`updateChargeOption` checks the same limit again and owns the sentences). The name is fixed (a
 * rename is retire + add); per unit is a checkbox, not a text rule. Adding one uses `POS_CHARGE_RULES` above.
 */
export const POS_CHARGE_AMOUNT_RULES = defineFieldRules('posTablets.chargeAmount', {
  amount: { label: 'The charge amount', kind: 'money', min: 0.01, max: 100000, requires: 'The charge amount must be more than 0.', rangeSays: 'The charge amount must be more than 0 and at most 100,000.' },
});
