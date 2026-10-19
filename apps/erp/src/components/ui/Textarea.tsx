/**
 * Textarea — T-387 S3. A native `<textarea>` with Input's tokens (taller: `min-h-24`) and its `invalid`
 * contract. No `'use client'`, no hooks.
 */
import type { TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
}

const BASE_CLASSES = 'rounded-[10px] border bg-field px-3 py-2 min-h-24 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-danger';

export function Textarea({ invalid = false, className, 'aria-invalid': _callerAriaInvalid, ...rest }: TextareaProps) {
  return (
    <textarea
      data-erp-control="multiline"
      className={`${BASE_CLASSES} ${invalid ? 'border-2 border-danger' : 'border-field-border'}${className ? ` ${className}` : ''}`}
      aria-invalid={invalid ? 'true' : undefined}
      {...rest}
    />
  );
}
