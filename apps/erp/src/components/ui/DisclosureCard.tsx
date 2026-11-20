import type { ReactNode } from 'react';

/**
 * Native disclosure: the form stays mounted, and opening works without JavaScript.
 * Callers that pass none of `action: null` / `meta` / `open` / `className` render the original markup.
 */
export function DisclosureCard({ id, title, action = 'Add', open, meta, className, children }: {
  readonly id: string;
  readonly title: string;
  /** null: no "+ Add" chip; a chevron that turns when open (a fold, not an add). */
  readonly action?: string | null;
  /** Start open: a typed refill, a pending confirm, an error, or the one thing to act on now. */
  readonly open?: boolean;
  /** Muted text after the title, so a closed card still says what is inside. */
  readonly meta?: ReactNode;
  /** Appended to the outer classes (a tone border, e.g. the next opening-balance step). */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const fold = action === null;
  const outer = ['erp-disclosure-card rounded-lg border border-surface-border p-3', fold ? 'group' : '', className ?? ''].filter(Boolean).join(' ');
  return <details id={id} open={open} className={outer}>
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
      {fold || meta !== undefined
        ? <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <span>{title}</span>
            {meta !== undefined && <span className="text-xs text-muted font-normal">{meta}</span>}
          </span>
        : <span>{title}</span>}
      {fold
        ? <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-neutral-500 transition-transform group-open:rotate-90"><path d="M7 5l5 5-5 5" /></svg>
        : <span className="erp-disclosure-action inline-flex min-h-11 min-w-14 items-center justify-center gap-2 rounded-lg border border-field-border px-3">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            <span>{action}</span>
          </span>}
    </summary>
    <div className="mt-3 space-y-3">{children}</div>
  </details>;
}
