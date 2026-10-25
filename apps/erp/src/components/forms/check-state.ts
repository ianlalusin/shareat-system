/**
 * T-440 - the PURE half of live field checks: the check-state reducer, the context value, the blocked-submit rule, the reset
 * watcher and the per-field line. No React, no DOM objects (only the EventTarget interface), so it is unit-tested in node.
 * Spec: docs/tasks/440-live-field-checks.md section 3.3.
 *
 * ⛔ Nothing here repeats a typed value in a sentence (government numbers are personal data, Audit A5).
 */
import { checkField, ruleApplies, rulesOf, ruleHint, type FieldCheck, type FieldRule, type FieldRuleSetLike } from '@shareat/domain/field-rules';

export interface CheckedFormState {
  /** What each ruled control currently holds, by name. */
  values: Record<string, string>;
  /** Names the user has typed in (or tried to submit past): only these show a failing line. */
  touched: Record<string, true>;
  /** False on the first render (= the server render) and while a record is LOCKED. */
  active: boolean;
  /** T-475: business-rule verdicts by check id (id -> sentence). A blocker turns Save off; a warning never does. */
  blockers?: Readonly<Record<string, string>>;
  warnings?: Readonly<Record<string, string>>;
}

/** What the FIRST render holds, so it equals the server render and a no-JavaScript submit is never blocked. */
export const CHECKED_FORM_INITIAL: CheckedFormState = { values: {}, touched: {}, active: false };

export type CheckedFormEvent =
  /** Re-read every control: values REPLACED, touched cleared, active. On mount, on Edit, and on the form's `reset`. */
  | { type: 'read'; values: Record<string, string> }
  | { type: 'input'; name: string; value: string }
  | { type: 'touch'; names: readonly string[] }
  /** T-475: merge the values of newly watched controls (a business rule's `watch` names) without clearing `touched`. */
  | { type: 'watch'; values: Record<string, string> }
  /** T-475: a business-rule check's verdict. null clears the id; block registers a blocker; warn registers a warning. */
  | { type: 'verdict'; id: string; verdict: null | { level: 'block' | 'warn'; sentence: string } }
  | { type: 'off' };

const NONE: Readonly<Record<string, string>> = Object.freeze({});

function without(map: Readonly<Record<string, string>>, id: string): Readonly<Record<string, string>> {
  if (!(id in map)) return map;
  const { [id]: _gone, ...rest } = map;
  return rest;
}

export function checkedFormReducer(state: CheckedFormState, event: CheckedFormEvent): CheckedFormState {
  switch (event.type) {
    case 'read':
      return { ...state, values: { ...event.values }, touched: {}, active: true };
    case 'input':
      return { ...state, values: { ...state.values, [event.name]: event.value }, touched: { ...state.touched, [event.name]: true } };
    case 'touch': {
      const touched = { ...state.touched };
      for (const n of event.names) touched[n] = true;
      return { ...state, touched };
    }
    case 'watch':
      return { ...state, values: { ...state.values, ...event.values } };
    case 'verdict': {
      const { id, verdict } = event;
      const held = state.blockers ?? NONE;
      const warned = state.warnings ?? NONE;
      if (verdict === null) {
        const blockers = without(held, id);
        const warnings = without(warned, id);
        return blockers === held && warnings === warned ? state : { ...state, blockers, warnings };
      }
      if (verdict.level === 'block') {
        if (held[id] === verdict.sentence && !(id in warned)) return state;
        return { ...state, blockers: { ...held, [id]: verdict.sentence }, warnings: without(warned, id) };
      }
      if (warned[id] === verdict.sentence && !(id in held)) return state;
      return { ...state, warnings: { ...warned, [id]: verdict.sentence }, blockers: without(held, id) };
    }
    case 'off':
      return { ...state, active: false };
  }
}

export interface CheckCtx {
  active: boolean;
  /** Some rule fails: Save is truly `disabled`. */
  blocked: boolean;
  /** "Save is off until: ..." or null when nothing fails. Save's only explanation, so it is shown wherever Save is disabled. */
  summary: string | null;
  /** Names of the failing rules, in rule order. */
  failing: string[];
  /** T-475: business-rule verdicts (check id -> sentence). `blocked` includes blockers; a warning never blocks. */
  blockers: ReadonlyMap<string, string>;
  warnings: ReadonlyMap<string, string>;
  /** T-475: what every ruled or watched control holds (a `<RuleCheck>` judges these). */
  values: Readonly<Record<string, string>>;
  /** T-475: a `<RuleCheck>` reports its verdict here (null clears it). A no-op outside a form that tracks them. */
  setVerdict(id: string, verdict: null | { level: 'block' | 'warn'; sentence: string }): void;
  /** T-475: ask the form to also read these control names. Returns the release. */
  track(names: readonly string[]): () => void;
  result(name: string): FieldCheck | undefined;
  touched(name: string): boolean;
  applies(name: string): boolean;
}

const INACTIVE: CheckCtx = {
  active: false,
  blocked: false,
  summary: null,
  failing: [],
  blockers: new Map(),
  warnings: new Map(),
  values: {},
  setVerdict: () => {},
  track: () => () => {},
  result: () => undefined,
  touched: () => false,
  applies: () => true,
};

