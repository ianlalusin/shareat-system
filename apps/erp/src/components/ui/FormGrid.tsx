/**
 * FormGrid and Field - T-384 S2a (docs/tasks/384-pos-link-tenders-and-width.md, W-R2).
 *
 * Ian, 2026-10-08: "i want all forms to adjust based on screen size and always use full width".
 *
 * In grid mode `FormGrid` adapts to the CONTAINER, not the viewport, so it is right
 * whether the sidebar is open or collapsed and needs no breakpoint. One column on a phone, more as
 * the space grows. `min(100%,14rem)` stops a 375 px phone from scrolling sideways (DEF-199).
 *
 * T-445 (Ian, 2026-10-19) supersedes stretching each individual control: the page stays full width,
 * while `layout='fields'` wraps content-sized fields and `Field width` gives a shrinkable ceiling.
 * T-450: compact fields are the default; explicit grids, wide spans and grid-column overrides retain grid mode.
 * `Field` keeps label, hint, validation and control together.
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
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import type { FieldRule } from '@shareat/domain/field-rules';
import { FieldCheck } from '@/components/forms/FieldCheck';
import { HelpTip } from './HelpTip';

export interface FormGridProps {
  /** T-445: content-sized fields wrap within their container; existing grids remain unchanged. */
  readonly layout?: 'grid' | 'fields' | 'pairs';
  readonly className?: string;
  readonly children?: ReactNode;
}

function hasWideSpan(children: ReactNode): boolean {
  return Children.toArray(children).some(child => {
    if (!isValidElement<{ span?: string; className?: string; children?: ReactNode }>(child)) return false;
    return child.props.span === 'wide' || /col-span-(?!full)/.test(child.props.className ?? '')
      || (child.type === Fragment && hasWideSpan(child.props.children));
  });
}

export function FormGrid({ layout, className, children }: FormGridProps) {
  if (layout === 'pairs') return <div className={`erp-form-pairs${className ? ` ${className}` : ''}`}><div className="erp-form-pairs-grid">{children}</div></div>;
  // Entry forms share compact defaults; grid-specific callers retain the layout their spans require.
  const resolved = layout ?? (hasWideSpan(children) || /grid-cols-|grid-template-columns/.test(className ?? '') ? 'grid' : 'fields');
  if (resolved === 'fields') return <div className={`erp-form-fields${className ? ` ${className}` : ''}`}>{children}</div>;
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

function inferredWidth(children: ReactNode): FieldProps['width'] {
  const control = Children.toArray(children).find(child => isValidElement<{ type?: string; name?: string; inputMode?: string }>(child)
    && child.props.type !== 'hidden' && (child.props.name || child.props.type || child.props.inputMode));
  if (!isValidElement<{ type?: string; name?: string; inputMode?: string }>(control)) return undefined;
  const { type, name = '', inputMode } = control.props;
  if (/^(date|month|time)$/.test(type ?? '')) return 'date';
  if (/^(baseUnit|purchaseUnit|unit|quantity|creditTermsDays|days|year|month|vatPercent)$/.test(name)) return 'short';
  if (/amount|rate|price|cost|total|fee|balance|limit|deposit|gross|deduction|principal|interest/i.test(name)) return 'code';
  if (/code|reference|invoiceNo/i.test(name)) return 'code';
  if (/kind|vatType|customerGroup/i.test(name)) return 'code';
  if (/description|notes|reason|address/i.test(name)) return 'long';
  if (type === 'number' || inputMode === 'numeric' || inputMode === 'decimal') return 'short';
  return undefined;
}

export function Field({ label, hint, span, width, className, rule, children }: FieldProps) {
  const resolvedWidth = width ?? (span ? undefined : inferredWidth(children));
  const outer = `erp-form-field min-w-0${span ? SPAN[span] : ''}${resolvedWidth ? ` erp-field-${resolvedWidth}` : ''}${className ? ` ${className}` : ''}`;
  const inner = (
    <>
      {/* T-448: the hint is a (?) beside the label, not a line under it, so neighbouring controls line up. */}
      <span className="erp-field-label flex items-center text-sm font-medium leading-5 text-ink">
        {label}
        {rule && rule.optional !== true ? <span aria-hidden="true" className="ml-0.5 text-danger">*</span> : null}
        {hint !== undefined && hint !== null && hint !== false && (
          <HelpTip label={typeof label === 'string' ? label : undefined}>{hint}</HelpTip>
        )}
      </span>
      <span className="erp-field-control mt-1 block min-w-0">{children}</span>
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

/** T-448: sibling cards share a row when they fit (auto-fit, 24rem minimum each). */
export function CardGrid({ children, className, min }: { readonly children?: ReactNode; readonly className?: string; readonly min?: 'sm' | 'md' | 'lg' }) {
  const style = min ? ({ '--erp-card-min': min === 'sm' ? '18rem' : min === 'lg' ? '32rem' : '24rem' } as Record<string, string>) : undefined;
  return <div className={`erp-card-grid${className ? ` ${className}` : ''}`} style={style}>{children}</div>;
}

/** A named, visible group; does not introduce a form or alter submission/validation. */
export function FormSection({ title, children, className }: { readonly title: string; readonly children?: ReactNode; readonly className?: string }) {
  return <fieldset className={`erp-form-section${className ? ` ${className}` : ''}`}><legend className="text-sm font-medium text-ink">{title}</legend>{children}</fieldset>;
}
