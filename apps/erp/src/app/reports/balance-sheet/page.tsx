import { getBalanceSheet } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { add } from '@shareat/core/money';
import { EmptyState } from '@/components/reports/EmptyState';
import { ReportBasis } from '@/components/reports/ReportBasis';
import { BalanceSheetFilters } from '@/components/reports/BalanceSheetFilters';
import { BalanceSheetTable, BalanceSheetTieIndicator } from '@/components/reports/BalanceSheetTable';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Balance Sheet — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

interface SearchParams {
  // ⛔ No `org` — DEF-064. The organisation comes from the session, never the URL.
  store?: string;
  asOf?: string;
  yearClose?: string;
}

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // ⛔ DEF-064 — see ../lib.ts. Org from the session, stores from person_store_scope,
  // `sp.org` deliberately ignored. Reuses `view_trial_balance` (org-scoped, admin/
  // super_admin only) — a balance sheet is the trial balance's own audience and
  // sensitivity, not a store-operational report like the income statement (T-209a spec).
  const scope = await reportScope('/reports/balance-sheet', 'view_trial_balance', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  const storeId = scope.storeId;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const asOfDate = sp.asOf ?? toBusinessDate();
  // Balance sheet defaults to INCLUDING the year-close entry — ADR-006, same reasoning and
  // same default as the trial balance (packages/domain/src/reports/balance-sheet.ts).
  const includeYearClose = sp.yearClose === 'exclude' ? false : sp.yearClose === 'include' ? true : true;

  const result = await runReport(orgId, (tx) => getBalanceSheet(tx, { orgId, storeId, asOfDate, includeYearClose }));

  const hasAnyActivity = result.assetLines.length > 0 || result.liabilityLines.length > 0 || result.equityLines.length > 0;

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">Balance Sheet</h1>
        <PageDescription>
          Every figure below is computed live from journal_lines — nothing here is a stored
          total. &ldquo;Current period earnings&rdquo; is the running total of unclosed
          revenue and expense, folded into Equity so the equation ties on any date, not only
          right after a year-close.
        </PageDescription>
      </div>

      <BalanceSheetFilters
        basePath="/reports/balance-sheet"
        orgs={[{ id: orgId, label: `${scope.orgName} (${scope.orgCode})` }]}
        currentOrgId={orgId}
        stores={storeRows.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={storeId}
        asOfDate={asOfDate}
        includeYearClose={includeYearClose}
      />

      <div className="flex items-center justify-between gap-4">
        <ReportBasis
          orgLabel={`${scope.orgName} (${scope.orgCode})`}
          storeLabel={currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
          fromDate="Inception"
          toDate={asOfDate}
          includeYearClose={includeYearClose}
        />
        <CsvExportLink
          href={`/reports/balance-sheet/export?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), asOf: asOfDate, yearClose: includeYearClose ? 'include' : 'exclude' }).toString()}`}
        />
      </div>

      <BalanceSheetTieIndicator
        ties={result.ties}
        assets={result.assets}
        liabilitiesAndEquity={add(result.liabilities, result.equity)}
      />

      {hasAnyActivity ? (
        <BalanceSheetTable
          assetLines={result.assetLines}
          assets={result.assets}
          liabilityLines={result.liabilityLines}
          liabilities={result.liabilities}
          equityLines={result.equityLines}
          equity={result.equity}
          storeId={storeId}
          asOfDate={asOfDate}
          includeYearClose={includeYearClose}
        />
      ) : (
        <EmptyState message={`No entries as of ${asOfDate}.`} />
      )}
    </Page>
  );
}
