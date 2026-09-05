import Link from 'next/link';

/**
 * Drill-down from a report line to its journal entries — T-209c. Every account-row report
 * (trial balance, income statement, balance sheet) wraps its account cell in this, carrying the
 * SAME filter the report itself is showing so the drill-down total never disagrees with the line
 * that linked to it.
 */
export function AccountDrillLink({
  accountId,
  accountCode,
  accountName,
  storeId,
  fromDate,
  toDate,
  includeYearClose,
  children,
}: {
  accountId: string;
  /** Carried through as query params so the drill-down screen needs no second lookup for
   *  display — the linking page already has these in scope. */
  accountCode: string | null;
  accountName: string;
  storeId?: string | null;
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
  children: React.ReactNode;
}) {
  const params = new URLSearchParams({
    account: accountId,
    name: accountName,
    from: fromDate,
    to: toDate,
    yearClose: includeYearClose ? 'include' : 'exclude',
  });
  if (accountCode) params.set('code', accountCode);
  if (storeId) params.set('store', storeId);

  return (
    <Link href={`/reports/journal-lines?${params.toString()}`} className="hover:underline">
      {children}
    </Link>
  );
}
