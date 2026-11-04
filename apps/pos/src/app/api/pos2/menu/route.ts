import { handleMenu } from '@/server/pos2/menu';
import { runPos2Route } from '@/server/pos2/route';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request): Promise<Response> {
  return runPos2Route(req, handleMenu);
}
