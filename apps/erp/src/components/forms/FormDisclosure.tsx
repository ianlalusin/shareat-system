'use client';
import { Children, Fragment, createContext, isValidElement, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import { SubmitButton } from '../feedback/SubmitButton';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { ConfirmDestructive } from '../ui/ConfirmDestructive';
import { CheckSummary } from './CheckSummary';

const Called = createContext(false);

/** An existing Add card already provides the explicit action that opens its children. */
export function FormCalled({ children }: { children: ReactNode }) {
  return <Called.Provider value={true}>{children}</Called.Provider>;
}

/** Reuse the human action label; do not infer words from a server function name. */
export function formActionLabel(children: ReactNode): ReactNode {
  let found: ReactNode;
  Children.forEach(children, child => {
    if (found || !isValidElement<{ type?: string; children?: ReactNode }>(child)) return;
    if ((child.props.type === 'submit' || child.type === SubmitButton || (child.type === 'button' && child.props.type !== 'button')) && child.props.children) found = child.props.children;
    else found = formActionLabel(child.props.children);
  });
  return found;
}

/** A button-only command is already called by its own action; retain that single click. */
export function formNeedsReveal(children: ReactNode): boolean {
  let entry = false;
  Children.forEach(children, child => {
    if (!isValidElement<{ type?: string; children?: ReactNode }>(child)) return;
    if (child.type === 'input' || child.type === Input) entry ||= child.props.type !== 'hidden';
    else if (child.type === 'select' || child.type === 'textarea' || child.type === Select || child.type === Textarea) entry = true;
    else if (typeof child.type !== 'string' && child.type !== Fragment && child.type !== Button && child.type !== SubmitButton && child.type !== ConfirmDestructive && child.type !== CheckSummary) entry = true;
    entry ||= formNeedsReveal(child.props.children);
  });
  return entry;
}

const refusalKey = () => `erp-called-form:${window.location.pathname}`;

/** Native disclosure is closed in server HTML, works without scripts, and keeps controls mounted. */
export function FormDisclosure({ children, label, called: calledByAction = false }: { children: ReactNode; label?: ReactNode; called?: boolean }) {
  const called = useContext(Called) || calledByAction;
  const reveal = !called && formNeedsReveal(children);
  const id = useId();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!reveal) return;
    const reopen = () => {
      try {
        const key = refusalKey();
        // A redirect refusal must not hide retained typing, including an in-place server navigation.
        if (sessionStorage.getItem(key) === id && document.querySelector('[data-form-refusal]') && ref.current) {
          ref.current.open = true;
          sessionStorage.removeItem(key);
        }
      } catch { /* Storage may be disabled; native opening and server validation remain available. */ }
    };
    reopen();
    const observer = new MutationObserver(reopen);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [reveal, id]);
  if (!reveal) return <>{children}</>;
  return <details ref={ref} id={`form-${id}`} className="erp-action-form min-w-0"
    onSubmitCapture={() => { try { sessionStorage.setItem(refusalKey(), id); } catch { /* No typed values are stored. */ } }}
    onInvalidCapture={() => { if (ref.current) ref.current.open = true; }}>
    <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md border border-surface-border px-4 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink">
      <span>{label || formActionLabel(children) || 'Update'}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 5 6 6 6-6M6 13l6 6 6-6" /></svg>
    </summary>
    <FormCalled><div className="mt-3 min-w-0">{children}</div></FormCalled>
  </details>;
}
