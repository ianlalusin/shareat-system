/**
 * States the report's basis — docs/tasks/110-reporting-views-and-screens.md Contract §5:
 * "Both must state their basis: the date range, which stores, and whether the year-close
 * entry is included. A report that does not say what it covers is how a number gets
 * quoted out of context."
 *
 * Plain YYYY-MM-DD strings throughout — these are already business dates (Postgres
 * `date` columns, never a `Date`/timestamp), so there is nothing to format and nothing
 * that could shift by timezone (bible landmine: never format a date on the server without
 * pinning a timezone). Deliberately not using `Intl.DateTimeFormat`/`toLocaleDateString`
 * here — YYYY-MM-DD is unambiguous and locale-proof, which a "nicer-looking" formatted
 * date would give up for no real benefit on a screen about correctness.
 */
export function ReportBasis({
  orgLabel,
  storeLabel,
  fromDate,
  toDate,
  includeYearClose,
}: {
  orgLabel: string;
  storeLabel: string;
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
}) {
  return (
    <p className="text-sm text-neutral-600 dark:text-neutral-400">
      <span className="font-medium text-neutral-800 dark:text-neutral-200">{orgLabel}</span>
      {' · '}
      {storeLabel}
      {' · '}
      {fromDate} to {toDate}
      {' · '}
      year-close entry {includeYearClose ? 'included' : 'excluded'}
    </p>
  );
}
