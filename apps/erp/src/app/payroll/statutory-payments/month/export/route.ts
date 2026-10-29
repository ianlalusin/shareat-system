import { AuthorizationError } from '@shareat/auth';
import { requireActor } from '../../../../../lib/session';
import { toCsv } from '../../../../../lib/csv';
import { auditStatutoryExport, isAgency, isMonthStart, monthDetailFor, storeNamesFor } from '../../lib';

export const dynamic = 'force-dynamic';

const HEADERS = ['Store', 'Person', 'Government number', 'Employee share', 'Employer share', 'EC', 'Total', 'Note'];
const NOT_AVAILABLE = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' };

/**
 * One agency + month as a spreadsheet, one row per payslip. T-193 S6. PLAIN columns: it is not the agency's own upload format and is
 * never called that. It carries government numbers, so it reads through `monthDetailFor`, which checks `remit_statutory` itself (the
 * menu is not the gate). Every cell goes through the shared escaper in `toCsv` (DEF-800).
 */
export async function GET(request: Request): Promise<Response> {
  const actor = await requireActor();
  const url = new URL(request.url);
  const agency = url.searchParams.get('agency') ?? '';
  const month = url.searchParams.get('month') ?? '';
  if (!isAgency(agency) || !isMonthStart(month)) {
    return new Response('That agency or month is not available.', { status: 404, headers: NOT_AVAILABLE });
  }
  try {
    const [detail, storeNames] = await Promise.all([monthDetailFor(actor, { agency, month }), storeNamesFor(actor)]);
    const label = agency === 'sss' ? 'SSS' : agency === 'philhealth' ? 'PhilHealth' : agency === 'pagibig' ? 'Pag-IBIG' : 'BIR';
    const rows = detail.rows.map((r) => [
      storeNames.get(r.storeId) ?? '',
      r.personName,
      r.govNo ?? '',
      r.ee,
      r.er,
      r.ec,
      r.total,
      r.notDeducted ? `Not deducted: no ${label} no.` : '',
    ]);
    await auditStatutoryExport(actor, { agency, month, rowCount: rows.length });
    return new Response(toCsv(HEADERS, rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="statutory-${agency}-${month.slice(0, 7)}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    if (err instanceof AuthorizationError) return new Response('You do not have access to this file.', { status: 403, headers: NOT_AVAILABLE });
    throw err;
  }
}
