import { handleClaimCancel } from '@/server/lobby/handlers';

// T-455 S7a: a thin route; the rules live in packages/domain/src/lobby/claims.ts.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleClaimCancel(req);
}
