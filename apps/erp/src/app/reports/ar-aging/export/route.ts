import { getArAgingReport } from '@shareat/domain';
import { customersRepo } from '@shareat/db';
import { formatMoney } from '@shareat/core/money';
import { mayReadCustomerBalances, reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** The AR aging register's CSV export — T-209c. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get('store') ?? undefined;
  const asOfDate = url.searchParams.get('asOf') ?? '';

  const scope = await reportScope('/reports/ar-aging', 'view_financial_reports', store);
  const orgId = scope.actor.orgId;
  if (!(await mayReadCustomerBalances(scope))) {
    return new Response('You do not have access to customer balances (record_ar_collection).', { status: 403 });
  }

  const { report, customerNames } = await runReport(orgId, async (tx) => {
    const [report, customers] = await Promise.all([
      getArAgingReport(tx, { orgId, storeId: scope.storeId, asOfDate }),
      customersRepo.listCustomers(tx, orgId),
    ]);
    return { report, customerNames: new Map(customers.map((c) => [c.id, c.name])) };
  });

  const rows = report.rows.map((r) => [
    customerNames.get(r.customerId) ?? r.customerId,
    formatMoney(r.current),
    formatMoney(r.d1to30),
    formatMoney(r.d31to60),
    formatMoney(r.d61to90),
    formatMoney(r.d90plus),
    formatMoney(r.total),
  ]);
  rows.push([
    'Total',
    formatMoney(report.totals.current),
    formatMoney(report.totals.d1to30),
    formatMoney(report.totals.d31to60),
    formatMoney(report.totals.d61to90),
    formatMoney(report.totals.d90plus),
    formatMoney(report.totals.total),
  ]);

  return csvResponse(
    `ar-aging-as-of-${asOfDate}.csv`,
    ['Customer', 'Current', '1-30 days', '31-60 days', '61-90 days', '90+ days', 'Total'],
    rows,
  );
}
