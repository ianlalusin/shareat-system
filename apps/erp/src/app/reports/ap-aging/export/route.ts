import { getApAgingReport } from '@shareat/domain';
import { apRepo } from '@shareat/db';
import { formatMoney } from '@shareat/core/money';
import { reportScope, runReport } from '../../lib';
import { csvResponse } from '@/lib/csv';

/** The AP aging register's CSV export — T-209c. Same query the screen itself runs; same auth. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get('store') ?? undefined;
  const asOfDate = url.searchParams.get('asOf') ?? '';

  const scope = await reportScope('/reports/ap-aging', 'view_financial_reports', store);
  const orgId = scope.actor.orgId;

  const { report, supplierNames } = await runReport(orgId, async (tx) => {
    const [report, suppliers] = await Promise.all([
      getApAgingReport(tx, { orgId, storeId: scope.storeId, asOfDate }),
      apRepo.listSuppliers(tx, orgId, { includeInactive: true }),
    ]);
    return { report, supplierNames: new Map(suppliers.map((s) => [s.id, s.name])) };
  });

  const rows = report.rows.map((r) => [
    supplierNames.get(r.supplierId) ?? r.supplierId,
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
    `ap-aging-as-of-${asOfDate}.csv`,
    ['Supplier', 'Current', '1-30 days', '31-60 days', '61-90 days', '90+ days', 'Total'],
    rows,
  );
}
