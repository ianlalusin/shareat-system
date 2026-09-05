import { getIncomeStatement } from '@shareat/domain';
import { formatMoney, type Money } from '@shareat/core/money';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** The income statement's CSV export — T-209c. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get('store') ?? undefined;
  const fromDate = url.searchParams.get('from') ?? '';
  const toDate = url.searchParams.get('to') ?? '';
  const includeYearClose = url.searchParams.get('yearClose') === 'include';

  const scope = await reportScope('/reports/income-statement', 'view_financial_reports', store);
  const orgId = scope.actor.orgId;

  const result = await runReport(orgId, (tx) =>
    getIncomeStatement(tx, { orgId, storeId: scope.storeId, fromDate, toDate, includeYearClose }),
  );

  const section = (label: string, lines: { accountCode: string; accountName: string; amount: Money }[], total: Money) => [
    [label, '', ''],
    ...lines.map((l) => [l.accountCode, l.accountName, formatMoney(l.amount)]),
    ['', `Total ${label.toLowerCase()}`, formatMoney(total)],
  ];

  const rows = [
    ...section('Revenue', result.revenueLines, result.revenue),
    ...section('Cost of sales', result.costOfSalesLines, result.costOfSales),
    ['', 'Gross profit', formatMoney(result.grossProfit)],
    ...section('Operating expenses', result.operatingExpenseLines, result.operatingExpenses),
    ['', 'Operating income', formatMoney(result.operatingIncome)],
    ...section('Other income and expense', result.otherIncomeExpenseLines, result.otherIncomeExpense),
    ['', 'Net income', formatMoney(result.netIncome)],
  ];

  return csvResponse(`income-statement-${fromDate}-to-${toDate}.csv`, ['Code', 'Account', 'Amount'], rows);
}
