'use client';
/** useFormValues - T-475 S1. The form's current values for these control names (tracked on demand), or null outside a live form. */
import { useContext, useEffect, useLayoutEffect } from 'react';
import { CheckContext } from './context';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useFormValues(names: readonly string[]): Readonly<Record<string, string>> | null {
  const ctx = useContext(CheckContext);
  const track = ctx?.track;
  const key = names.join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the names' identity
  useIsomorphicLayoutEffect(() => (track ? track(names) : undefined), [track, key]);
  return ctx && ctx.active ? ctx.values : null;
}
