import { getArAgingReport } from '@shareat/domain';
import { customersRepo } from '@shareat/db';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { AgingFilters } from '@/components/reports/AgingFilters';
import { ArAgingTable, ArAgingReconciliationIndicator, type ArAgingTableRow } from '@/components/reports/ArAgingTable';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'AR Aging — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

interface SearchParams {
  // ⛔ No `org` — DEF-064. The organisation comes from the session, never the URL.
  store?: string;
  asOf?: string;
}

export default async function ArAgingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // Same audience as AP aging (T-209b spec) — view_financial_reports, not view_trial_balance.
  const scope = await reportScope('/reports/ar-aging', 'view_financial_reports', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  const storeId = scope.storeId;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const asOfDate = sp.asOf ?? toBusinessDate();

  const { report, customerNames } = await runReport(orgId, async (tx) => {
    const [report, customers] = await Promise.all([
      getArAgingReport(tx, { orgId, storeId, asOfDate }),
      customersRepo.listCustomers(tx, orgId),
    ]);
    return { report, customerNames: new Map(customers.map((c) => [c.id, c.name])) };
  });

  const rows: ArAgingTableRow[] = report.rows.map((r) => ({
    customerId: r.customerId,
    customerName: customerNames.get(r.customerId) ?? r.customerId,
    current: r.current,
    d1to30: r.d1to30,
    d31to60: r.d31to60,
    d61to90: r.d61to90,
    d90plus: r.d90plus,
    total: r.total,
  }));

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">AR Aging</h1>
        <PageDescription>
          Every open receivable, bucketed by due date. The total below is checked against the
          1210 control account on every load — two independent queries that must agree to the
          centavo.
        </PageDescription>
      </div>

      <AgingFilters
        basePath="/reports/ar-aging"
        orgs={[{ id: orgId, label: `${scope.orgName} (${scope.orgCode})` }]}
        currentOrgId={orgId}
        stores={storeRows.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={storeId}
        asOfDate={asOfDate}
      />

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">{scope.orgName} ({scope.orgCode})</span>
          {' · '}
          {currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
          {' · '}
          as of {asOfDate}
        </p>
        <CsvExportLink
          href={`/reports/ar-aging/export?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), asOf: asOfDate }).toString()}`}
        />
      </div>

      <ArAgingReconciliationIndicator
        reconciles={report.reconciles}
        agingTotal={report.totals.total}
        controlBalance={report.controlBalance}
      />

      {rows.length > 0 ? (
        <ArAgingTable rows={rows} totals={report.totals} />
      ) : (
        <EmptyState message={`No open receivables as of ${asOfDate}.`} />
      )}
    </Page>
  );
}
