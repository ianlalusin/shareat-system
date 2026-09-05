import { getCashFlow } from '@shareat/domain';
import { formatMoney, type Money } from '@shareat/core/money';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** The cash flow statement's CSV export — T-209c. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get('store') ?? undefined;
  const fromDate = url.searchParams.get('from') ?? '';
  const toDate = url.searchParams.get('to') ?? '';
  const includeYearClose = url.searchParams.get('yearClose') === 'include';

  const scope = await reportScope('/reports/cash-flow', 'view_financial_reports', store);
  const orgId = scope.actor.orgId;

  const result = await runReport(orgId, (tx) =>
    getCashFlow(tx, { orgId, storeId: scope.storeId, fromDate, toDate, includeYearClose }),
  );

  const section = (label: string, lines: { accountCode: string; accountName: string; amount: Money }[], total: Money) => [
    [label, '', ''],
    ...lines.map((l) => [l.accountCode, l.accountName, formatMoney(l.amount)]),
    ['', `Net cash from ${label.toLowerCase()}`, formatMoney(total)],
  ];

  const rows = [
    ['Operating activities', '', ''],
    ['', 'Net income', formatMoney(result.netIncome)],
    ...result.operatingLines.map((l) => [l.accountCode, l.accountName, formatMoney(l.amount)]),
    ['', 'Net cash from operating activities', formatMoney(result.operating)],
    ...section('Investing activities', result.investingLines, result.investing),
    ...section('Financing activities', result.financingLines, result.financing),
    ['', 'Net change in cash', formatMoney(result.netChangeInCash)],
  ];

  return csvResponse(`cash-flow-${fromDate}-to-${toDate}.csv`, ['Code', 'Account', 'Amount'], rows);
}
