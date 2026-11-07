/**
 * T-389 (DEF-617): the business-rule form keeps what was typed after a refused save. Not a `'use server'` file, so the page and the
 * action import one definition. Only user-editable controls: never the rule's key. The record is the rule's key.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const BUSINESS_RULE_EDIT = defineTypedForm({
  form: 'settings.businessRule',
  fields: ['value', 'effectiveFrom', 'reason'],
});

/** The flash only carries record ids of letters, digits, `_` `:` `-`; a rule key has dots (`settlement.variance_percent`), so the screen and the action both map dots to `:`. */
export const ruleRecordId = (key: string): string => key.replace(/\./g, ':');
