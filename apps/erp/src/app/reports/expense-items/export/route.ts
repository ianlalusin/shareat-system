import { expenseItemsReport } from '@shareat/domain';
import { formatMoney } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** T-502 S5 - CSV of the "Spending by Item" table. Same scope and same query the screen runs; every cell goes through escapeCsvCell. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const today = toBusinessDate();
  const from = url.searchParams.get('from') ?? `${today.slice(0, 7)}-01`;
  const to = url.searchParams.get('to') ?? today;

  const scope = await reportScope('/reports/expense-items', 'view_financial_reports', url.searchParams.get('store') ?? undefined);
  const storeId = scope.storeId ?? null;
  const report = await runReport(scope.actor.orgId, (tx) => expenseItemsReport(tx, scope.actor, { from, to, storeId }));

  const storeCols = storeId === null && scope.stores.length > 1 ? scope.stores : [];
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
