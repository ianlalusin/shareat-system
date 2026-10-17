'use client';
/**
 * FieldCheck - T-440 S1. The helper line under one ruled field: a muted requirement before typing, the progress words in
 * danger text with a warning icon while failing, "Good" with a check icon once satisfied. Never colour alone.
 *
 * It renders OUTSIDE the field's <label> (so the changing text never becomes part of the control's accessible name) and, in a
 * layout effect, appends its id to the control's `aria-describedby` and marks `aria-invalid` while touched-and-failing. It only
 * removes an `aria-invalid` it set itself: a server-rendered one (Input's `invalid` channel) is never cleared.
 *
 * Outside a checked form, or while checks are inactive (first render, a locked record), it renders nothing.
 */
import { useContext, useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { FieldRule } from '@shareat/domain/field-rules';
import { CheckContext } from './context';
import { fieldCheckLine, planFieldAria, type FieldCheckLine } from './check-state';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 14,
  height: 14,
  className: 'mt-px h-3.5 w-3.5 shrink-0',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
} as const;

function CheckIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

const TONE: Record<FieldCheckLine['kind'], string> = {
  muted: 'text-muted',
  failing: 'text-danger',
  passing: 'text-success',
};

/** The presentational line: a polite live region holding the text and (for failing/passing) an aria-hidden icon. */
export function FieldCheckView({ id, line }: { id: string; line: FieldCheckLine }) {
  return (
    <p id={id} aria-live="polite" className={`mt-1 flex items-start gap-1.5 text-xs ${TONE[line.kind]}`}>
      {line.kind === 'passing' ? <CheckIcon /> : line.kind === 'failing' ? <WarnIcon /> : null}
      <span>{line.text}</span>
    </p>
  );
}

function controlNamed(from: HTMLElement | null, name: string): HTMLElement | null {
  const wrapper = from?.parentElement;
  if (!wrapper) return null;
  const el = Array.from(wrapper.querySelectorAll<HTMLElement>('input, select, textarea')).find(
    (c) => (c as HTMLInputElement).name === name,
  );
  return el ?? null;
}

export function FieldCheck({ rule }: { rule: FieldRule }) {
  const ctx = useContext(CheckContext);
  const id = useId();
  const ownInvalid = useRef(false);
  const shown = ctx !== null && ctx.active;
  const result = shown ? ctx.result(rule.name) : undefined;
  const touched = shown ? ctx.touched(rule.name) : false;
  const failing = touched && result !== undefined && !result.ok;
  const visible = shown && result !== undefined;

  const applied = useRef<HTMLElement | null>(null);
  // Takes our id (and our own invalid mark) back off the control we wrote to.
  const release = useRef(() => {});
  release.current = () => {
    const control = applied.current;
    if (!control) return;
    const rest = (control.getAttribute('aria-describedby') ?? '').split(/s+/).filter((x) => x && x !== id);
    if (rest.length > 0) control.setAttribute('aria-describedby', rest.join(' '));
    else control.removeAttribute('aria-describedby');
    if (ownInvalid.current) control.removeAttribute('aria-invalid');
    ownInvalid.current = false;
    applied.current = null;
  };

  useIsomorphicLayoutEffect(() => {
    if (!visible) {
      release.current();
      return;
    }
    const control = controlNamed(document.getElementById(id), rule.name);
    if (!control) return;
    applied.current = control;
    const plan = planFieldAria(
      { describedby: control.getAttribute('aria-describedby'), invalid: control.getAttribute('aria-invalid'), ownInvalid: ownInvalid.current },
      id,
      failing,
    );
    control.setAttribute('aria-describedby', plan.describedby);
    if (plan.ownInvalid) control.setAttribute('aria-invalid', 'true');
    else if (ownInvalid.current) control.removeAttribute('aria-invalid');
    ownInvalid.current = plan.ownInvalid;
  }, [visible, failing, id, rule.name]);

  // Unmounting (the form went away, or the field was removed) also releases the control.
  useIsomorphicLayoutEffect(() => () => release.current(), []);

  if (!visible) return null;
  return <FieldCheckView id={id} line={fieldCheckLine(rule, result, touched)} />;
}
