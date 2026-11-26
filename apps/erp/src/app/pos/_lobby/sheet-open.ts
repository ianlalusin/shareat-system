'use client';

/**
 * T-644 S3 - "is an Orders seat / order sheet open right now?", for the shell-level birthday prompt. The sheet (`OrderDialog`) is not a modal Dialog: it replaces the page
 * while the cashier builds an order, and a birthday dialog on top of it would hide a half-built order. The sheet holds a flag while mounted (`useHoldSheetOpen`); the prompt
 * reads it (`useSheetOpen`) and shows a bottom banner instead of a dialog. A count, not a boolean, so two sheets cannot clear each other.
 */
import { useEffect, useSyncExternalStore } from 'react';

let held = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Call once from a sheet component: the flag is held from mount to unmount. */
export function useHoldSheetOpen(): void {
  useEffect(() => {
    held += 1;
    emit();
    return () => {
      held -= 1;
      emit();
    };
  }, []);
}

export function useSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, () => held > 0, () => false);
}