export function checkContextValue(set: FieldRuleSetLike, state: CheckedFormState): CheckCtx {
  if (!state.active) return INACTIVE;
  const results = new Map<string, FieldCheck>();
  const failing: string[] = [];
  const requirements: string[] = [];
  const applicable = new Map<string, boolean>();
  for (const rule of rulesOf(set)) {
    const applies = ruleApplies(rule, state.values);
    applicable.set(rule.name, applies);
    const c: FieldCheck = applies ? checkField(rule, state.values[rule.name] ?? '') : { ok: true, value: null };
    results.set(rule.name, c);
    if (!c.ok) {
      failing.push(rule.name);
      requirements.push(c.requirement);
    }
  }
  const rest = requirements.length - 2;
  const blockerSentences = Object.values(state.blockers ?? NONE);
  // Field requirements first (as T-440), then every business-rule blocker: a blocker is never hidden behind "and N more".
  const fieldPart = requirements.length === 0 ? '' : `${requirements.slice(0, 2).join(' ')}${rest > 0 ? ` and ${rest} more` : ''}`;
  const summary =
    failing.length === 0 && blockerSentences.length === 0
      ? null
      : `Save is off until: ${[fieldPart, ...blockerSentences].filter(Boolean).join(' ')}`;
  return {
    active: true,
    blocked: failing.length > 0 || blockerSentences.length > 0,
    summary,
    failing,
    blockers: new Map(Object.entries(state.blockers ?? NONE)),
    warnings: new Map(Object.entries(state.warnings ?? NONE)),
    values: state.values,
    setVerdict: () => {},
    track: () => () => {},
    result: (name) => results.get(name),
    touched: (name) => state.touched[name] === true,
    applies: (name) => applicable.get(name) !== false,
  };
}

/**
 * The submit handler's body. While blocked: no submit, every failing field shows its line, and focus goes to the first one.
 * (With Save truly disabled the browser does not submit on Enter at all; this is the belt for a form with no submit button,
 * or a `requestSubmit()`.)
 */
export function onCheckedSubmit(
  event: { preventDefault(): void },
  ctx: CheckCtx,
  effects: { touch(names: string[]): void; focus(name: string): void },
): boolean {
  if (!ctx.blocked) return false;
  event.preventDefault();
  effects.touch(ctx.failing);
  const first = ctx.failing[0];
  if (first !== undefined) effects.focus(first);
  return true;
}

/**
 * Calls `reread` whenever the form fires `reset`. `reset` fires BEFORE the controls are restored, so by default the re-read is
 * deferred one task. One listener covers Cancel, the registry's `close()` and React 19's automatic reset after a successful
 * action; none of those fires `input` (Audit A4).
 */
export function watchFormReset(
  target: EventTarget,
  reread: () => void,
  defer: (fn: () => void) => void = (fn) => {
    setTimeout(fn, 0);
  },
): () => void {
  const onReset = () => defer(reread);
  target.addEventListener('reset', onReset);
  return () => target.removeEventListener('reset', onReset);
}

export interface FieldCheckLine {
  kind: 'muted' | 'failing' | 'passing';
  text: string;
}

/** Before typing (or with no result): the muted requirement. Touched and failing: the progress words. Touched and passing: "Good". */
export function fieldCheckLine(rule: FieldRule, result: FieldCheck | undefined, touched: boolean, applies = true): FieldCheckLine {
  if (!applies && rule.when) return { kind: 'muted', text: rule.when.says };
  if (!result || !touched) return { kind: 'muted', text: ruleHint(rule) };
  return result.ok ? { kind: 'passing', text: 'Good' } : { kind: 'failing', text: result.progress };
}

export interface AriaCurrent {
  describedby: string | null;
  invalid: string | null;
  ownInvalid: boolean;
}
export interface AriaPlan {
  describedby: string;
  invalid: 'true' | null;
  ownInvalid: boolean;
}

/**
 * What the layout effect writes onto the control. `aria-describedby` is APPENDED to (never replaced, never duplicated).
 * `aria-invalid` is set while failing and removed ONLY if we set it: a server-rendered one (Input's `invalid` channel) is
 * never cleared and never claimed.
 */
export function planFieldAria(current: AriaCurrent, helperId: string, failing: boolean): AriaPlan {
  const ids = (current.describedby ?? '').split(/\s+/).filter(Boolean);
  if (!ids.includes(helperId)) ids.push(helperId);
  const describedby = ids.join(' ');
  const serverInvalid = current.invalid === 'true' && !current.ownInvalid;
  if (failing) {
    return serverInvalid ? { describedby, invalid: 'true', ownInvalid: false } : { describedby, invalid: 'true', ownInvalid: true };
  }
  if (serverInvalid) return { describedby, invalid: 'true', ownInvalid: false };
  return { describedby, invalid: null, ownInvalid: false };
}

export interface ReleasePlan {
  /** What `aria-describedby` becomes: the other ids, in order, our helper id gone; null = remove the attribute. */
  describedby: string | null;
  /** Remove `aria-invalid` (only when we set it ourselves). */
  clearInvalid: boolean;
}

/** The mirror of `planFieldAria`: takes our helper id back off the control, split on whitespace, keeping every other id. */
export function planFieldRelease(current: AriaCurrent, helperId: string): ReleasePlan {
  const rest = (current.describedby ?? '').split(/\s+/).filter((x) => x && x !== helperId);
  return { describedby: rest.length > 0 ? rest.join(' ') : null, clearInvalid: current.ownInvalid };
}
