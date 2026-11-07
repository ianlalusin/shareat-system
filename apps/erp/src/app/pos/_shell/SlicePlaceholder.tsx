/**
 * T-526 - what a POS tab shows until its own slice is built. Names the slice so nobody mistakes the empty card for a bug.
 * A plain server-safe component: no hooks, no state.
 */
export function SlicePlaceholder({ title, slice, children }: { title: string; slice: string; children?: React.ReactNode }) {
  // An id is a slug (letters, digits, hyphens), never the words of the title: `slice` can be "a later slice".
  const id = `pos-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="mx-auto max-w-xl rounded-2xl border border-surface-border bg-surface p-6">
      <h1 id={id} className="text-xl font-semibold">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted">This screen is built in {slice}. The POS frame around it (tabs, status, sign-in) is live.</p>
      {children}
    </section>
  );
}
