/**
 * Select — T-387 S3. A native `<select>` with Input's geometry and its `invalid` contract (see Input.tsx for the
 * reasoning on owning `aria-invalid` outright). No `'use client'`, no hooks.
 */
import type { SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly invalid?: boolean;
}

// A single string literal, same tokens as Input.BASE_CLASSES (the census reads literal initializers).
const BASE_CLASSES = 'rounded-[10px] border bg-field px-3 py-2 min-h-11 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-danger';

export function Select({ invalid = false, className, 'aria-invalid': _callerAriaInvalid, children, ...rest }: SelectProps) {
  return (
    <select
      data-erp-control="single"
      className={`${BASE_CLASSES} ${invalid ? 'border-2 border-danger' : 'border-field-border'}${className ? ` ${className}` : ''}`}
      aria-invalid={invalid ? 'true' : undefined}
      {...rest}
    >
      {children}
    </select>
  );
}
