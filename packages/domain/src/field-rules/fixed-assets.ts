/**
 * T-440 field rules for app/fixed-assets (S6): add an asset, edit its depreciation terms, correct its in-service date (and the
 * confirm step of that), and dispose of it. Cross-field checks (salvage below cost, a disposal before the acquisition) stay
 * server refusals (Q4).
 */
import { defineFieldRules } from './check';

/** The ceiling the domain applies (capitalize.ts MAX_USEFUL_LIFE_MONTHS); kept here as data so the screen can say it. */
const MAX_LIFE = 1200;

export const ASSET_CREATE_RULES = defineFieldRules('fixed-assets.create', {
  name: { label: 'The asset name', kind: 'text', max: 200, requires: 'Give the asset a name (up to 200 characters).' },
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  category: { label: 'The category', kind: 'text', requires: 'Choose an asset category from the list.' },
  acquiredOn: { label: 'The acquisition date', kind: 'date', notAfterToday: true },
  inServiceOn: { label: 'The specific in-service date', optional: true, kind: 'date' },
  cost: { label: "The asset's cost", kind: 'money', min: 0.01 },
  salvageValue: { label: 'The salvage value', optional: true, kind: 'money', min: 0 },
  usefulLifeMonths: { label: 'The useful life', optional: true, kind: 'number', integer: true, min: 1, max: MAX_LIFE },
});

export const ASSET_TERMS_RULES = defineFieldRules('fixed-assets.terms', {
  name: { label: 'The asset name', kind: 'text', max: 200, requires: 'Give the asset a name (up to 200 characters).' },
  usefulLifeMonths: { label: 'The useful life', kind: 'number', integer: true, min: 1, max: MAX_LIFE },
  salvageValue: { label: 'The salvage value', optional: true, kind: 'money', min: 0 },
});

export const ASSET_IN_SERVICE_RULES = defineFieldRules('fixed-assets.inService', {
  inServiceOn: { label: 'The specific date', optional: true, kind: 'date' },
  reason: { label: 'The reason', kind: 'text', requires: 'A reason is required - an audit trail with no reason is unauditable.' },
});

export const ASSET_IN_SERVICE_CONFIRM_RULES = defineFieldRules('fixed-assets.inServiceConfirm', {
  reason: { label: 'The reason', kind: 'text', requires: 'A reason is required - an audit trail with no reason is unauditable.' },
});

export const ASSET_DISPOSE_RULES = defineFieldRules('fixed-assets.dispose', {
  disposedOn: { label: 'The disposal date', kind: 'date', notAfterToday: true },
  reason: { label: 'The reason', kind: 'text', requires: 'A reason is required - a write-off with no reason is unauditable.' },
});
