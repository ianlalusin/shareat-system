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
 * never a fixed width. `span='wide'` takes two columns only when the grid's own width fits two 14rem tracks plus the gap (29rem, a container query, so it can never create an implicit column and scroll sideways); `span='full'` takes the row
 * (a textarea, a long reason, a line-items table).
 *
 * ⚠️ Adopters: `FormGrid` is an inline-size container, which gives it an intrinsic width of 0. Its
 * parent must give it width (a block, or a flex child with `flex-1` or `w-full`; never `w-fit`,
 * inline, or a table cell). It also becomes the containing block for `position: fixed` and
 * `absolute` descendants, so a popover inside it anchors to the grid, not the viewport.
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
      className={`grid gap-4 [container-type:inline-size] [grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))]${className ? ` ${className}` : ''}`}
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
  wide: ' [@container_(min-width:29rem)]:col-span-2',
  full: ' col-span-full',
};

export function Field({ label, hint, span, className, children }: FieldProps) {
  return (
    <label
      className={`block min-w-0${span ? SPAN[span] : ''}${className ? ` ${className}` : ''}`}
    >
      <span className="block text-neutral-600 dark:text-neutral-400">{label}</span>
      {hint !== undefined && hint !== null && (
        <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span>
      )}
      {children}
    </label>
  );
}
