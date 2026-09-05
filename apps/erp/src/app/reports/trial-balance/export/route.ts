import { getTrialBalance } from '@shareat/domain';
import { formatMoney } from '@shareat/core/money';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** The trial balance's CSV export — T-209c. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get('store') ?? undefined;
  const fromDate = url.searchParams.get('from') ?? '';
  const toDate = url.searchParams.get('to') ?? '';
  const includeYearClose = url.searchParams.get('yearClose') !== 'exclude';

  const scope = await reportScope('/reports/trial-balance', 'view_trial_balance', store);
  const orgId = scope.actor.orgId;

  const result = await runReport(orgId, (tx) =>
    getTrialBalance(tx, { orgId, storeId: scope.storeId, fromDate, toDate, includeYearClose }),
  );

  const rows = result.lines.map((l) => [l.accountCode, l.accountName, formatMoney(l.debit), formatMoney(l.credit), formatMoney(l.balance)]);
  rows.push(['', 'Total', formatMoney(result.totalDebit), formatMoney(result.totalCredit), '']);

  return csvResponse(`trial-balance-${fromDate}-to-${toDate}.csv`, ['Code', 'Account', 'Debit', 'Credit', 'Balance'], rows);
}
