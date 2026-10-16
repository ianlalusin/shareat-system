import 'server-only';
/** T-424 - what every /api/pos2 route file does: build the ports from the environment (503 with a plain sentence when the box is not configured), then run the handler. */
import { getPos2Deps } from './deps';
import { fail } from './http';
import type { Pos2Deps } from './types';

export async function runPos2Route(req: Request, handler: (req: Request, deps: Pos2Deps) => Promise<Response>): Promise<Response> {
  const built = await getPos2Deps(process.env);
  if (!built.ok) return fail(built.status, built.error);
  return handler(req, built.deps);
}
