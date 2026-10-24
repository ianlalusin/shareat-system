/**
 * T-440 - the DOM half of live field checks (browser only; called from effects and event handlers, never during render).
 * The real-DOM behaviour (Enter, focus, layout effects, a real form.reset()) is proven by the section 6 browser smoke.
 */
import { ruleInputNames, type FieldRuleSetLike } from '@shareat/domain/field-rules';

type ValueControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const isValueControl = (el: unknown): el is ValueControl =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

/**
 * What a control currently says, as a business rule reads it: a checkbox or radio is its `value` ('on' by default) only while
 * CHECKED, else ''. (A ruled text/select control is just its value.)
 */
function valueOf(el: ValueControl): string {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? el.value : '';
  return el.value;
}

/** The current value of each named control, by name. A name with no single control in the form is simply absent (= blank). */
export function readNamedValues(form: HTMLFormElement, names: Iterable<string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const el = form.elements.namedItem(name);
    if (isValueControl(el)) values[name] = valueOf(el);
  }
  return values;
}

/** The current value of every ruled control, by name. A rule with no control in the form is simply absent (= blank). */
export function readRuledValues(form: HTMLFormElement, set: FieldRuleSetLike): Record<string, string> {
  return readNamedValues(form, ruleInputNames(set));
}

/** The ruled control an input/change event came from, or null (a hidden input, a control with no rule). */
export function ruledTarget(target: EventTarget | null, names: ReadonlySet<string>): { name: string; value: string } | null {
  if (!isValueControl(target) || !target.name || !names.has(target.name)) return null;
  return { name: target.name, value: valueOf(target) };
}

export function focusControl(form: HTMLFormElement | null, name: string): void {
  const el = form?.elements.namedItem(name);
  if (el instanceof HTMLElement) el.focus();
}

/**
 * Disables every submit control the form owns (including `form="id"` buttons outside it) that is NOT a SubmitButton or an
 * EditableRecord Save (those read the context themselves, and an imperative change would be undone by their next render).
 * Only what WE disabled is ever re-enabled.
 */
export function syncForeignSubmits(form: HTMLFormElement | null, blocked: boolean): void {
  if (!form) return;
  for (const el of Array.from(form.elements)) {
    const isSubmit = (el instanceof HTMLButtonElement && el.type === 'submit') || (el instanceof HTMLInputElement && el.type === 'submit');
    if (!isSubmit || el.hasAttribute('data-check-aware')) continue;
    if (blocked) {
      if (!el.disabled) {
        el.disabled = true;
        el.setAttribute('data-check-off', 'true');
      }
    } else if (el.hasAttribute('data-check-off')) {
      el.disabled = false;
      el.removeAttribute('data-check-off');
    }
  }
}
