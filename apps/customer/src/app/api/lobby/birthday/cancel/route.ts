import { handleBirthdayCancel } from '@/server/lobby/handlers';

// T-455 S6a: a thin route; the rules live in packages/domain/src/lobby/birthday.ts.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleBirthdayCancel(req);
}
