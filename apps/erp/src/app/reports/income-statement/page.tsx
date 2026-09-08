import { getIncomeStatement } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { IncomeStatementTable } from '@/components/reports/IncomeStatementTable';
import { ReportBasis } from '@/components/reports/ReportBasis';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Income Statement — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

interface SearchParams {
  // ⛔ No `org` — DEF-064. The organisation comes from the session, never the URL.
  store?: string;
  from?: string;
  to?: string;
  yearClose?: string;
}

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // ⛔ DEF-064 — see ../lib.ts. Org from the session, stores from person_store_scope,
  // `sp.org` deliberately ignored.
  const scope = await reportScope('/reports/income-statement', 'view_financial_reports', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  const storeId = scope.storeId;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const today = toBusinessDate();
  const fromDate = sp.from ?? firstOfMonth(today);
  const toDate = sp.to ?? today;
  // Income statement defaults to EXCLUDING the year-close entry — ADR-006: "a date-range
  // P&L must be able to exclude it" (packages/domain/src/reports/income-statement.ts's
  // own top comment). Opposite default from the trial balance, deliberately.
  const includeYearClose = sp.yearClose === 'include' ? true : sp.yearClose === 'exclude' ? false : false;

  const result = await runReport(orgId, (tx) =>
    getIncomeStatement(tx, { orgId, storeId, fromDate, toDate, includeYearClose }),
  );

  const hasAnyActivity =
    result.revenueLines.length > 0 ||
    result.costOfSalesLines.length > 0 ||
    result.operatingExpenseLines.length > 0 ||
    result.otherIncomeExpenseLines.length > 0;

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">Income Statement</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          A GROUP BY query over journal_lines — a new revenue or expense account appears
          here automatically, with no code change.
        </p>
      </div>

      <ReportFilters
        basePath="/reports/income-statement"
        orgs={[{ id: orgId, label: `${scope.orgName} (${scope.orgCode})` }]}
        currentOrgId={orgId}
        stores={storeRows.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={storeId}
        fromDate={fromDate}
        toDate={toDate}
        includeYearClose={includeYearClose}
        yearCloseHelp="Defaults to excluded — a date-range P&L excludes the year-close entry (ADR-006)."
      />

      <div className="flex items-center justify-between gap-4">
        <ReportBasis
          orgLabel={`${scope.orgName} (${scope.orgCode})`}
          storeLabel={currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
          fromDate={fromDate}
          toDate={toDate}
          includeYearClose={includeYearClose}
        />
        <CsvExportLink
          href={`/reports/income-statement/export?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), from: fromDate, to: toDate, yearClose: includeYearClose ? 'include' : 'exclude' }).toString()}`}
        />
      </div>

      {hasAnyActivity ? (
        <IncomeStatementTable
          revenueLines={result.revenueLines}
          revenue={result.revenue}
          costOfSalesLines={result.costOfSalesLines}
          costOfSales={result.costOfSales}
          grossProfit={result.grossProfit}
          operatingExpenseLines={result.operatingExpenseLines}
          operatingExpenses={result.operatingExpenses}
          operatingIncome={result.operatingIncome}
          otherIncomeExpenseLines={result.otherIncomeExpenseLines}
          otherIncomeExpense={result.otherIncomeExpense}
          netIncome={result.netIncome}
          storeId={storeId}
          fromDate={fromDate}
          toDate={toDate}
          includeYearClose={includeYearClose}
        />
      ) : (
        <EmptyState message={`No entries for ${fromDate} to ${toDate}.`} />
      )}
    </Page>
  );
}
