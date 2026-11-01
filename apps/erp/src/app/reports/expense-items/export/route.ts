import { expenseItemsReport } from '@shareat/domain';
import { formatMoney } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';
import { resolveRange, storeColumns } from '../range';

/** T-502 S5 - CSV of the "Spending by Item" table. Same scope and same query the screen runs; every cell goes through escapeCsvCell. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const today = toBusinessDate();
  const { from, to } = resolveRange(url.searchParams.get('from'), url.searchParams.get('to'), today);

  const scope = await reportScope('/reports/expense-items', 'view_financial_reports', url.searchParams.get('store') ?? undefined);
  const storeId = scope.storeId ?? null;
  const { report, cols } = await runReport(scope.actor.orgId, async (tx) => {
    const report = await expenseItemsReport(tx, scope.actor, { from, to, storeId });
    return { report, cols: storeId === null ? await storeColumns(tx, report, scope.stores) : [] };
  });

  const storeCols = cols.length > 1 ? cols : [];
  const headers = [
    'Group',
    'Category',
    'Sub-category',
    'Item',
    'Spent',
    '% of total',
    'Times bought',
    'Average price',
    'Unit',
    ...storeCols.flatMap((s) => [`${s.name} spent`, `${s.name} times bought`]),
  ];
  const rows: (string | number)[][] = [];
  for (const g of report.groups)
    for (const c of g.categories)
      for (const sc of c.subcategories)
        for (const i of sc.items) {
          rows.push([
            g.group,
            c.category,
            sc.name,
            i.name,
            formatMoney(i.total),
            i.pct.toFixed(1),
            i.itemId ? i.timesBought : '',
            i.avgUnitPrice ? formatMoney(i.avgUnitPrice) : '',
            i.baseUnit ?? '',
            ...storeCols.flatMap((s) => {
              const b = i.byStore.find((x) => x.storeId === s.id);
              return [b ? formatMoney(b.total) : '', b && i.itemId ? b.timesBought : ''];
            }),
          ]);
        }
  rows.push(['Total', '', '', '', formatMoney(report.total), '100.0', '', '', '', ...storeCols.flatMap(() => ['', ''])]);

  return csvResponse(`expense-items-${from}-to-${to}.csv`, headers, rows);
}
