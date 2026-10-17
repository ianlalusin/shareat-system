'use client';
/**
 * CheckedForm - T-440 S1. The `<form>` for an ADD form whose fields carry rules (docs/tasks/440-live-field-checks.md 3.3).
 *
 * Controls stay UNCONTROLLED: one delegated input/change listener on the form feeds a plain reducer, and a context tells each
 * `Field rule=` line, every SubmitButton and the status line what is wrong. While any rule fails, Save is truly `disabled`
 * (Q2 ruling) and the aria-live line next to it says why, so a disabled Save is never unexplained.
 *
 * The FIRST render equals the server render (inactive: Save enabled, no lines), so a browser without scripts submits and the
 * server refuses with the very same sentence. Checks start in a layout effect that reads the form's current values.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ComponentPropsWithoutRef, type FormEvent } from 'react';
import { rulesOf, type FieldRuleSetLike } from '@shareat/domain/field-rules';
import { CheckContext } from './context';
import { CheckSummary } from './CheckSummary';
import { CHECKED_FORM_INITIAL, checkContextValue, checkedFormReducer, onCheckedSubmit, watchFormReset } from './check-state';
import { focusControl, readRuledValues, ruledTarget, syncForeignSubmits } from './check-dom';

/** `useLayoutEffect` warns when a component renders on the server; the effect is browser-only, so use `useEffect` there. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface CheckedFormProps extends Omit<ComponentPropsWithoutRef<'form'>, 'action' | 'onSubmit' | 'onInput' | 'onChange'> {
  readonly rules: FieldRuleSetLike;
  readonly action: (formData: FormData) => void | Promise<void>;
}

export function CheckedForm({ rules, action, children, ...formProps }: CheckedFormProps) {
  const [state, dispatch] = useReducer(checkedFormReducer, CHECKED_FORM_INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const names = useMemo(() => new Set(rulesOf(rules).map((r) => r.name)), [rules]);
  const ctx = useMemo(() => checkContextValue(rules, state), [rules, state]);

  const reread = useCallback(() => {
    const form = formRef.current;
    if (form) dispatch({ type: 'read', values: readRuledValues(form, rules) });
  }, [rules]);

  useIsomorphicLayoutEffect(() => {
    reread();
  }, [reread]);

  useEffect(() => {
    const form = formRef.current;
    return form ? watchFormReset(form, reread) : undefined;
  }, [reread]);

  // Any other submit control (a server-rendered Button, or one linked by form="id") is switched off imperatively.
  useEffect(() => {
    syncForeignSubmits(formRef.current, ctx.blocked);
  }, [ctx.blocked]);

  const onInput = (e: FormEvent<HTMLFormElement>) => {
    const hit = ruledTarget(e.target, names);
    if (hit) dispatch({ type: 'input', name: hit.name, value: hit.value });
  };

  return (
    <CheckContext.Provider value={ctx}>
      <form
        {...formProps}
        action={action}
        ref={formRef}
        onInput={onInput}
        onChange={onInput}
        onSubmit={(e) =>
          void onCheckedSubmit(e, ctx, {
            touch: (n) => dispatch({ type: 'touch', names: n }),
            focus: (n) => focusControl(formRef.current, n),
          })
        }
      >
        {children}
        <CheckSummary active={ctx.active} summary={ctx.summary} />
      </form>
    </CheckContext.Provider>
  );
}
