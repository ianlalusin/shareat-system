/**
 * Button — T-334 slice 2 (docs/tasks/334-slice-2-component-contract.md §3, §4, §9 R1-R4).
 *
 * No `'use client'`, no hooks (§9 R4) — a component without the directive renders from a server
 * component and still bundles fine when a client component imports it; adding it would foreclose
 * the server path for every plain `type="submit"` caller inside a server-action form.
 */
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

// A single string literal, not `+`-joined — apps/erp/tests/touch-target-geometry.ts's
// `findLocalConst` only recognises a named constant's value when the declaration's initializer is
// a literal AST node (`ts.isStringLiteral`/`ts.isNoSubstitutionTemplateLiteral`), never a
// `resolveExpr`-recursed BinaryExpression, however statically foldable it is at runtime.
// Audit finding 2 (pre-Amendment-6): `focus-visible:ring-brand` alone put a `--brand` ring
// directly against primary's own `bg-brand` fill — same token, no visible seam, so tabbing onto
// "Save" removed the browser's outline and put nothing distinguishable in its place (WCAG 2.4.7).
// ADR-013 Amendment 6 (2026-09-24, FINAL) moved the ring to `ring-ink` — a different token than
// any variant's own fill, so that specific same-token collision no longer applies — but
// `ring-offset` is kept for the reason that still holds regardless of ring colour: it inserts a
// visible gap in `--surface` between the fill and the ring on every variant, which is what makes
// the ring read as an outline rather than as the fill growing by 2px. No new token —
// `ring-offset-surface` resolves through Tailwind's default `ringOffsetColor`, which spreads
// `theme('colors')` the same way `ringColor` does.
const BASE_CLASSES = 'inline-flex items-center gap-2 min-h-11 rounded-[12px] px-4 py-2.5 text-sm font-semibold disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

// §3: primary is the one solid fill; secondary is the careless-caller-safe default; danger is
// OUTLINED, never filled (§9 R2 guard 9) and never carries a surface tint either — §3 gives it no
// background at all. §9 R1: `text-white` is the one named exception to token discipline.
//
// Audit finding 4 — back to a `Record`, not the ternary this file briefly carried. The ternary
// existed only to satisfy `apps/erp/tests/action-link-sweep.test.ts`'s static census, on the
// premise that an ElementAccessExpression (`VARIANT_CLASSES[variant]`) is a shape `resolveExpr`
// cannot resolve. Measured, and true — but Button.tsx is ALREADY permanently `unresolved` for an
// unrelated reason: its `className`-append references a destructured function PARAMETER, which
// `findLocalConst` can never resolve regardless of what else the expression contains (proved
// earlier the same way: stripping the append made the file resolve; restoring it made it
// unresolved again, byte-identical reason string). Once this file was accepted into
// `touch-target-baseline.json`'s unresolved set for THAT reason, an ElementAccessExpression here
// costs nothing further to resolvability — confirmed by re-running the sweep after restoring this
// Record (see this READY's gate output; do not take that on trust either).
// ⛔ THIS DOES NOT GENERALISE. A component whose className is otherwise fully static (no
// caller-supplied className, no other unresolvable identifier) would still lose real sweep
// coverage from a bracket lookup here — the trade is free ONLY because this file was already a
// write-off for a separate, prior reason. Check that precondition again before copying this
// pattern anywhere else.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'border border-transparent bg-brand text-white hover:bg-brand-hover',
  secondary: 'border border-surface-border bg-surface text-ink hover:bg-canvas',
  ghost: 'border border-transparent bg-transparent text-ink hover:bg-canvas',
  danger: 'border border-danger text-danger',
};

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
      data-erp-control="single"
      type={type}
      className={`${BASE_CLASSES} ${VARIANT_CLASSES[variant]}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {variant === 'danger' ? <WarningTriangleIcon /> : null}
      {children}
    </button>
  );
}
