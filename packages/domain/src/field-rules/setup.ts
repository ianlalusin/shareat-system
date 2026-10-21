/** T-440 field rules for app/setup: the first-run form (`/setup`). The PIN keeps the sentence `bootstrapOrganization` speaks. */
import { defineFieldRules } from './check';

export const SETUP_FIRST_RUN_RULES = defineFieldRules('setup.createFirstRun', {
  code: { label: 'The organisation code', kind: 'text' },
  name: { label: 'The organisation name', kind: 'text' },
  adminDisplayName: { label: 'Your name', kind: 'text' },
  storeCode: { label: 'The first store code', kind: 'text' },
  storeName: { label: 'The first store name', kind: 'text' },
  pin: { label: 'The PIN', kind: 'digits', min: 6, max: 6, requires: 'The PIN must be exactly 6 digits.' },
});
