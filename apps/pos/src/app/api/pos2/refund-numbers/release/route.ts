/** T-474 - POST /api/pos2/refund-numbers/release (server build only; build:cap stashes src/app/api). The handler is in src/server/pos2/refund-number-release.ts. */
import { handleRefundNumberRelease } from '@/server/pos2/refund-number-release';
import { runPos2Route } from '@/server/pos2/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runPos2Route(req, handleRefundNumberRelease);
}
