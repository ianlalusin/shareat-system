'use client';

/**
 * SubmitButton — T-387 S2. The kit `Button` (primary, type=submit) that disables itself and shows a
 * spinner and a pending label while its form's server action runs.
 *
 * ⭐ `useFormStatus` from `react-dom`. ⚠️ The workspace's `react-dom` package is 18.3.1, where the hook
 * does not exist, and that is what Vitest (node) loads. **The App Router does not use it:** Next
 * 16.3.2 runs its own bundled React (`next/dist/compiled/react-dom`, 19.3.0-canary), where the hook
 * exists. Verified 2026-10-10 by reading the bundled version. `app/setup/SubmitButton.tsx`'s claim
 * that the hook is unavailable "here" was measured in node, not in the app.
 *
 * Why the hook and not a `submit` listener (the first S2 build): React owns the action's lifecycle,
 * so `pending` ends when the action settles: a redirect back to the same page with an error flash,
 * a thrown error, or a client `onSubmit` that calls `preventDefault()`. A listener cannot see any of
 * those, and the button stays stuck on "Saving…" (S2 audit findings 1 and 3). It needs a server-action
 * form (`<form action={fn}>`), which is 91 of the app's 95 forms. Outside one, `pending` is always
 * false and this is a plain submit button.
 */
import { useFormStatus } from 'react-dom';
import { useContext, type ReactNode } from 'react';
import { CheckContext } from '@/components/forms/context';
import { Button } from '@/components/ui';
import type { ButtonVariant } from '@/components/ui/Button';
import { submitButtonState } from './submit-button-state';

export interface SubmitButtonProps {
  readonly children: string;
  readonly pendingLabel?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  /** `primary` by default. A Save repeated on one view (one per row or per category) is `secondary`:
   *  ADR-013 allows one brand-red primary per view. */
  readonly variant?: Extract<ButtonVariant, 'primary' | 'secondary'>;
}

function Spinner(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      className="h-4 w-4 animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

export function SubmitButton({ children, pendingLabel, className, disabled, variant = 'primary' }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  // T-440: inside a checked form, a failing rule makes Save truly `disabled`. It must be read here, not set imperatively:
  // this button re-renders when `pending` ends and would otherwise undo an imperative change. No provider = unchanged.
  const blocked = useContext(CheckContext)?.blocked === true;
  const state = submitButtonState({ pending, label: children, pendingLabel });

  return (
    <Button
      type="submit"
      variant={variant}
      className={className}
      disabled={state.disabled || disabled || blocked}
      data-check-aware="true"
      aria-busy={state.ariaBusy ? 'true' : undefined}
    >
      {pending ? <Spinner /> : null}
      {state.label}
    </Button>
  );
}
