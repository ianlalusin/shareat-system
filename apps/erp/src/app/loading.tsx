import { Page } from '@/components/shell/Page';

/** Shared route fallback: no synthetic balances, names or document statuses while data loads. */
export default function Loading() {
  return (
    <Page density="wide">
      <div role="status" aria-label="Loading page" className="min-w-0 space-y-4">
        <span className="sr-only">Loading page…</span>
        <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
          <div className="h-6 w-1/3 rounded bg-surface-border" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((key) => (
              <div key={key} className="min-w-0 space-y-3 rounded-lg border border-surface-border p-4">
                <div className="h-3 w-1/2 rounded bg-surface-border" />
                <div className="h-5 w-2/3 rounded bg-surface-border" />
                <div className="h-3 w-full rounded bg-surface-border" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Page>
  );
}
