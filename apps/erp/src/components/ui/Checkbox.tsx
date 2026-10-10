/**
 * Checkbox — T-387 S3. A label wrapper (the 44px hit target) around a native checkbox and the text; the native
 * box stays small. Owns `aria-invalid` outright, like Input. No `'use client'`, no hooks.
 */
import type { InputHTMLAttributes, ReactNode } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label: ReactNode;
  readonly invalid?: boolean;
}

const LABEL_CLASSES = 'inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted';
const BOX_CLASSES = 'h-4 w-4 shrink-0 rounded-[4px] border accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export function Checkbox({ label, invalid = false, className, 'aria-invalid': _callerAriaInvalid, ...rest }: CheckboxProps) {
  return (
    <label className={LABEL_CLASSES}>
      <input
        type="checkbox"
        className={`${BOX_CLASSES} ${invalid ? 'border-2 border-danger' : 'border-field-border'}${className ? ` ${className}` : ''}`}
        aria-invalid={invalid ? 'true' : undefined}
        {...rest}
      />
      {label}
    </label>
  );
}
