import { getApAgingReport } from '@shareat/domain';
import { apRepo } from '@shareat/db';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { AgingFilters } from '@/components/reports/AgingFilters';
import { ApAgingTable, ApAgingReconciliationIndicator, type ApAgingTableRow } from '@/components/reports/ApAgingTable';
import { CsvExportLink } from '@/components/reports/CsvExportLink';

export const metadata = { title: 'AP Aging — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

interface SearchParams {
  // ⛔ No `org` — DEF-064. The organisation comes from the session, never the URL.
  store?: string;
  asOf?: string;
}

export default async function ApAgingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // AR/AP aging is a store-operational report — the income statement's audience
  // (view_financial_reports), not the trial balance's admin-only one (T-209b spec).
  const scope = await reportScope('/reports/ap-aging', 'view_financial_reports', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  const storeId = scope.storeId;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const asOfDate = sp.asOf ?? toBusinessDate();

  const { report, supplierNames } = await runReport(orgId, async (tx) => {
    const [report, suppliers] = await Promise.all([
      getApAgingReport(tx, { orgId, storeId, asOfDate }),
      apRepo.listSuppliers(tx, orgId, { includeInactive: true }),
    ]);
    return { report, supplierNames: new Map(suppliers.map((s) => [s.id, s.name])) };
  });

  const rows: ApAgingTableRow[] = report.rows.map((r) => ({
    supplierId: r.supplierId,
    supplierName: supplierNames.get(r.supplierId) ?? r.supplierId,
    current: r.current,
    d1to30: r.d1to30,
    d31to60: r.d31to60,
    d61to90: r.d61to90,
    d90plus: r.d90plus,
    total: r.total,
  }));

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">AP Aging</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Every open payable, bucketed by due date. The total below is checked against the
          2110 control account on every load — two independent queries that must agree to the
          centavo.
        </p>
      </div>

      <AgingFilters
        basePath="/reports/ap-aging"
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
          href={`/reports/ap-aging/export?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), asOf: asOfDate }).toString()}`}
        />
      </div>

      <ApAgingReconciliationIndicator
        reconciles={report.reconciles}
        agingTotal={report.totals.total}
        controlBalance={report.controlBalance}
      />

      {rows.length > 0 ? (
        <ApAgingTable rows={rows} totals={report.totals} />
      ) : (
        <EmptyState message={`No open payables as of ${asOfDate}.`} />
      )}
    </main>
  );
}
