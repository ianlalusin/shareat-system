/** T-424 - POST /api/pos2/analytics/apply-delta (server build only; build:cap stashes src/app/api). The handler is in src/server/pos2/apply-delta.ts. */
import { handleApplyDelta } from '@/server/pos2/apply-delta';
import { runPos2Route } from '@/server/pos2/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runPos2Route(req, handleApplyDelta);
}
