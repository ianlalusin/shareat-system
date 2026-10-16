import { getApAgingReport, getArAgingReport, getBalanceSheet, getIncomeStatement, getSalesRollup, usageCheckScorecard } from '@shareat/domain';
import { attendanceDaysRepo, cashRequestsRepo, commissaryKpisRepo, lowStockRepo } from '@shareat/db';
import { add, compare, isZero, money, negate, subtract, ZERO } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import Link from 'next/link';
import { reportScope, runReport } from './reports/lib';
import { findingsFor, lastCompletedPeriod } from './findings/lib';
import { dayCount, eachDay, fmtNum, previousRange, resolveRange, shortDay } from './dashboard/lib';
import { EmptyState } from '@/components/reports/EmptyState';
import { RangeForm } from '@/components/dashboard/RangeForm';
import { HeroNumber } from '@/components/dashboard/HeroNumber';
import { SalesLine } from '@/components/dashboard/SalesLine';
import { StoreBars } from '@/components/dashboard/StoreBars';
import { ChannelDonut } from '@/components/dashboard/ChannelDonut';
import { OutlineCount } from '@/components/dashboard/OutlineCount';
import { RightNowBand } from '@/components/dashboard/RightNowBand';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Dashboard — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

interface SearchParams {
  // ⛔ No `org` — DEF-064. The organisation comes from the session, never the URL.
  store?: string;
  from?: string;
  to?: string;
  range?: string;
}

