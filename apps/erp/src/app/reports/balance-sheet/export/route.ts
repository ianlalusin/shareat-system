import { getBalanceSheet } from '@shareat/domain';
import { formatMoney, type Money } from '@shareat/core/money';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** The balance sheet's CSV export — T-209c. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get('store') ?? undefined;
  const asOfDate = url.searchParams.get('asOf') ?? '';
  const includeYearClose = url.searchParams.get('yearClose') !== 'exclude';

  const scope = await reportScope('/reports/balance-sheet', 'view_trial_balance', store);
  const orgId = scope.actor.orgId;

  const result = await runReport(orgId, (tx) =>
    getBalanceSheet(tx, { orgId, storeId: scope.storeId, asOfDate, includeYearClose }),
  );

  const section = (
    label: string,
    lines: { accountCode: string | null; accountName: string; amount: Money }[],
    total: Money,
  ) => [
    [label, '', ''],
    ...lines.map((l) => [l.accountCode ?? '', l.accountName, formatMoney(l.amount)]),
    ['', `Total ${label.toLowerCase()}`, formatMoney(total)],
  ];

  const rows = [
    ...section('Assets', result.assetLines, result.assets),
    ...section('Liabilities', result.liabilityLines, result.liabilities),
    ...section('Equity', result.equityLines, result.equity),
  ];

  return csvResponse(`balance-sheet-as-of-${asOfDate}.csv`, ['Code', 'Account', 'Amount'], rows);
}
