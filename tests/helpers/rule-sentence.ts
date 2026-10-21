/**
 * rule-sentence.ts - T-440. A refusal's sentence now comes from the field's RULE (`checkField(rule, raw).requirement`), the one
 * definition the screen and the server share. A test that used to hard-code the old sentence asks the rule instead, so the
 * wording cannot drift between the two, and asserts that the sentence never echoes what was typed (a typed value can be personal
 * data; money sentences are `parseMoneyInput`'s own and say "that is not a valid amount" without quoting it).
 */
import { expect } from 'vitest';
import { checkField, type FieldRule } from '@shareat/domain/field-rules';

/** The sentence the rule gives for `raw`. Throws when `raw` actually passes the rule (the test would be wrong). */
export function requirementOf(rule: FieldRule, raw: string | null): string {
  const c = checkField(rule, raw);
  if (c.ok) throw new Error(`rule-sentence: "${rule.name}" accepts that value, so there is no refusal sentence to expect`);
  return c.requirement;
}

/** Assert `actual` is exactly the rule's sentence for `raw`, and (except money) that it does not echo the typed value. */
export function expectRuleSentence(actual: string | null | undefined, rule: FieldRule, raw: string | null): void {
  const wanted = requirementOf(rule, raw);
  expect(actual).toBe(wanted);
  const typed = raw?.trim() ?? '';
  if (typed.length >= 3 && !wanted.includes(typed)) {
    expect(actual ?? '', 'the sentence must not echo the typed value').not.toContain(typed);
  }
}
