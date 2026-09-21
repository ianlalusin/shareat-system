/**
 * Button — T-334 slice 2 (docs/tasks/334-slice-2-component-contract.md §3, §4, §9 R1-R4).
 *
 * No `'use client'`, no hooks (§9 R4) — a component without the directive renders from a server
 * component and still bundles fine when a client component imports it; adding it would foreclose
 * the server path for every plain `type="submit"` caller inside a server-action form.
 */
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

// A single string literal, not `+`-joined — apps/erp/tests/touch-target-geometry.ts's
// `findLocalConst` only recognises a named constant's value when the declaration's initializer is
// a literal AST node (`ts.isStringLiteral`/`ts.isNoSubstitutionTemplateLiteral`), never a
// `resolveExpr`-recursed BinaryExpression, however statically foldable it is at runtime.
const BASE_CLASSES = 'inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

// §3: primary is the one solid fill; secondary is the careless-caller-safe default; danger is
// OUTLINED, never filled (§9 R2 guard 9) and never carries a surface tint either — §3 gives it no
// background at all. §9 R1: `text-white` is the one named exception to token discipline.
const PRIMARY_CLASSES = 'border border-transparent bg-brand text-white hover:bg-brand-hover';
const SECONDARY_CLASSES = 'border border-surface-border bg-surface text-ink';
const DANGER_CLASSES = 'border border-danger text-danger';

/**
 * Hand-drawn, original artwork — §9 R3. No warning/alert glyph exists anywhere in this tree, and
 * `shell/icons.tsx` (the only icon set) is outside this slice's scope, so this one glyph lives
 * here rather than there; centralising it is slice 3's call, not a defect in this one. Same idiom
 * as `shell/icons.tsx`: 24x24 viewBox, stroke 1.5, rounded caps/joins.
 *
 * ⛔ Rendered for `danger` ONLY. `ui-button.test.ts`'s control pair asserts primary/secondary emit
 * no `<svg>` at all — that negative half is what makes "danger always has one" a real invariant.
 */
function WarningTriangleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.29 3.86 1.82 18a1.5 1.5 0 0 0 1.29 2.25h17.78a1.5 1.5 0 0 0 1.29-2.25L13.71 3.86a1.5 1.5 0 0 0-2.42 0Z" />
      <path d="M12 9v4.5M12 17.25h.008" />
    </svg>
  );
}

export function Button({
  variant = 'secondary',
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE_CLASSES} ${
        variant === 'primary' ? PRIMARY_CLASSES : variant === 'danger' ? DANGER_CLASSES : SECONDARY_CLASSES
      }${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {variant === 'danger' ? <WarningTriangleIcon /> : null}
      {children}
    </button>
  );
}
