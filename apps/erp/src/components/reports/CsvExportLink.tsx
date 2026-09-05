/**
 * The one shared CSV export control — T-209c. Every report page builds its own `href` (its
 * export route plus the same query params the page itself is showing) and hands it here; the
 * formatting logic lives once, in `apps/erp/src/lib/csv.ts`, on the SERVER route this links to.
 */
export function CsvExportLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="rounded border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      Download CSV
    </a>
  );
}
