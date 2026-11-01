import { handleClaimRead, handleClaimSubmit } from '@/server/lobby/handlers';

// T-455 S7a: thin routes; the rules live in packages/domain/src/lobby/claims.ts. Typed claims only: there is no photo or file path here (S8 reads on the phone).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleClaimSubmit(req);
}

export async function GET(req: Request): Promise<Response> {
  return handleClaimRead(req);
}
