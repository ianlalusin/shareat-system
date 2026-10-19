/**
 * FormGrid and Field - T-384 S2a (docs/tasks/384-pos-link-tenders-and-width.md, W-R2).
 *
 * Ian, 2026-10-08: "i want all forms to adjust based on screen size and always use full width".
 *
 * `FormGrid` is an auto-fit grid: it adapts to the CONTAINER, not the viewport, so it is right
 * whether the sidebar is open or collapsed and needs no breakpoint. One column on a phone, more as
 * the space grows. `min(100%,14rem)` stops a 375 px phone from scrolling sideways (DEF-199).
 *
 * T-445 (Ian, 2026-10-19) supersedes stretching each individual control: the page stays full width,
 * while `layout='fields'` wraps content-sized fields and `Field width` gives a shrinkable ceiling.
 * Existing grid/span callers are unchanged. `Field` keeps label, hint, validation and control together.
 * `span='wide'` takes two columns only when the grid's own width fits two 14rem tracks plus the gap (29rem, a container query, so it can never create an implicit column and scroll sideways); `span='full'` takes the row
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
import type { FieldRule } from '@shareat/domain/field-rules';
import { FieldCheck } from '@/components/forms/FieldCheck';

export interface FormGridProps {
  /** T-445: content-sized fields wrap within their container; existing grids remain unchanged. */
  readonly layout?: 'grid' | 'fields';
  readonly className?: string;
  readonly children?: ReactNode;
}

export function FormGrid({ layout = 'grid', className, children }: FormGridProps) {
  if (layout === 'fields') return <div className={`erp-form-fields${className ? ` ${className}` : ''}`}>{children}</div>;
  return (
    <div
      className={`grid gap-4 [container-type:inline-size] [grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))]${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}

export interface FieldProps {
  readonly width?: 'short' | 'code' | 'date' | 'name' | 'long' | 'full';
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly span?: 'wide' | 'full';
  readonly className?: string;
  /**
   * T-440: this field's rule. Adds the live helper line OUTSIDE the label (a wrapper `<div>` holds label + line) and, with the
   * control spread from `nativeAttrs(rule)`, its native attributes. No rule = exactly the bare `<label>` it always was.
   */
  readonly rule?: FieldRule;
  readonly children?: ReactNode;
}

const SPAN: Record<'wide' | 'full', string> = {
  wide: ' [@container_(min-width:29rem)]:col-span-2',
  full: ' col-span-full',
};

export function Field({ label, hint, span, width, className, rule, children }: FieldProps) {
  const outer = `min-w-0${span ? SPAN[span] : ''}${width ? ` erp-field-${width}` : ''}${className ? ` ${className}` : ''}`;
  const inner = (
    <>
      <span className="block text-ink">{label}</span>
      {hint !== undefined && hint !== null && (
        <span className="mt-0.5 block text-xs text-ink/70">{hint}</span>
      )}
      {children}
    </>
  );
  if (!rule) return <label className={`block ${outer}`}>{inner}</label>;
  return (
    <div className={outer}>
      <label className="block">{inner}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}

/** A named, visible group; does not introduce a form or alter submission/validation. */
export function FormSection({ title, children, className }: { readonly title: string; readonly children?: ReactNode; readonly className?: string }) {
  return <fieldset className={`erp-form-section${className ? ` ${className}` : ''}`}><legend className="text-sm font-medium text-ink">{title}</legend>{children}</fieldset>;
}
