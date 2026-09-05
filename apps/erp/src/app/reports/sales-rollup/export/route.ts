import { getSalesRollup } from '@shareat/domain';
import { reportsRepo } from '@shareat/db';
import { formatMoney } from '@shareat/core/money';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

type SalesRollupGrouping = reportsRepo.SalesRollupGrouping;

function isGrouping(v: string | null): v is SalesRollupGrouping {
  return v === 'day' || v === 'month' || v === 'store';
}

/** The sales rollup's CSV export — T-210. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get('store') ?? undefined;
  const fromDate = url.searchParams.get('from') ?? '';
  const toDate = url.searchParams.get('to') ?? '';
  const groupByParam = url.searchParams.get('groupBy');
  const groupBy: SalesRollupGrouping = isGrouping(groupByParam) ? groupByParam : 'day';

  const scope = await reportScope('/reports/sales-rollup', 'view_financial_reports', store);
  const orgId = scope.actor.orgId;
  const storeNameById = new Map(scope.stores.map((s) => [s.id, `${s.name} (${s.code})`]));

  const result = await runReport(orgId, (tx) => getSalesRollup(tx, { orgId, storeId: scope.storeId, fromDate, toDate, groupBy }));

  const rows = [
    ['Period', '', ''],
    ...result.periods.map((p) => [p.period ?? (p.storeId ? storeNameById.get(p.storeId) ?? p.storeId : ''), '', formatMoney(p.total)]),
    ['', 'Total (ledger)', formatMoney(result.ledgerTotal)],
    ['Channel', 'Remitted daily', ''],
    ...result.channels.map((c) => [c.channelName, c.isRemittedDaily ? 'Yes' : 'No', formatMoney(c.total)]),
    ['', 'Total (channels)', formatMoney(result.channelTotal)],
    ['Mode', '', ''],
    ...result.modes.map((m) => [m.mode, '', formatMoney(m.total)]),
    ['', 'Total (modes)', formatMoney(result.modeTotal)],
  ];

  return csvResponse(`sales-rollup-${fromDate}-to-${toDate}.csv`, ['Label', 'Detail', 'Amount'], rows);
}
