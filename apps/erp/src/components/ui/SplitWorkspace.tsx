import type { ReactNode } from 'react';

/** T-444: related form/details panels split only when their own container has enough space. */
export function SplitWorkspace({ form, details, formTitle = 'Form', detailsTitle = 'Details', balance = 'equal' }: {
  readonly balance?: 'equal' | 'details';
  readonly form: ReactNode;
  readonly details: ReactNode;
  readonly formTitle?: string;
  readonly detailsTitle?: string;
}) {
  return (
    <div className="split-workspace w-full min-w-0">
      <div className={`split-workspace-grid grid min-w-0 items-start gap-4${balance === 'details' ? ' split-workspace-details' : ''}`}>
        <section aria-label={formTitle} className="min-w-0">{form}</section>
        <section aria-label={detailsTitle} className="min-w-0">{details}</section>
      </div>
    </div>
  );
}
