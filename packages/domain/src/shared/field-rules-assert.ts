/**
 * T-440 - the SERVER half of the field rules (Audit A1). The pure rule module is the client-safe leaf
 * `../field-rules`; this file adds `refuse`, which lives in `@shareat/db`, so it must never be reachable from a `'use client'`
 * file. Exported from the `@shareat/domain` barrel only.
 *
 * ⛔ The raw diagnostic is `<form>.<name>: <kind> check failed` and NEVER contains the typed value (government numbers are
 * personal data, Audit A5). The sentence the caller shows is the rule's `requirement`, the very line the screen shows.
 *
 * Audit A6: call this in a domain function ONLY if every caller of it is an ERP action. A domain function that import/replay/
 * sync code also calls takes the call in the ACTION instead, so a new refusal can never break the replay of v1 data.
 */
import { checkAll, type FieldInput, type FieldRuleSetLike } from '../field-rules';
import { internalFault, refuse } from './refusal';

/**
 * Checks every rule of the set against `input` (a FormData or a plain object; an absent key is blank). Throws a `RefusalError`
 * for the FIRST failing rule in definition order; otherwise returns the NORMALISED value of every rule (trimmed, stripped,
 * blank = null), which is what the caller must store. A non-string value (a File) is an internal fault, not a refusal.
 */
export function assertFieldRules(set: FieldRuleSetLike, input: FieldInput): Record<string, string | null> {
  let result;
  try {
    result = checkAll(set, input);
  } catch (e) {
    if (e instanceof TypeError) throw internalFault(`${set.form}: ${e.message}`);
    throw e;
  }
  if (!result.ok) throw refuse(`${set.form}.${result.rule.name}: ${result.rule.kind} check failed`, result.requirement);
  return result.values;
}
