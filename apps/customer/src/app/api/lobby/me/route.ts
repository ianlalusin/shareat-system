import { handleMe } from '@/server/lobby/handlers';

// T-455 S3: a thin route; the rules live in packages/domain/src/lobby. Settings are read per request inside the handler.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleMe(req);
}
