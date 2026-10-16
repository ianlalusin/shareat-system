/** T-424 - POST /api/pos2/refunds (server build only; build:cap stashes src/app/api). The handler is in src/server/pos2/refunds.ts. */
import { handleRefund } from '@/server/pos2/refunds';
import { runPos2Route } from '@/server/pos2/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runPos2Route(req, handleRefund);
}
