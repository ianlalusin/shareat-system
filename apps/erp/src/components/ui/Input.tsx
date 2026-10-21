/**
 * Input — T-334 slice 2 (docs/tasks/334-slice-2-component-contract.md §3, §4).
 *
 * No `'use client'`, no hooks (§9 R4) — the directive would foreclose server rendering for this
 * component and every caller that imports it from inside a server-action form; see this slice's
 * other two component sources for the full reasoning.
 */
import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
}

// A single string literal, not `+`-joined — apps/erp/tests/touch-target-geometry.ts's
// `findLocalConst` only recognises a named constant's value when the declaration's initializer is
// itself a literal AST node (see this slice's other component sources for the full reasoning).
// Audit finding 6(b): same ring-offset as Button.tsx's `BASE_CLASSES`, for the same reason — one
// shared focus idiom across the components this slice ships, not two focus rings sitting at
// different distances once a form adopts both.
const BASE_CLASSES = 'rounded-[10px] border bg-field px-3 py-2 min-h-11 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-danger';

export function Input({
  invalid = false,
  className,
  // Audit finding: destructured out of `rest`, same as `className` already was, so a caller's own
  // `aria-invalid` can never land after ours and win. `invalid` is the one declared channel for
  // this attribute (§3/§4.5) and the component owns it OUTRIGHT, in both directions — not only
  // when true. Border colour and ARIA state are the same fact told two ways; letting a caller
  // detach them (a red border with aria-invalid="false", or a plain border with "true") is the
  // exact "colour is never the sole channel" failure this component exists to prevent, just
  // inverted. A caller that needs a different a11y story has the wrong component, not a missing
  // escape hatch.
  'aria-invalid': _callerAriaInvalid,
  ...rest
}: InputProps) {
  return (
    <input
      data-erp-control="single"
      // §4.5: invalid emits BOTH border-danger and aria-invalid="true" — the ARIA half is not
      // optional, colour is never the sole channel. `undefined` (not `false`) so the attribute is
      // omitted entirely when valid, rather than rendering the literal string "false".
      className={`${BASE_CLASSES} ${invalid ? 'border-2 border-danger' : 'border-field-border'}${className ? ` ${className}` : ''}`}
      aria-invalid={invalid ? 'true' : undefined}
      {...rest}
    />
  );
}
