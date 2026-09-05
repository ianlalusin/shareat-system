import { getApAgingReport, getArAgingReport, getBalanceSheet, getIncomeStatement, getSalesRollup } from '@shareat/domain';
import { cashRequestsRepo, employmentRepo, lowStockRepo } from '@shareat/db';
import { add, formatMoney } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { reportScope, runReport } from './reports/lib';
import { findingsFor, lastCompletedPeriod } from './findings/lib';
import { SalesChannelTable } from '@/components/reports/SalesRollupTable';
import { EmptyState } from '@/components/reports/EmptyState';
import { Tile } from '@/components/dashboard/Tile';
import { RangeForm } from '@/components/dashboard/RangeForm';

export const metadata = { title: 'Dashboard — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

interface SearchParams {
  // ⛔ No `org` — DEF-064. The organisation comes from the session, never the URL.
  store?: string;
  from?: string;
  to?: string;
}

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

/**
 * T-211. The manager/owner dashboard — every figure here calls the SAME named query function its
 * own report page calls (grep for a second definition of any of these and it should come back
 * empty). No `FieldValue.increment`-shaped table, no cache, no realtime listener — see
 * `docs/tasks/211-manager-owner-dashboard.md` and PROJECT_BIBLE.md §4.2 rule 7.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const scope = await reportScope('/', 'view_financial_reports', sp.store);
  const orgId = scope.actor.orgId;
  const storeId = scope.storeId ?? null;
  const storesInScope = scope.storeId ? scope.stores.filter((s) => s.id === scope.storeId) : scope.stores;

  const today = toBusinessDate();
  const fromDate = sp.from ?? firstOfMonth(today);
  const toDate = sp.to ?? today;
  const period = lastCompletedPeriod();

  const [
    { incomeStatement, balanceSheet, arAging, apAging, salesRollup, activeStaff, lowStock, openFloats },
    { feed },
  ] = await Promise.all([
    runReport(orgId, async (tx) => {
      const [incomeStatement, balanceSheet, arAging, apAging, salesRollup, activeStaffRows, lowStockRows, floats] =
        await Promise.all([
          getIncomeStatement(tx, { orgId, storeId, fromDate, toDate }),
          getBalanceSheet(tx, { orgId, storeId, asOfDate: today }),
          getArAgingReport(tx, { orgId, storeId, asOfDate: today }),
          getApAgingReport(tx, { orgId, storeId, asOfDate: today }),
          getSalesRollup(tx, { orgId, storeId, fromDate, toDate, groupBy: 'month' }),
          Promise.all(storesInScope.map((s) => employmentRepo.listActiveRoster(tx, s.id))),
          Promise.all(storesInScope.map((s) => lowStockRepo.lowStock(tx, orgId, s.id))),
          cashRequestsRepo.openFloats(tx, orgId),
        ]);
      const storeIds = new Set(storesInScope.map((s) => s.id));
      return {
        incomeStatement,
        balanceSheet,
        arAging,
        apAging,
        salesRollup,
        activeStaff: activeStaffRows.reduce((n, rows) => n + rows.length, 0),
        lowStock: lowStockRows.reduce((n, rows) => n + rows.length, 0),
        openFloats: floats.filter((f) => storeIds.has(f.storeId)).length,
      };
    }),
    findingsFor(orgId, period),
  ]);

  const hardFindingsOpen = feed.findings.filter((f) => f.severity === 'hard' && f.status === 'open').length;
  const totalExpenses = add(incomeStatement.costOfSales, incomeStatement.operatingExpenses);
  const liabilitiesAndEquity = add(balanceSheet.liabilities, balanceSheet.equity);
  const storeLabel = scope.storeId
    ? (storesInScope[0] ? `${storesInScope[0].name} (${storesInScope[0].code})` : scope.storeId)
    : 'All stores';

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          {scope.orgName} ({scope.orgCode}) · {storeLabel}. Every figure below is a live query, the
          same one its own report page runs — never a stored counter.
        </p>
      </div>

      <RangeForm
        stores={scope.stores.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={scope.storeId}
        fromDate={fromDate}
        toDate={toDate}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile
          label="Sales"
          value={formatMoney(incomeStatement.revenue)}
          basis={`${fromDate} to ${toDate}`}
          href="/reports/income-statement"
        />
        <Tile
          label="Expenses"
          value={formatMoney(totalExpenses)}
          basis={`${fromDate} to ${toDate}`}
          href="/reports/income-statement"
        />
        <Tile
          label="Net income"
          value={formatMoney(incomeStatement.netIncome)}
          basis={`${fromDate} to ${toDate}`}
          href="/reports/income-statement"
          tone="neutral"
        />
        <Tile
          label="Balance sheet"
          value={formatMoney(balanceSheet.assets)}
          basis={`${balanceSheet.ties ? 'Ties' : 'DOES NOT TIE'} · liabilities + equity ${formatMoney(liabilitiesAndEquity)} · as of ${today}`}
          href="/reports/balance-sheet"
          tone={balanceSheet.ties ? 'ok' : 'warn'}
        />
        <Tile
          label="AR outstanding"
          value={formatMoney(arAging.totals.total)}
          basis={`as of ${today}`}
          href="/reports/ar-aging"
        />
        <Tile
          label="AP outstanding"
          value={formatMoney(apAging.totals.total)}
          basis={`as of ${today}`}
          href="/reports/ap-aging"
        />
        <Tile label="Active staff" value={String(activeStaff)} basis="right now" href="/staff" />
        <Tile
          label="Cash-request floats open"
          value={String(openFloats)}
          basis="right now"
          href="/cash-requests"
        />
        <Tile
          label="Findings needing attention"
          value={String(hardFindingsOpen)}
          basis={`hard, open · ${period}`}
          href="/findings"
          tone={hardFindingsOpen > 0 ? 'warn' : 'ok'}
        />
        <Tile
          label="Low stock"
          value={String(lowStock)}
          basis="right now"
          href="/inventory/low-stock"
          tone={lowStock > 0 ? 'warn' : 'ok'}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Sales by channel</h2>
        {salesRollup.channels.length > 0 ? (
          <SalesChannelTable rows={salesRollup.channels} total={salesRollup.channelTotal} />
        ) : (
          <EmptyState message={`No sales ${fromDate} to ${toDate}.`} />
        )}
      </section>
    </main>
  );
}
