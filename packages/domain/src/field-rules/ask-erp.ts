/**
 * T-641 field rule for the Ask ERP question box. `askErp` checks the same limits again (after `authorize`) and owns the sentences; the panel shows the very same line live.
 * The sentence never repeats what was typed.
 */
import { defineFieldRules } from './check';

/** One question: 1 to 500 characters (v1's number). Plain typed words: control characters are refused. */
export const ASK_ERP_RULES = defineFieldRules('askErp.ask', {
  question: { label: 'The question', kind: 'text', min: 1, max: 500, plainText: true, requires: 'Type a question of 1 to 500 characters.' },
});
