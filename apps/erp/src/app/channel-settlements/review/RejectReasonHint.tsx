'use client';

import { useContext } from 'react';
import { CheckContext } from '@/components/forms/context';

/**
 * The reject form's one line about why Reject is off. The shared "Save is off until: ..." line says "Save" on a button that says Reject, so the form hides it
 * and this line takes over as the announced status: empty while the reason is filled in, plain words while it is not. Renders nothing before the checks start.
 */
export function RejectReasonHint() {
  const check = useContext(CheckContext);
  if (!check || !check.active) return null;
  return (
    // a div on purpose: the form hides its shared line with `[&>p[role=status]]:hidden`, which must not match this one
    <div role="status" aria-live="polite" className="min-h-5 text-sm text-ink/70">
      {check.blocked ? 'Write a reason to reject this day.' : ''}
    </div>
  );
}
