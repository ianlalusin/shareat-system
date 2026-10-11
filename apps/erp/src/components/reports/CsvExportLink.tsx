/**
 * The one shared CSV export control — T-209c. Every report page builds its own `href` (its
 * export route plus the same query params the page itself is showing) and hands it here; the
 * formatting logic lives once, in `apps/erp/src/lib/csv.ts`, on the SERVER route this links to.
 */
export function CsvExportLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
    >
      Download CSV
    </a>
  );
}
