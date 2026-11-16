import { formatBusinessDayLong } from '@shareat/core/datetime';

/**
 * States the report's basis — docs/tasks/110-reporting-views-and-screens.md Contract §5:
 * "Both must state their basis: the date range, which stores, and whether the year-close
 * entry is included. A report that does not say what it covers is how a number gets
 * quoted out of context."
 *
 * The dates arrive as business dates (YYYY-MM-DD) and are shown in the one long en-PH form
 * (T-589 R3, "February 14, 2022") through `formatBusinessDayLong`, which pins Manila time so
 * nothing shifts by timezone. A value that is not a date ("Inception") passes through as is.
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
      {formatBusinessDayLong(fromDate)} to {formatBusinessDayLong(toDate)}
      {' · '}
      year-close entry {includeYearClose ? 'included' : 'excluded'}
    </p>
  );
}
