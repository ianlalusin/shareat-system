/**
 * T-440 - the PURE half of live field checks: the check-state reducer, the context value, the blocked-submit rule, the reset
 * watcher and the per-field line. No React, no DOM objects (only the EventTarget interface), so it is unit-tested in node.
 * Spec: docs/tasks/440-live-field-checks.md section 3.3.
 *
 * ⛔ Nothing here repeats a typed value in a sentence (government numbers are personal data, Audit A5).
 */
import { checkField, rulesOf, ruleHint, type FieldCheck, type FieldRule, type FieldRuleSetLike } from '@shareat/domain/field-rules';

export interface CheckedFormState {
  /** What each ruled control currently holds, by name. */
  values: Record<string, string>;
  /** Names the user has typed in (or tried to submit past): only these show a failing line. */
  touched: Record<string, true>;
  /** False on the first render (= the server render) and while a record is LOCKED. */
  active: boolean;
}

/** What the FIRST render holds, so it equals the server render and a no-JavaScript submit is never blocked. */
export const CHECKED_FORM_INITIAL: CheckedFormState = { values: {}, touched: {}, active: false };

export type CheckedFormEvent =
  /** Re-read every control: values REPLACED, touched cleared, active. On mount, on Edit, and on the form's `reset`. */
  | { type: 'read'; values: Record<string, string> }
  | { type: 'input'; name: string; value: string }
  | { type: 'touch'; names: readonly string[] }
  | { type: 'off' };

export function checkedFormReducer(state: CheckedFormState, event: CheckedFormEvent): CheckedFormState {
  switch (event.type) {
    case 'read':
      return { values: { ...event.values }, touched: {}, active: true };
    case 'input':
      return { values: { ...state.values, [event.name]: event.value }, touched: { ...state.touched, [event.name]: true }, active: state.active };
    case 'touch': {
      const touched = { ...state.touched };
      for (const n of event.names) touched[n] = true;
      return { ...state, touched };
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
  result(name: string): FieldCheck | undefined;
  touched(name: string): boolean;
}

const INACTIVE: CheckCtx = {
  active: false,
  blocked: false,
  summary: null,
  failing: [],
  result: () => undefined,
  touched: () => false,
};

export function checkContextValue(set: FieldRuleSetLike, state: CheckedFormState): CheckCtx {
  if (!state.active) return INACTIVE;
  const results = new Map<string, FieldCheck>();
  const failing: string[] = [];
  const requirements: string[] = [];
  for (const rule of rulesOf(set)) {
    const c = checkField(rule, state.values[rule.name] ?? '');
    results.set(rule.name, c);
    if (!c.ok) {
      failing.push(rule.name);
      requirements.push(c.requirement);
    }
  }
  const rest = requirements.length - 2;
  const summary =
    failing.length === 0 ? null : `Save is off until: ${requirements.slice(0, 2).join(' ')}${rest > 0 ? ` and ${rest} more` : ''}`;
  return {
    active: true,
    blocked: failing.length > 0,
    summary,
    failing,
    result: (name) => results.get(name),
    touched: (name) => state.touched[name] === true,
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
export function fieldCheckLine(rule: FieldRule, result: FieldCheck | undefined, touched: boolean): FieldCheckLine {
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
