import { getCashFlow } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { ReportBasis } from '@/components/reports/ReportBasis';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import { CashFlowTable, CashFlowReconciliationIndicator } from '@/components/reports/CashFlowTable';

export const metadata = { title: 'Cash Flow — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

interface SearchParams {
  store?: string;
  from?: string;
  to?: string;
  yearClose?: string;
}

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // Same audience as the income statement (T-209c) — view_financial_reports.
  const scope = await reportScope('/reports/cash-flow', 'view_financial_reports', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  const storeId = scope.storeId;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const today = toBusinessDate();
  const fromDate = sp.from ?? firstOfMonth(today);
  const toDate = sp.to ?? today;
  // Defaults to EXCLUDING the year-close entry — same reasoning as the income statement
  // (packages/domain/src/reports/cash-flow.ts's own top comment).
  const includeYearClose = sp.yearClose === 'include' ? true : sp.yearClose === 'exclude' ? false : false;

  const result = await runReport(orgId, (tx) =>
    getCashFlow(tx, { orgId, storeId, fromDate, toDate, includeYearClose }),
  );

  const hasAnyActivity =
    result.operatingLines.length > 0 || result.investingLines.length > 0 || result.financingLines.length > 0 || result.netIncome !== '0.00';

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Cash Flow</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Indirect method — net income, adjusted for non-cash items and working-capital changes,
          computed live from balance-sheet account deltas. Checked against the actual change in
          cash and cash-equivalent balances on every load.
        </p>
      </div>

      <ReportFilters
        basePath="/reports/cash-flow"
        orgs={[{ id: orgId, label: `${scope.orgName} (${scope.orgCode})` }]}
        currentOrgId={orgId}
        stores={storeRows.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={storeId}
        fromDate={fromDate}
        toDate={toDate}
        includeYearClose={includeYearClose}
        yearCloseHelp="Defaults to excluded — matches the income statement's own date-range default (ADR-006)."
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
          href={`/reports/cash-flow/export?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), from: fromDate, to: toDate, yearClose: includeYearClose ? 'include' : 'exclude' }).toString()}`}
        />
      </div>

      <CashFlowReconciliationIndicator
        reconciles={result.reconciles}
        netChangeInCash={result.netChangeInCash}
        actualCashChange={result.actualCashChange}
      />

      {hasAnyActivity ? (
        <CashFlowTable
          netIncome={result.netIncome}
          operatingLines={result.operatingLines}
          operating={result.operating}
          investingLines={result.investingLines}
          investing={result.investing}
          financingLines={result.financingLines}
          financing={result.financing}
          netChangeInCash={result.netChangeInCash}
        />
      ) : (
        <EmptyState message={`No entries for ${fromDate} to ${toDate}.`} />
      )}
    </main>
  );
}
