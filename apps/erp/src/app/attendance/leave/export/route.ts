import { exportLeaveCsv } from '@shareat/domain';
import { requireActor } from '../../../../lib/session';
import { withOrgPrincipal } from '../../../expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * The leave register's CSV, one row per leave date. T-436. Same read the screen runs, same authorization (the domain's
 * `manage_attendance` at the store). The kind only: no note, no certificate, no file id.
 */
export async function GET(request: Request): Promise<Response> {
  const actor = await requireActor();
  const url = new URL(request.url);
  const storeId = url.searchParams.get('store') ?? '';
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  try {
    const csv = await withOrgPrincipal(actor.orgId, (tx) => exportLeaveCsv(tx, actor, { storeId, from, to }));
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="leave-${from}-to-${to}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return new Response('This leave register is not available to you.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
    });
  }
}
