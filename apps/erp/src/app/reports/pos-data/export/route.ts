import { AuthorizationError } from '@shareat/auth';
import { exportPosData } from '@shareat/domain';
import { RefusalError } from '@shareat/db';
import { requireActor } from '../../../../lib/session';
import { csvResponse } from '@/lib/csv';
import { runReport } from '../../lib';

export const dynamic = 'force-dynamic';

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });

/**
 * T-569 - one POS v2 table as CSV, for one store and a date range, before the 2027 clean-up. A copy of what the database holds, never a report.
 * The checks (store required and the person's own, `view_financial_reports` at that store, dates, table) and the `data.export_downloaded` audit row all
 * live in the domain's `exportPosData`; the audit row is committed with the read, before this builds any response.
 */
export async function GET(request: Request): Promise<Response> {
  const actor = await requireActor('/reports/pos-data');
  const q = new URL(request.url).searchParams;
  let file;
  try {
    file = await runReport(actor.orgId, (tx) =>
      exportPosData(tx, actor, { storeId: q.get('store'), from: q.get('from'), to: q.get('to'), table: q.get('table') }),
    );
  } catch (err) {
    if (err instanceof RefusalError) return plain(400, err.userMessage);
    if (err instanceof AuthorizationError) return plain(403, 'You may not download POS data for this store.');
    throw err;
  }
  return csvResponse(
    file.filename,
    file.columns,
    file.rows.map((r) => file.columns.map((c) => r[c] ?? '')),
    { bom: true, noStore: true },
  );
}
