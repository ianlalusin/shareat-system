import type { ReactNode } from 'react';
import { FormCalled } from '@/components/forms/FormDisclosure';

/** Native disclosure: the form stays mounted, and opening works without JavaScript. */
export function DisclosureCard({ id, title, action = 'Add', children }: {
  readonly id: string;
  readonly title: string;
  readonly action?: string;
  readonly children: ReactNode;
}) {
  return <details id={id} className="erp-disclosure-card rounded-lg border border-surface-border p-3">
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
      <span>{title}</span>
      <span className="erp-disclosure-action inline-flex min-h-11 min-w-14 items-center justify-center gap-2 rounded-lg border border-field-border px-3">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        <span>{action}</span>
      </span>
    </summary>
    <FormCalled><div className="mt-3 space-y-3">{children}</div></FormCalled>
  </details>;
}
