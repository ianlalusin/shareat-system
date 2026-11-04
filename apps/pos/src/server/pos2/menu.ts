import 'server-only';
/**
 * T-508 S4 (R6) - GET /api/pos2/menu. Headers: `Authorization: Bearer <Firebase token>`, `x-pos-store-id` (the POS store the staffer works at),
 * `x-device-id` (the tablet's uuid). Staff must be assigned to that POS store (403, same check as every pos2 route). The ERP store is resolved
 * ONLY from the device's active terminal link inside `deps.menu.forDevice`; no store id in the query or body is ever read. No link -> 401.
 */
import { fail, isUuid, jsonResponse, UNEXPECTED_ERROR } from './http';
import { authenticate } from './identity';
import type { Pos2Deps } from './types';

export async function handleMenu(req: Request, deps: Pos2Deps): Promise<Response> {
  try {
    // authenticate() reads a JSON body; a GET has none, so hand it the one field it needs, taken from the header.
    const auth = await authenticate(
      new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ storeId: req.headers.get('x-pos-store-id') ?? '' }) }),
      deps,
    );
    if (!auth.ok) return auth.response;
    const deviceId = req.headers.get('x-device-id');
    const out = isUuid(deviceId) ? await deps.menu.forDevice({ posStoreId: auth.caller.storeId, deviceId }) : null;
    if (!out) return fail(401, 'This tablet is not registered. Ask an administrator to register it.');
    const etag = `"${out.contentHash}"`;
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
    const res = jsonResponse(200, { menu: out.menu, contentHash: out.contentHash, nextChangeAt: out.nextChangeAt });
    res.headers.set('etag', etag);
    return res;
  } catch (err) {
    console.error('[pos2] menu error', err instanceof Error ? err.name : 'non-error thrown');
    return fail(500, UNEXPECTED_ERROR);
  }
}
