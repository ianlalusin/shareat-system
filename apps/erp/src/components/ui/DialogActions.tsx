'use client';
/**
 * DialogActions - T-548 S0. A form's action row (Save, secondary buttons) as the LAST child of the form.
 *
 * Inside a modal (`.erp-dialog-body`, globals.css) it is pinned to the bottom of the scrolling body, edge to edge, so only
 * the middle scrolls. It stays INSIDE the `<form>`: SubmitButton keeps its form's pending state and the check context.
 * Outside a dialog it is a plain right-aligned row.
 *
 * In a CheckedForm the "Save is off until..." line renders in this band, above the buttons (the form's own line steps
 * aside, so there is still exactly one live region). In any other form no line is drawn.
 */
import { useContext, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { CheckContext } from '@/components/forms/context';
import { CheckSummary } from '@/components/forms/CheckSummary';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface DialogActionsProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function DialogActions({ children, className }: DialogActionsProps) {
  const ctx = useContext(CheckContext);
  const register = ctx?.registerBand;
  useIsomorphicLayoutEffect(() => register?.(), [register]);
  return (
    <div data-dialog-actions className={`mt-4 flex flex-wrap items-center justify-end gap-2${className ? ` ${className}` : ''}`}>
      {ctx?.inBand ? <CheckSummary active={ctx.active} summary={ctx.summary} className="w-full text-left" /> : null}
      {children}
    </div>
  );
}
