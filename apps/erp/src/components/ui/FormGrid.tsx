/**
 * FormGrid and Field - T-384 S2a (docs/tasks/384-pos-link-tenders-and-width.md, W-R2).
 *
 * Ian, 2026-10-08: "i want all forms to adjust based on screen size and always use full width".
 *
 * `FormGrid` is an auto-fit grid: it adapts to the CONTAINER, not the viewport, so it is right
 * whether the sidebar is open or collapsed and needs no breakpoint. One column on a phone, more as
 * the space grows. `min(100%,14rem)` stops a 375 px phone from scrolling sideways (DEF-199).
 *
 * `Field` is the label, its text, an optional hint and the control. Controls inside take `w-full`;
 * never a fixed width. `span='wide'` takes two columns from `sm` up; `span='full'` takes the row
 * (a textarea, a long reason, a line-items table).
 *
 * No `'use client'` and no hooks, like the other components in this folder, so a server component
 * or a server-action form can import it.
 */
import type { ReactNode } from 'react';

export interface FormGridProps {
  readonly className?: string;
  readonly children?: ReactNode;
}

export function FormGrid({ className, children }: FormGridProps) {
  return (
    <div
      className={`grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))]${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}

export interface FieldProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly span?: 'wide' | 'full';
  readonly className?: string;
  readonly children?: ReactNode;
}

const SPAN: Record<'wide' | 'full', string> = {
  wide: ' sm:col-span-2',
  full: ' col-span-full',
};

export function Field({ label, hint, span, className, children }: FieldProps) {
  return (
    <label
      className={`block min-w-0${span ? SPAN[span] : ''}${className ? ` ${className}` : ''}`}
    >
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      {hint !== undefined && hint !== null && (
        <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span>
      )}
      {children}
    </label>
  );
}
