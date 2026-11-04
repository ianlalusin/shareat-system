/** T-508 S2a field rules for kitchen stations. The name and the numbers are separate sets because rename and update each send only theirs. */
import { defineFieldRules } from './check';

export const KITCHEN_STATION_NAME_RULES = defineFieldRules('kitchen.stationName', {
  name: { label: 'The station name', kind: 'text', max: 60, requires: 'A kitchen station needs a name of up to 60 characters.' },
});

/** Both optional: blank = leave unchanged (update) or use the default (create: 10 minutes, order 0). */
export const KITCHEN_STATION_SETTINGS_RULES = defineFieldRules('kitchen.stationSettings', {
  slaMinutes: { label: 'Minutes to cook', optional: true, kind: 'number', integer: true, min: 1, max: 240, requires: 'Minutes to cook is a whole number from 1 to 240.' },
  sortOrder: { label: 'Screen order', optional: true, kind: 'number', integer: true, min: 0, max: 9999, requires: 'Screen order is a whole number from 0 to 9999.' },
});
