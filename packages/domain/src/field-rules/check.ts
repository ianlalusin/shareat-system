/**
 * T-440 - the field-rule module (docs/tasks/440-live-field-checks.md section 3.1). ONE definition of "what this field needs",
 * read by the screen (a live helper line) and by the server (the refusal sentence), so the two cannot drift.
 *
 * ⛔ A CLIENT-SAFE LEAF. A `'use client'` file imports this through `@shareat/domain/field-rules`, so it may import only
 * `./*`, `../shared/money-input` (the one money parser, DEF-272), `@shareat/core/datetime` (Manila dates) and
 * `@shareat/core/money`. No `@shareat/db`, no `refuse` (Audit A1: the server half is `shared/field-rules-assert.ts`).
 *
 * Rules are plain DATA (a regex is a pattern SOURCE string), so a rule set crosses the server-to-client prop boundary.
 * ⛔ No sentence here ever interpolates the typed value (government numbers are personal data, Audit A5); the one exception
 * is money, whose sentence is `parseMoneyInput`'s own.
 */
import { parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import { compare, money as exactMoney } from '@shareat/core/money';
import { parseDecimalInput, parseMoneyInput } from '../shared/money-input';

export type FieldKind = 'text' | 'digits' | 'pattern' | 'number' | 'money' | 'date';

export interface FieldRule {
  /** The control's `name` attribute, and the server input key. Filled in by `defineFieldRules` from the key. */
  readonly name: string;
  /** The sentence subject, in the wording the server uses ("The SSS number"). */
  readonly label: string;
  /** A blank passes (and is stored as null). Otherwise a blank is "Required". */
  readonly optional?: true;
  /** Judge only these controlling values; a missing controller fails closed. */
  readonly when?: { readonly field: string; readonly equals: readonly string[]; readonly says: string };
  readonly kind: FieldKind;
  /** Length for text/digits; value for number/money. */
  readonly min?: number;
  readonly max?: number;
  /** number: whole numbers only. */
  readonly integer?: true;
  /** digits: what is removed before checking AND before storing. */
  readonly strip?: 'spaces-dashes';
  /** pattern: a RegExp SOURCE (a string, so the rule is serialisable) and the plain words for it ("letters and digits"). */
  readonly pattern?: string;
  readonly patternSays?: string;
  /** date: judged against the Manila business date, never the browser's. */
  readonly notAfterToday?: true;
  readonly notBeforeToday?: true;
  /** One full sentence that replaces every generated requirement of this rule (an existing server sentence kept verbatim). */
  readonly requires?: string;
}

export type FieldRuleDef = Omit<FieldRule, 'name'>;
/** What a rule set looks like to a consumer that does not need the key names. */
export type FieldRuleSetLike = { readonly form: string };
export type FieldRuleSet<K extends string = string> = { readonly form: string } & { readonly [P in K]: FieldRule };

export type FieldCheck =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly requirement: string; readonly progress: string };

export type FieldInput = FormData | Record<string, unknown>;

/** A frozen set: `set.form`, and each rule reachable as `set[key]` with `rule.name === key`. */
export function defineFieldRules<R extends Record<string, FieldRuleDef>>(form: string, rules: R): FieldRuleSet<Extract<keyof R, string>> {
  const out: Record<string, unknown> = { form };
  for (const [name, def] of Object.entries(rules)) {
    if (name === 'form') throw new Error(`defineFieldRules(${form}): a rule cannot be named "form"`);
    if (def.when && (def.when.field === name || def.when.equals.length === 0)) {
      throw new Error(`defineFieldRules(${form}): invalid condition for ${name}`);
    }
    out[name] = Object.freeze({ ...def, name, ...(def.when ? { when: Object.freeze({ ...def.when, equals: Object.freeze([...def.when.equals]) }) } : {}) });
  }
  return Object.freeze(out) as FieldRuleSet<Extract<keyof R, string>>;
}

