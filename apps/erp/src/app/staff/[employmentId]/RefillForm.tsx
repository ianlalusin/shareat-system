'use client';
/**
 * The refill half of EditableRecord, for a form that lives inside a modal. Put it as the FIRST child of the form:
 * after a refused save it writes what the person typed back into the controls (EditableRecord's own `applyTyped`),
 * shows the hint or the "too long to keep" sentence, and keeps a hidden `__changed` field up to date so a refusal
 * carries only what was touched. The form itself stays in the page, so its rules and action are read there.
 * The field is named only once the page is live, so without JavaScript no `__changed` key is sent (as EditableRecord does).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Banner } from '@/components/ui';
import type { TypedView } from '@/lib/keep-typing';
import { TYPED_DROPPED_MESSAGE, applyTyped, formChangedNames, notAppliedMessage } from '@/components/forms';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const openingMessage = (typed: TypedView | null) => (typed?.kind === 'dropped' ? TYPED_DROPPED_MESSAGE : (typed?.hint ?? null));

/** `formKey` only names the form (the tests find it by it); it changes nothing here. */
export function RefillForm({ typed }: { typed: TypedView | null; formKey: string }) {
  const changed = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(openingMessage(typed));
  const key = typed ? JSON.stringify(typed) : null;

  useIsomorphicLayoutEffect(() => {
    const field = changed.current;
    const form = field?.form;
    if (!field || !form) return;
    field.name = '__changed';
    const sync = () => {
      field.value = formChangedNames(form).join(',');
    };
    const onReset = () => setTimeout(sync, 0);
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    form.addEventListener('reset', onReset);
    setMessage(openingMessage(typed));
    if (typed?.kind === 'typed') {
      const labels = applyTyped(form, typed.fields);
      if (labels.length > 0) setMessage((m) => [m, notAppliedMessage(labels)].filter(Boolean).join(' '));
    }
    sync();
    return () => {
      form.removeEventListener('input', sync);
      form.removeEventListener('change', sync);
      form.removeEventListener('reset', onReset);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the value of `typed`
  }, [key]);

  return (
    <>
      <input ref={changed} type="hidden" defaultValue="" />
      {message ? <Banner tone="warning">{message}</Banner> : null}
    </>
  );
}
