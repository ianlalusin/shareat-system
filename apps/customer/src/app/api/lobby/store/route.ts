import { handleStore } from '@/server/lobby/handlers';

// T-455 S4: a thin, public, read-only route; GET is the only method exported, so Next answers every other method with 405.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleStore(req);
}
