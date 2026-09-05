import { getStorePLComparison } from '@shareat/domain';
import { authorize } from '@shareat/auth';
import { formatMoney, type Money } from '@shareat/core/money';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** The store comparison's CSV export — T-209c. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedIds = url.searchParams.getAll('stores');
  const fromDate = url.searchParams.get('from') ?? '';
  const toDate = url.searchParams.get('to') ?? '';
  const includeYearClose = url.searchParams.get('yearClose') === 'include';

  const scope = await reportScope('/reports/store-comparison', 'view_financial_reports', undefined);
  const orgId = scope.actor.orgId;
  const candidateIds = new Set(scope.stores.map((s) => s.id));
  const selectedIds = (requestedIds.length > 0 ? requestedIds : scope.stores.map((s) => s.id)).filter((id) => candidateIds.has(id));
  const storeName = new Map(scope.stores.map((s) => [s.id, `${s.name} (${s.code})`]));

  const comparison = await runReport(orgId, async (tx) => {
    for (const storeId of selectedIds) {
      await authorize(tx, scope.actor, 'view_financial_reports', { storeId });
    }
    return getStorePLComparison(tx, { orgId, storeIds: selectedIds, fromDate, toDate, includeYearClose });
  });

  const headers = ['Figure', ...comparison.stores.map((s) => storeName.get(s.storeId) ?? s.storeId)];
  const figureRow = (label: string, pick: (r: (typeof comparison.stores)[number]['statement']) => Money) => [
    label,
    ...comparison.stores.map((s) => formatMoney(pick(s.statement))),
  ];

  const rows = [
    figureRow('Revenue (net of contra)', (r) => r.revenue),
    figureRow('Cost of sales', (r) => r.costOfSales),
    figureRow('Gross profit', (r) => r.grossProfit),
    figureRow('Operating expenses', (r) => r.operatingExpenses),
    figureRow('Operating income', (r) => r.operatingIncome),
    figureRow('Other income and expense', (r) => r.otherIncomeExpense),
    figureRow('Net income', (r) => r.netIncome),
  ];

  return csvResponse(`store-comparison-${fromDate}-to-${toDate}.csv`, headers, rows);
}
