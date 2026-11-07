/**
 * T-526 - what a POS tab shows until its own screen is built. Staff words only: no task numbers, no frame talk (T-526b).
 * A plain server-safe component: no hooks, no state.
 */
export function SlicePlaceholder({ title, message, children }: { title: string; message: string; children?: React.ReactNode }) {
  // An id is a slug (letters, digits, hyphens), never the words of the title.
  const id = `pos-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="mx-auto max-w-xl rounded-2xl border border-surface-border bg-surface p-6">
      <h1 id={id} className="text-xl font-semibold">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted">{message}</p>
      {children}
    </section>
  );
}
