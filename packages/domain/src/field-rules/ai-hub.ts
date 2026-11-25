/**
 * T-640 field rules for Settings > AI hub. `saveProviderKey` and `saveAiSettings` check the same limits again (after `authorize`) and own the sentences.
 * ⛔ No sentence here ever repeats what was typed: a key must never be echoed back (the pattern rule's message names the shape, not the value).
 */
import { defineFieldRules } from './check';

/** The provider key as pasted: one unbroken run of 20 to 400 characters. The provider (a hidden field) is judged by the domain against the list in code. */
export const AI_KEY_RULES = defineFieldRules('aiHub.saveKey', {
  key: {
    label: 'The key',
    kind: 'pattern',
    pattern: '^\\S{20,400}$',
    patternSays: 'the whole key from the provider, with no spaces (20 to 400 characters)',
    requires: 'Paste the whole key from the provider, with no spaces in it (20 to 400 characters).',
  },
});

/** The caps and the peso rate. The on/off switch is a two-choice list judged by the domain. */
export const AI_SETTINGS_RULES = defineFieldRules('aiHub.saveSettings', {
  monthlyCapPesos: {
    label: 'The monthly cap',
    kind: 'number',
    integer: true,
    min: 0,
    max: 1000000,
    requires: 'Enter the monthly cap as a whole number of pesos, from 0 to 1,000,000.',
    rangeSays: 'The monthly cap must be a whole number of pesos from 0 to 1,000,000.',
  },
  dailyLimitPerPerson: {
    label: 'The daily limit',
    kind: 'number',
    integer: true,
    min: 0,
    max: 10000,
    requires: 'Enter how many AI questions one person may ask a day, as a whole number from 0 to 10,000.',
    rangeSays: 'The daily limit must be a whole number from 0 to 10,000.',
  },
  pesosPerUsd: {
    label: 'The peso rate',
    kind: 'pattern',
    pattern: '^(?:[1-9][0-9]|[12][0-9]{2}|300)(?:\\.[0-9]{1,2})?$',
    patternSays: 'pesos per US dollar from 10 to 300, such as 58.00',
    requires: 'Enter how many pesos one US dollar costs, from 10 to 300, for example 58.00.',
  },
  warnAtPercent: {
    label: 'The warning level',
    kind: 'number',
    integer: true,
    min: 1,
    max: 100,
    requires: 'Enter the percent of the monthly cap at which to warn, as a whole number from 1 to 100.',
    rangeSays: 'The warning level must be a whole number from 1 to 100.',
  },
});
