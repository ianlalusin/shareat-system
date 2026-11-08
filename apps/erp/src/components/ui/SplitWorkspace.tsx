import type { ReactNode } from 'react';

/** T-444: related form/details panels split only when their own container has enough space. */
export function SplitWorkspace({ form, details, formTitle = 'Form', detailsTitle = 'Details', balance = 'equal', stickyDetails = false }: {
  readonly balance?: 'equal' | 'details';
  /** T-511 S6d: the details section stays in view while a long form scrolls. Only where the grid is two columns (see globals.css). */
  readonly stickyDetails?: boolean;
  readonly form: ReactNode;
  readonly details: ReactNode;
  readonly formTitle?: string;
  readonly detailsTitle?: string;
}) {
  return (
    <div className="split-workspace w-full min-w-0">
      <div className={`split-workspace-grid grid min-w-0 items-start gap-4${balance === 'details' ? ' split-workspace-details' : ''}${stickyDetails ? ' split-workspace-sticky' : ''}`}>
        <section aria-label={formTitle} className="min-w-0">{form}</section>
        <section aria-label={detailsTitle} className="min-w-0">{details}</section>
      </div>
    </div>
  );
}
