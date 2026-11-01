import { handleBirthdayRead, handleBirthdayRequest } from '@/server/lobby/handlers';

// T-455 S6a: thin routes; the rules live in packages/domain/src/lobby/birthday.ts. Settings are read per request inside the handler.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleBirthdayRequest(req);
}

export async function GET(req: Request): Promise<Response> {
  return handleBirthdayRead(req);
}
