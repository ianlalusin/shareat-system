/**
 * Card — T-334 slice 2 (docs/tasks/334-slice-2-component-contract.md §3, §4).
 *
 * No `'use client'`, no hooks (§9 R4) — the directive would foreclose server rendering for this
 * component and every caller that imports it from inside a server-action form; see this slice's
 * other two component sources for the full reasoning.
 *
 * ⛔ §9 R5: `Card` is invisible to `tests/unit/production-caller-ratchet.test.ts` (DEF-403 — the
 * word "Card" appears in unrelated user-facing/comment prose). Zero real callers is correct for
 * this slice; the orchestrator's to fix, not this file's.
 */
import type { ReactNode } from 'react';

export interface CardProps {
  readonly className?: string;
  readonly children?: ReactNode;
}

// §3: "rounding and padding consistent with what the app already uses" — measured from the
// existing card-like pattern in apps/erp/src/app/admin/*/page.tsx (e.g. access-defaults/page.tsx,
// stores/page.tsx): `rounded-lg border ... p-4`.
const BASE_CLASSES = 'rounded-lg border border-surface-border bg-surface p-4';

export function Card({ className, children }: CardProps) {
  return <div className={`${BASE_CLASSES}${className ? ` ${className}` : ''}`}>{children}</div>;
}
