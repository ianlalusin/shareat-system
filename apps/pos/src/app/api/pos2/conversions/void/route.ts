import { handleConversionVoid } from '@/server/pos2/conversions';
import { runPos2Route } from '@/server/pos2/route';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response> {
  return runPos2Route(req, handleConversionVoid);
}
