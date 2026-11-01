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
