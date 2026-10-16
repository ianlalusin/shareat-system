/** T-424 - POST /api/pos2/tender-corrections (server build only; build:cap stashes src/app/api). The handler is in src/server/pos2/tender-corrections.ts. */
import { handleTenderCorrection } from '@/server/pos2/tender-corrections';
import { runPos2Route } from '@/server/pos2/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runPos2Route(req, handleTenderCorrection);
}
