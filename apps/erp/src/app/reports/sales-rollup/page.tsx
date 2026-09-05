import { getSalesRollup } from '@shareat/domain';
import { reportsRepo } from '@shareat/db';
import { reportScope, runReport } from '../lib';

type SalesRollupGrouping = reportsRepo.SalesRollupGrouping;
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import {
  SalesChannelTable,
  SalesModeTable,
  SalesPeriodTable,
  SalesReconciliationIndicator,
  type SalesPeriodRow,
} from '@/components/reports/SalesRollupTable';

export const metadata = { title: 'Sales Rollup — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

interface SearchParams {
  store?: string;
  from?: string;
  to?: string;
  groupBy?: string;
}

function isGrouping(v: string | undefined): v is SalesRollupGrouping {
  return v === 'day' || v === 'month' || v === 'store';
}

export default async function SalesRollupPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const scope = await reportScope('/reports/sales-rollup', 'view_financial_reports', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  const storeId = scope.storeId;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const today = toBusinessDate();
  const fromDate = sp.from ?? firstOfMonth(today);
  const toDate = sp.to ?? today;
  const groupBy: SalesRollupGrouping = isGrouping(sp.groupBy) ? sp.groupBy : 'day';

  const result = await runReport(orgId, (tx) => getSalesRollup(tx, { orgId, storeId, fromDate, toDate, groupBy }));

  const storeNameById = new Map(storeRows.map((s) => [s.id, `${s.name} (${s.code})`]));
  const periods: SalesPeriodRow[] = result.periods.map((p) => ({
    period: p.period,
    storeId: p.storeId,
    storeName: p.storeId ? storeNameById.get(p.storeId) ?? p.storeId : undefined,
    total: p.total,
  }));

  const hasAnyActivity = periods.length > 0;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Sales Rollup</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Recognised sales revenue (verified sales days only), by period, channel, and mode.
          Every total below is computed live and checked against the other two, which are sourced
          independently.
        </p>
      </div>

      <form
        method="GET"
        action="/reports/sales-rollup"
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId ?? ''} className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950">
            <option value="">All stores</option>
            {storeRows.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">From</span>
          <input type="date" name="from" defaultValue={fromDate} className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">To</span>
          <input type="date" name="to" defaultValue={toDate} className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Group by</span>
          <select name="groupBy" defaultValue={groupBy} className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950">
            <option value="day">Day</option>
            <option value="month">Month</option>
            <option value="store">Store</option>
          </select>
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
          Apply
        </button>
      </form>

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">{scope.orgName} ({scope.orgCode})</span>
          {' · '}
          {currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
          {' · '}
          {fromDate} to {toDate}
          {' · '}
          grouped by {groupBy}
        </p>
        <CsvExportLink
          href={`/reports/sales-rollup/export?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), from: fromDate, to: toDate, groupBy }).toString()}`}
        />
      </div>

      <SalesReconciliationIndicator
        reconciles={result.reconciles}
        ledgerTotal={result.ledgerTotal}
        channelTotal={result.channelTotal}
        modeTotal={result.modeTotal}
      />

      {hasAnyActivity ? (
        <>
          <SalesPeriodTable rows={periods} total={result.ledgerTotal} />
          <div className="grid gap-6 sm:grid-cols-2">
            <SalesChannelTable rows={result.channels} total={result.channelTotal} />
            <SalesModeTable rows={result.modes} total={result.modeTotal} />
          </div>
        </>
      ) : (
        <EmptyState message={`No verified sales days for ${fromDate} to ${toDate}.`} />
      )}
    </main>
  );
}