/** The rules of a set, in definition order. */
export function rulesOf(set: FieldRuleSetLike): FieldRule[] {
  return Object.values(set as Record<string, unknown>).filter(
    (v): v is FieldRule => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string',
  );
}

/** Include unruled sibling controls so input/change/reset all update applicability. */
export function ruleInputNames(set: FieldRuleSetLike): string[] {
  return [...new Set(rulesOf(set).flatMap((rule) => rule.when ? [rule.name, rule.when.field] : [rule.name]))];
}

export function ruleApplies(rule: FieldRule, input: FieldInput): boolean {
  if (!rule.when) return true;
  const present = typeof FormData !== 'undefined' && input instanceof FormData
    ? input.has(rule.when.field)
    : Object.prototype.hasOwnProperty.call(input, rule.when.field);
  if (!present) return true;
  return rule.when.equals.includes((rawOf(input, rule.when.field) ?? '').trim());
}

/** Relational comparison on plain numbers (the numeric-write guard judges the operands of an inline `<` that came from a string). */
const lt = (a: number, b: number): boolean => a < b;
/** "2026-10-18" -> 20261018, so two business dates compare as numbers. */
const ymdNumber = (d: string): number => Number(d.replace(/-/g, ''));

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** "2026-10-18" -> "18 Oct 2026" (no Intl: the leaf's output must be identical on the server and in every browser). */
function humanYmd(d: string): string {
  const [y, m, day] = d.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

function lengthSentence(rule: FieldRule, noun: 'digit' | 'character'): string {
  const { label, min, max } = rule;
  if (min !== undefined && max !== undefined) {
    if (min === max) return `${label} must be ${plural(min, noun)}.`;
    if (min > 1 || noun === 'digit') return `${label} must be ${min} to ${plural(max, noun)}.`;
    return `${label} must be at most ${plural(max, noun)}.`;
  }
  if (max !== undefined) return `${label} must be at most ${plural(max, noun)}.`;
  if (min !== undefined && min > 1) return `${label} must be at least ${plural(min, noun)}.`;
  return noun === 'digit' ? `${label} must be digits only.` : `${label} is required.`;
}

function rangeWords(rule: FieldRule): string | null {
  const { min, max } = rule;
  if (min !== undefined && max !== undefined) return `from ${min} to ${max}`;
  if (min !== undefined) return `of ${min} or more`;
  if (max !== undefined) return `of ${max} or less`;
  return null;
}

function numberSentence(rule: FieldRule): string {
  const what = rule.integer ? 'a whole number' : 'a number';
  const range = rangeWords(rule);
  return `${rule.label} must be ${what}${range ? ` ${range}` : ''}.`;
}
function numberRangeProgress(rule: FieldRule): string {
  const { min, max } = rule;
  if (min !== undefined && max !== undefined) return `Must be ${min} to ${max}`;
  if (min !== undefined) return `Must be ${min} or more`;
  return `Must be ${max} or less`;
}

function moneyBlankSentence(rule: FieldRule): string {
  try {
    parseDecimalInput('', '14,2', rule.name, rule.label, { blank: 'refuse' });
  } catch (e) {
    const m = (e as { userMessage?: string }).userMessage;
    if (m) return m;
  }
  return `${rule.label} is required.`;
}

/** The one full sentence for a BLANK required field. */
function blankSentence(rule: FieldRule): string {
  if (rule.requires) return rule.requires;
  return rule.kind === 'money' ? moneyBlankSentence(rule) : `${rule.label} is required.`;
}

function bad(rule: FieldRule, requirement: string, progress: string): FieldCheck {
  return { ok: false, requirement: rule.requires ?? requirement, progress };
}

/** Checks one raw value against one rule. `raw` may be null/undefined (= blank). Pure; never interpolates the value. */
export function checkField(rule: FieldRule, raw: string | null | undefined): FieldCheck {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    throw new TypeError(`field-rules: ${rule.name} was given a ${typeof raw}, not a string`);
  }
  let v = (raw ?? '').trim();
  if (rule.kind === 'digits' && rule.strip === 'spaces-dashes') v = v.replace(/[\s-]/g, '');
  if (v === '') {
    return rule.optional ? { ok: true, value: null } : { ok: false, requirement: blankSentence(rule), progress: 'Required' };
  }
  switch (rule.kind) {
    case 'text': {
      const { min, max } = rule;
      if (min !== undefined && v.length < min) {
        const n = min - v.length;
        return bad(rule, lengthSentence(rule, 'character'), `${n} more ${n === 1 ? 'character' : 'characters'} needed`);
      }
      if (max !== undefined && v.length > max) {
        return bad(rule, lengthSentence(rule, 'character'), `${plural(v.length - max, 'character')} too long`);
      }
      return { ok: true, value: v };
    }
    case 'digits': {
      const sentence = lengthSentence(rule, 'digit');
      if (!/^\d+$/.test(v)) return bad(rule, sentence, 'Digits only');
      const { min, max } = rule;
      if (min !== undefined && v.length < min) {
        const n = min - v.length;
        return bad(rule, sentence, `${n} more ${n === 1 ? 'digit' : 'digits'} needed`);
      }
      if (max !== undefined && v.length > max) {
        const n = v.length - max;
        return bad(rule, sentence, `${n} ${n === 1 ? 'digit' : 'digits'} too many`);
      }
      return { ok: true, value: v };
    }
    case 'number': {
      if (!(rule.integer ? /^-?\d+$/.test(v) : /^-?\d+(\.\d+)?$/.test(v))) {
        return bad(rule, numberSentence(rule), rule.integer ? 'Whole numbers only' : 'Numbers only');
      }
      const n = Number(v);
      // "-0" / "-00" read as zero but are a minus sign in front of nothing: not a number of days (or anything else).
      if (Object.is(n, -0) || (rule.min !== undefined && lt(n, rule.min)) || (rule.max !== undefined && lt(rule.max, n))) {
        return bad(rule, numberSentence(rule), Object.is(n, -0) && rule.min === undefined ? 'Numbers only' : numberRangeProgress(rule));
      }
      return { ok: true, value: v };
    }
    case 'money': {
      let money: string;
      try {
        money = String(parseMoneyInput(v, rule.name, rule.label));
      } catch (e) {
        // parseMoneyInput's sentence quotes the figure ("12abc" is not a valid amount); the screen never repeats what was typed.
        const said = (e as { userMessage?: string }).userMessage;
        const text = said ? said.split(`"${v}"`).join('that') : `${rule.label} must be an amount like 1250.00.`;
        return bad(rule, text, 'Enter an amount like 1250.00');
      }
      const amount = exactMoney(money);
      if ((rule.min !== undefined && compare(amount, exactMoney(String(rule.min))) < 0) ||
          (rule.max !== undefined && compare(amount, exactMoney(String(rule.max))) > 0)) {
        return bad(rule, `${rule.label} must be an amount ${rangeWords(rule)}.`, numberRangeProgress(rule));
      }
      return { ok: true, value: money };
    }
    case 'date': {
      let d: string;
      try {
        d = parseBusinessDate(v);
      } catch {
        return bad(rule, `${rule.label} must be a real date.`, 'Use a real date (YYYY-MM-DD)');
      }
      const today = toBusinessDate();
      if (rule.notAfterToday && lt(ymdNumber(today), ymdNumber(d))) return bad(rule, `${rule.label} can't be after today.`, `Can't be after today (${humanYmd(today)})`);
      if (rule.notBeforeToday && lt(ymdNumber(d), ymdNumber(today))) return bad(rule, `${rule.label} can't be before today.`, `Can't be before today (${humanYmd(today)})`);
      return { ok: true, value: d };
    }
    case 'pattern': {
      const says = rule.patternSays ?? 'in the expected format';
      if (!new RegExp(rule.pattern ?? '').test(v)) return bad(rule, `${rule.label} must be ${says}.`, `Use ${says}`);
      return { ok: true, value: v };
    }
  }
}

/** The line shown BEFORE anything is typed: "Required - 10 digits". */
export function ruleHint(rule: FieldRule): string {
  const head = rule.optional ? 'Optional' : 'Required';
  const { min, max } = rule;
  let detail = '';
  if (rule.kind === 'digits' || rule.kind === 'text') {
    const noun = rule.kind === 'digits' ? 'digit' : 'character';
    if (min !== undefined && max !== undefined && min === max) detail = plural(min, noun);
    else if (min !== undefined && min > 1 && max !== undefined) detail = `${min} to ${plural(max, noun)}`;
    else if (max !== undefined) detail = `up to ${plural(max, noun)}`;
    else if (min !== undefined && min > 1) detail = `at least ${plural(min, noun)}`;
    else if (rule.kind === 'digits') detail = 'digits only';
  } else if (rule.kind === 'number') {
    const range = rangeWords(rule);
    detail = `${rule.integer ? 'whole number' : 'number'}${range ? ` ${range}` : ''}`;
  } else if (rule.kind === 'money') {
    detail = 'an amount like 1250.00';
  } else if (rule.kind === 'date') {
    detail = rule.notAfterToday ? 'not after today' : rule.notBeforeToday ? 'not before today' : 'a date';
  } else if (rule.kind === 'pattern' && rule.patternSays) {
    detail = rule.patternSays;
  }
  return detail ? `${head} - ${detail}` : head;
}

export interface NativeAttrs {
  name: string;
  required?: true;
  maxLength?: number;
  inputMode?: 'numeric' | 'decimal';
}

/**
 * The HTML attributes that are EXACT equivalents of the rule (spec 3.4), so a browser without scripts still blocks the obvious
 * mistake and is never stricter than the server. Deliberately no `pattern`, `min`, `max`: the browser's reading of those
 * differs from ours (a dashed SSS number, a Manila "today") and would block input the server accepts.
 */
export function nativeAttrs(rule: FieldRule): NativeAttrs {
  const out: NativeAttrs = { name: rule.name };
  if (rule.optional !== true && !rule.when) out.required = true;
  if (rule.kind === 'text' && rule.strip === undefined && rule.max !== undefined) out.maxLength = rule.max;
  if (rule.kind === 'digits' || (rule.kind === 'number' && rule.integer === true)) out.inputMode = 'numeric';
  else if (rule.kind === 'money' || rule.kind === 'number') out.inputMode = 'decimal';
  return out;
}

function rawOf(input: FieldInput, name: string): string | null | undefined {
  const v: unknown =
    typeof FormData !== 'undefined' && input instanceof FormData ? input.get(name) : (input as Record<string, unknown>)[name];
  if (v === null || v === undefined || typeof v === 'string') return v;
  throw new TypeError(`field-rules: ${name} was given a ${typeof v}, not a string`);
}

export type RuleFailure = { readonly rule: FieldRule; readonly requirement: string; readonly progress: string };
export type CheckAll =
  | { readonly ok: true; readonly values: Record<string, string | null> }
  | ({ readonly ok: false } & RuleFailure);

/** Every rule of the set against the input, in definition order; stops at the first failure. An absent key is blank. */
export function checkAll(set: FieldRuleSetLike, input: FieldInput): CheckAll {
  const values: Record<string, string | null> = {};
  for (const rule of rulesOf(set)) {
    if (!ruleApplies(rule, input)) {
      values[rule.name] = null;
      continue;
    }
    const c = checkField(rule, rawOf(input, rule.name));
    if (!c.ok) return { ok: false, rule, requirement: c.requirement, progress: c.progress };
    values[rule.name] = c.value;
  }
  return { ok: true, values };
}