/**
 * T-211, restyled editorial in T-387 S5. The manager/owner dashboard — every figure here calls the
 * SAME named query function its own report page calls. No counter table, no cache, no realtime
 * listener (PROJECT_BIBLE.md §4.2 rule 7). The gate is unchanged: `reportScope(... 'view_financial_reports')`.
 * "On shift" is a count bound to the stores that gate allowed, never names.
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
  const storeIdList = storesInScope.map((s) => s.id);
  const showByStore = storesInScope.length > 1;

  const today = toBusinessDate();
  const { from: fromDate, to: toDate, preset } = resolveRange(sp, today);
  const prev = previousRange(fromDate, toDate);
  const days = dayCount(fromDate, toDate);
  const period = lastCompletedPeriod();

  const [
    { incomeStatement, balanceSheet, arAging, apAging, salesNow, salesPrev, salesByStore, lowStock, openFloats, onShift, inFlight, disputes, received, usageScorecard },
    { feed },
  ] = await Promise.all([
    runReport(orgId, async (tx) => {
      const [
        incomeStatement, balanceSheet, arAging, apAging, salesNow, salesPrev, salesByStore, lowStockRows, floats,
        onShift, inFlight, disputes, received, usageScorecard,
      ] = await Promise.all([
        getIncomeStatement(tx, { orgId, storeId, fromDate, toDate }),
        getBalanceSheet(tx, { orgId, storeId, asOfDate: today }),
        getArAgingReport(tx, { orgId, storeId, asOfDate: today }),
        getApAgingReport(tx, { orgId, storeId, asOfDate: today }),
        getSalesRollup(tx, { orgId, storeId, fromDate, toDate, groupBy: 'day' }),
        getSalesRollup(tx, { orgId, storeId, fromDate: prev.from, toDate: prev.to, groupBy: 'day' }),
        showByStore ? getSalesRollup(tx, { orgId, storeId, fromDate, toDate, groupBy: 'store' }) : Promise.resolve(null),
        Promise.all(storesInScope.map((s) => lowStockRepo.lowStock(tx, orgId, s.id))),
        cashRequestsRepo.openFloats(tx, orgId),
        attendanceDaysRepo.countOpenToday(tx, orgId, storeIdList),
        // ⭐ T-212. No per-store loop: these take `storeId: null` as "org-wide" in one query, and
        // `reportScope` only yields an undefined `storeId` to somebody scoped to the whole org.
        commissaryKpisRepo.inFlightOrders(tx, { orgId, storeId }),
        commissaryKpisRepo.openDisputes(tx, { orgId, storeId }),
        commissaryKpisRepo.receivedInRange(tx, { orgId, storeId, fromDate, toDate }),
        // T-401 S6: how many of the POS usage drafts a manager posted versus how many the system auto-posted.
        usageCheckScorecard(tx, scope.actor, { from: fromDate, to: toDate }),
      ]);
      const inScope = new Set(storeIdList);
      return {
        incomeStatement,
        balanceSheet,
        arAging,
        apAging,
        salesNow,
        salesPrev,
        salesByStore,
        lowStock: lowStockRows.reduce((n, rows) => n + rows.length, 0),
        openFloats: floats.filter((f) => inScope.has(f.storeId)).length,
        onShift,
        inFlight,
        disputes,
        received,
        usageScorecard: usageScorecard.filter((r) => inScope.has(r.storeId)),
      };
    }),
    findingsFor(orgId, period),
  ]);

  const hardFindingsOpen = feed.findings.filter((f) => f.severity === 'hard' && f.status === 'open').length;
  const totalExpenses = add(incomeStatement.costOfSales, incomeStatement.operatingExpenses);
  const onTheRoad = inFlight.filter((r) => r.stage === 'dispatched').reduce((n, r) => n + r.orderCount, 0);
  const storeLabel = scope.storeId
    ? (storesInScope[0] ? `${storesInScope[0].name} (${storesInScope[0].code})` : scope.storeId)
    : 'All stores';

  // ---- hero, delta and the day series ----------------------------------------------------------
  const totalNow = money(salesNow.ledgerTotal);
  const totalPrev = money(salesPrev.ledgerTotal);
  const diff = subtract(totalNow, totalPrev);
  const up = compare(diff, ZERO) !== -1;
  const pctNum = !isZero(totalPrev) ? (Number(diff) / Number(totalPrev)) * 100 : null;
  const pct = pctNum === null ? null : `${Math.abs(pctNum).toFixed(1).replace(/\.0$/, '')}%`;
  const against = days === 1 ? 'the day before' : `the previous ${days} days`;

  const byDay = (rows: Array<{ period: string | null; total: string }>) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.period) m.set(r.period, (m.get(r.period) ?? 0) + Number(r.total));
    return m;
  };
  const nowMap = byDay(salesNow.periods);
  const prevMap = byDay(salesPrev.periods);
  const nowDays = eachDay(fromDate, toDate);
  const prevDays = eachDay(prev.from, prev.to);
  const points = nowDays.map((d, i) => ({
    label: shortDay(d),
    day: shortDay(d, true),
    text: fmtNum(nowMap.get(d) ?? 0),
    current: nowMap.get(d) ?? 0,
    previous: prevMap.get(prevDays[i]!) ?? 0,
  }));
  let peakIdx = -1;
  points.forEach((p, i) => {
    if (p.current > 0 && (peakIdx < 0 || p.current > points[peakIdx]!.current)) peakIdx = i;
  });
  const lede =
    peakIdx >= 0 && days > 1
      ? `Busiest day was ${shortDay(nowDays[peakIdx]!, true)} at ₱${fmtNum(points[peakIdx]!.current)}.`
      : undefined;

  const storeRows = showByStore && salesByStore
    ? storesInScope.map((s) => {
        const v = salesByStore.periods
          .filter((p) => p.storeId === s.id)
          .reduce((n, p) => n + Number(p.total), 0);
        return { id: s.id, name: s.name, value: v, text: fmtNum(v) };
      })
    : [];
  const channelRows = salesNow.channels.map((c) => ({
    id: c.channelId ?? c.channelName,
    name: c.channelName,
    value: Number(c.total),
    text: fmtNum(c.total),
  }));
  const rangeText = days === 1 ? shortDay(fromDate) : `${shortDay(fromDate)} to ${shortDay(toDate)}`;

  const disputeHint =
    disputes.count > 0
      ? `oldest ${disputes.oldestAgeDays}d` + (disputes.buckets.overdue > 0 ? `, ${disputes.buckets.overdue} past 15 days` : '')
      : 'none open';

  return (
    <Page density="wide">
      <div className="flex flex-col gap-12">
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <PageDescription className="mt-1">
              {scope.orgName} ({scope.orgCode}) · {storeLabel}. Every figure is a live query, the same one its own
              report page runs.
            </PageDescription>
          </div>
          <RangeForm
            stores={scope.stores.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
            currentStoreId={scope.storeId}
            fromDate={fromDate}
            toDate={toDate}
            activePreset={preset}
          />
        </div>

        <section className="grid items-start gap-10 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-8">
            <HeroNumber
              kicker={`Sales · ${rangeText} · ${storeLabel.toLowerCase()}`}
              value={Number(totalNow)}
              text={fmtNum(totalNow)}
              delta={{ same: isZero(diff), pct, abs: fmtNum(Number(up ? diff : negate(diff))), up, against }}
              lede={lede}
            />
            <div className="grid grid-cols-1 border-t border-surface-border sm:grid-cols-2">
              {[
                { label: 'Average a day', value: fmtNum(Number(totalNow) / days), note: `over ${days} ${days === 1 ? 'day' : 'days'}`, href: '/reports/sales-rollup' },
                {
                  label: 'Gross profit',
                  value: fmtNum(incomeStatement.grossProfit),
                  note: isZero(incomeStatement.revenue)
                    ? rangeText
                    : `${((Number(incomeStatement.grossProfit) / Number(incomeStatement.revenue)) * 100).toFixed(1)}% of revenue`,
                  href: '/reports/income-statement',
                },
                { label: 'Expenses', value: fmtNum(totalExpenses), note: rangeText, href: '/reports/income-statement' },
                { label: 'Net income', value: fmtNum(incomeStatement.netIncome), note: rangeText, href: '/reports/income-statement' },
              ].map((s) => (
                <StatCard key={s.label} {...s} className="border-b sm:border-r sm:even:border-r-0" />
              ))}
            </div>
          </div>
          <SalesLine
            points={points}
            chartLabel={`Sales per day, ${rangeText}, against ${against}`}
            curName={rangeText}
            prevName={`${shortDay(prev.from)}${days === 1 ? '' : ` to ${shortDay(prev.to)}`}`}
            peakText={peakIdx >= 0 ? fmtNum(points[peakIdx]!.current) : fmtNum(0)}
            peakLabel={peakIdx >= 0 ? `${shortDay(nowDays[peakIdx]!, true)} · busiest day` : 'no sales yet'}
          />
        </section>

        <section className="grid grid-cols-1 border-y border-surface-border sm:grid-cols-2">
          {[
            { label: 'AR outstanding', value: fmtNum(arAging.totals.total), note: `as of ${shortDay(today)}`, href: '/reports/ar-aging' },
            { label: 'AP outstanding', value: fmtNum(apAging.totals.total), note: `as of ${shortDay(today)}`, href: '/reports/ap-aging' },
          ].map((s) => (
            <StatCard key={s.label} {...s} className="sm:border-r sm:last:border-r-0" />
          ))}
        </section>

        <section className="grid gap-14 lg:grid-cols-2">
          {showByStore ? <StoreBars rows={storeRows} subtitle={`share of ${rangeText}`} /> : null}
          {channelRows.length > 0 ? (
            <ChannelDonut rows={channelRows} subtitle="where the orders came from" />
          ) : (
            <div className="flex flex-col gap-4">
              <h2 className="m-0 border-t-2 border-ink pt-3 font-display text-[28px] font-bold leading-none">By channel</h2>
              <EmptyState message={`No sales ${fromDate} to ${toDate}.`} />
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-4 border-t-2 border-ink pt-3">
            <h2 className="m-0 font-display text-[28px] font-bold leading-none">Waiting on you</h2>
            <span className="text-[13px] text-muted">tap a number to deal with it</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            <OutlineCount href="/findings" count={hardFindingsOpen} label="Findings" hint={`hard, open · ${period}`} />
            <OutlineCount href="/inventory/low-stock" count={lowStock} label="Low stock" hint="items below reorder" />
            <OutlineCount href="/commissary/discrepancies" count={disputes.count} label="Open disputes" hint={disputeHint} />
            <OutlineCount href="/cash-requests" count={openFloats} label="Open floats" hint="cash requests awaiting liquidation" />
          </div>
        </section>

        {usageScorecard.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-4 border-t-2 border-ink pt-3">
              <h2 className="m-0 font-display text-[28px] font-bold leading-none">Usage check</h2>
              <span className="text-[13px] text-muted">POS usage drafts · {rangeText}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-4 font-medium">Store</th>
                    <th className="py-1 pr-4 text-right font-medium">Pull drafts</th>
                    <th className="py-1 pr-4 text-right font-medium">Posted by a manager</th>
                    <th className="py-1 pr-4 text-right font-medium">Auto-posted</th>
                    <th className="py-1 text-right font-medium">Auto-posted %</th>
                  </tr>
                </thead>
                <tbody>
                  {usageScorecard.map((r) => (
                    <tr key={r.storeId} className="border-t border-surface-border">
                      <td className="py-1 pr-4">{r.storeName}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{r.pullDrafts}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{r.postedByManager}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{r.autoPosted}</td>
                      <td className="py-1 text-right tabular-nums">{r.autoPostedPct.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <RightNowBand
          onShift={onShift}
          onTheRoad={onTheRoad}
          receivedNote={`₱${fmtNum(received.goodsReceivedValue)} received from commissary, ${rangeText}`}
          booksTie={balanceSheet.ties}
          assets={fmtNum(balanceSheet.assets)}
        />
      </div>
    </Page>
  );
}

/** One summary figure: label, peso amount, a muted note, the whole card linking to its report. */
function StatCard({ label, value, note, href, className = '' }: { label: string; value: string; note: string; href: string; className?: string }) {
  return (
    // The caller's borders sit on a wrapper so the Link's own className stays static for the T-262 control sweep.
    <div className={`border-surface-border ${className}`}>
      <Link href={href} className="dash-rise flex h-full min-h-11 flex-col gap-2 px-6 py-6">
        <span className="text-xs font-bold uppercase tracking-[0.14em] text-muted">{label}</span>
        <span className="font-display text-[40px] font-bold leading-[0.95] tabular-nums">
          <span className="mr-0.5 text-[0.5em] text-muted">₱</span>
          {value}
        </span>
        <span className="text-[13px] text-muted">{note}</span>
      </Link>
    </div>
  );
}
