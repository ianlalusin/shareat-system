import { getApAgingReport, getArAgingReport, getBalanceSheet, getIncomeStatement, getSalesRollup } from '@shareat/domain';
import { cashRequestsRepo, commissaryKpisRepo, employmentRepo, lowStockRepo } from '@shareat/db';
import { add, formatMoney, money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { reportScope, runReport } from './reports/lib';
import { findingsFor, lastCompletedPeriod } from './findings/lib';
import { SalesChannelTable } from '@/components/reports/SalesRollupTable';
import { EmptyState } from '@/components/reports/EmptyState';
import { Tile } from '@/components/dashboard/Tile';
import { RangeForm } from '@/components/dashboard/RangeForm';
import { Page } from '@/components/shell/Page';

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
    {
      incomeStatement, balanceSheet, arAging, apAging, salesRollup, activeStaff, lowStock, openFloats,
      inFlight, disputes, received,
    },
    { feed },
  ] = await Promise.all([
    runReport(orgId, async (tx) => {
      const [
        incomeStatement, balanceSheet, arAging, apAging, salesRollup, activeStaffRows, lowStockRows, floats,
        inFlight, disputes, received,
      ] = await Promise.all([
          getIncomeStatement(tx, { orgId, storeId, fromDate, toDate }),
          getBalanceSheet(tx, { orgId, storeId, asOfDate: today }),
          getArAgingReport(tx, { orgId, storeId, asOfDate: today }),
          getApAgingReport(tx, { orgId, storeId, asOfDate: today }),
          getSalesRollup(tx, { orgId, storeId, fromDate, toDate, groupBy: 'month' }),
          Promise.all(storesInScope.map((s) => employmentRepo.listActiveRoster(tx, s.id))),
          Promise.all(storesInScope.map((s) => lowStockRepo.lowStock(tx, orgId, s.id))),
          cashRequestsRepo.openFloats(tx, orgId),
          // ⭐ T-212. No per-store loop: unlike `lowStock`, these three take `storeId: null` as
          // "org-wide" in one query, and `reportScope` only ever yields an undefined `storeId` to
          // somebody scoped to the whole org (`coversWholeOrg`), so the widening is authorised.
          commissaryKpisRepo.inFlightOrders(tx, { orgId, storeId }),
          commissaryKpisRepo.openDisputes(tx, { orgId, storeId }),
          commissaryKpisRepo.receivedInRange(tx, { orgId, storeId, fromDate, toDate }),
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
        inFlight,
        disputes,
        received,
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

  // ---- T-212: commissary KPIs -----------------------------------------------------------------
  const inFlightCount = inFlight.reduce((n, r) => n + r.orderCount, 0);
  const inFlightBasis =
    inFlight.length > 0
      ? `${inFlight.map((r) => `${r.orderCount} ${r.stage === 'submitted' ? 'awaiting dispatch' : r.stage}`).join(' · ')} · right now`
      : 'nothing in transit · right now';

  // ⚠️ "at cost" is not decoration — `trade_discrepancies.value` is the un-received share of
  // dispatch COST, not the transfer rate (DEF-175). A tile that just says ₱ invites the reader to
  // compare it against the transfer-rate figure beside it, which is the mistake the DEF records.
  const disputeBasis =
    disputes.count > 0
      ? `oldest ${disputes.oldestAgeDays}d · ${formatMoney(money(disputes.totalValue))} stranded at cost` +
        (disputes.buckets.overdue > 0 ? ` · ${disputes.buckets.overdue} past 15 days` : '') +
        (disputes.deferredCount > 0 ? ` · ${disputes.deferredCount} deferred` : '')
      : 'none open · right now';

  // ⭐ The gap is SHOWN, not just corrected away — v1 reports the dispatched figure and calls it
  // received. Stating both is what makes the correction legible instead of merely invisible.
  const receivedExtras = [
    Number(received.shortReceivedValue) !== 0
      ? `${formatMoney(money(received.shortReceivedValue))} short`
      : null,
    Number(received.unrecordedValue) !== 0
      ? `${formatMoney(money(received.unrecordedValue))} no receipt recorded`
      : null,
  ].filter(Boolean);
  const receivedBasis =
    `${received.orderCount} order${received.orderCount === 1 ? '' : 's'} · ${fromDate} to ${toDate}` +
    (receivedExtras.length > 0
      ? ` · of ${formatMoney(money(received.goodsDispatchedValue))} dispatched: ${receivedExtras.join(', ')}`
      : '');

  return (
    <Page density="wide">
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
        <Tile
          label="Commissary in flight"
          value={String(inFlightCount)}
          basis={inFlightBasis}
          href="/commissary/orders"
        />
        <Tile
          label="Open disputes"
          value={String(disputes.count)}
          basis={disputeBasis}
          href="/commissary/discrepancies"
          tone={disputes.buckets.overdue > 0 ? 'warn' : disputes.count > 0 ? 'neutral' : 'ok'}
        />
        <Tile
          label="Received from commissary"
          value={formatMoney(money(received.goodsReceivedValue))}
          basis={receivedBasis}
          href="/commissary/orders"
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
    </Page>
  );
}
