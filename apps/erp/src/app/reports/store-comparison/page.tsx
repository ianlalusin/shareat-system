import { getStorePLComparison } from '@shareat/domain';
import { authorize } from '@shareat/auth';
import { storesRepo } from '@shareat/db';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import { StoreComparisonTable, type StoreComparisonColumn } from '@/components/reports/StoreComparisonTable';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Button, Checkbox, Input } from '@/components/ui';

export const metadata = { title: 'Store Comparison — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

interface SearchParams {
  /** Repeated `?stores=<id>&stores=<id>` — a real HTML multi-checkbox needs no JS to submit this
   *  shape; Next's searchParams gives an array when a key repeats. */
  stores?: string | string[];
  from?: string;
  to?: string;
  yearClose?: string;
}

export default async function StoreComparisonPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // ⚠️ Never pass a single `requestedStoreId` here — this screen compares MULTIPLE stores at
  // once, so `scope.stores` (every store this person may see) is the candidate list, and every
  // store actually selected for comparison is re-authorized explicitly below (T-209c) rather
  // than relying on reportScope's own single-store fallback, which only checks the FIRST store
  // for someone not scoped to the whole org (see ../lib.ts's authorizeForScope).
  const scope = await reportScope('/reports/store-comparison', 'view_financial_reports', undefined);
  const orgId = scope.actor.orgId;

  const requestedIds = sp.stores ? (Array.isArray(sp.stores) ? sp.stores : [sp.stores]) : [];
  const candidateIds = new Set(scope.stores.map((s) => s.id));
  const selectedIds = (requestedIds.length > 0 ? requestedIds : scope.stores.map((s) => s.id)).filter((id) => candidateIds.has(id));

  const today = toBusinessDate();
  const fromDate = sp.from ?? firstOfMonth(today);
  const toDate = sp.to ?? today;
  const includeYearClose = sp.yearClose === 'include';

  const stores = await runReport(orgId, async (tx) => {
    for (const storeId of selectedIds) {
      await authorize(tx, scope.actor, 'view_financial_reports', { storeId });
    }
    return getStorePLComparison(tx, { orgId, storeIds: selectedIds, fromDate, toDate, includeYearClose });
  });

  const storeName = new Map(scope.stores.map((s) => [s.id, `${s.name} (${s.code})`]));
  // T-346 S3 (DEF-428), §3.5 / R6.3 — the same three states as the `/admin/stores` list badge
  // (`admin/stores/page.tsx`, Amendment R3.3), never re-derived as a looser two-state version.
  // Figures are unaffected either way (pre-opening costs are expensed, not capitalised, PAS 16 ¶19).
  const columns: StoreComparisonColumn[] = stores.stores.map((s) => ({
    storeId: s.storeId,
    storeName: storeName.get(s.storeId) ?? s.storeId,
    openingLabel:
      s.openingDate === null
        ? 'Not yet open — no opening date set'
        : storesRepo.isPreOpening(s.openingDate, today)
          ? `Opens ${s.openingDate}`
          : `Opened ${s.openingDate}`,
    revenue: s.statement.revenue,
    costOfSales: s.statement.costOfSales,
    grossProfit: s.statement.grossProfit,
    operatingExpenses: s.statement.operatingExpenses,
    operatingIncome: s.statement.operatingIncome,
    otherIncomeExpense: s.statement.otherIncomeExpense,
    netIncome: s.statement.netIncome,
  }));

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">Store Comparison</h1>
        <PageDescription>
          Each store's income statement, side by side — every figure calls the same
          `getIncomeStatement` the single-store screen does, never a second definition of the same
          number.
        </PageDescription>
      </div>

      <form method="GET" action="/reports/store-comparison" className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Stores</legend>
          <div className="flex flex-wrap gap-3">
            {scope.stores.map((s) => (
              /* Same `name` on every box — a plain HTML form submits repeated
               *  `stores=<id>` params with no JS needed; searchParams reads that back as an
               *  array. */
              <Checkbox
                key={s.id}
                name="stores"
                value={s.id}
                defaultChecked={selectedIds.includes(s.id)}
                label={`${s.name} (${s.code})`}
              />
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">From</span>
          <Input type="date" name="from" defaultValue={fromDate} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">To</span>
          <Input type="date" name="to" defaultValue={toDate} />
        </label>
        <Button type="submit" variant="primary">
          Apply
        </Button>
      </form>

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">{scope.orgName} ({scope.orgCode})</span>
          {' · '}
          {fromDate} to {toDate}
          {' · '}
          year-close entry {includeYearClose ? 'included' : 'excluded'}
        </p>
        <CsvExportLink
          href={(() => {
            const params = new URLSearchParams({ from: fromDate, to: toDate, yearClose: includeYearClose ? 'include' : 'exclude' });
            for (const id of selectedIds) params.append('stores', id);
            return `/reports/store-comparison/export?${params.toString()}`;
          })()}
        />
      </div>

      {columns.length > 0 ? (
        <StoreComparisonTable stores={columns} />
      ) : (
        <EmptyState message="No stores selected." />
      )}
    </Page>
  );
}
