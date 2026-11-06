import 'server-only';
/**
 * T-508 S4 (R6) - GET /api/pos2/menu. Headers: `Authorization: Bearer <Firebase token>`, `x-pos-store-id` (the POS store the staffer works at),
 * `x-device-id` (the tablet's uuid). Staff must be assigned to that POS store (403, same check as every pos2 route). The ERP store is resolved
 * ONLY from the device's active terminal link inside `deps.menu.forDevice`; no store id in the query or body is ever read. No link -> 401.
 */
import { fail, isUuid, jsonResponse, UNEXPECTED_ERROR } from './http';
import { authenticate } from './identity';
import type { Pos2Deps } from './types';

type MenuForDeviceInput = { posStoreId: string; deviceId: string };

/** The `deps.menu.forDevice` port. The ERP store comes ONLY from the device's terminal link (`loadMenuForTerminal`); never `loadStoreMenu`. */
export function makeMenuForDevice<T>(d: {
  orgId: string;
  withOrgPrincipal: <R>(orgId: string, fn: (tx: unknown) => Promise<R>) => Promise<R>;
  loadMenuForTerminal: (tx: unknown, orgId: string, input: MenuForDeviceInput) => Promise<T>;
  isAuthError: (err: unknown) => boolean;
}): (i: MenuForDeviceInput) => Promise<T | null> {
  return async (i) => {
    try {
      return await d.withOrgPrincipal(d.orgId, (tx) => d.loadMenuForTerminal(tx, d.orgId, i));
    } catch (err) {
      if (d.isAuthError(err)) return null;
      throw err;
    }
  };
}

export async function handleMenu(req: Request, deps: Pos2Deps): Promise<Response> {
  try {
    if (!req.headers.get('x-pos-store-id')) return fail(400, 'Missing store.');
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
    // T-510 S4b: also on a 304, so a tablet whose menu did not change still learns the next daypart boundary. Omitted when there is none.
    const next: Record<string, string> = out.nextChangeAt ? { 'x-next-change-at': out.nextChangeAt } : {};
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store', ...next } });
    const res = jsonResponse(200, { menu: out.menu, contentHash: out.contentHash, nextChangeAt: out.nextChangeAt });
    res.headers.set('etag', etag);
    for (const [k, v] of Object.entries(next)) res.headers.set(k, v);
    return res;
  } catch (err) {
    console.error('[pos2] menu error', err instanceof Error ? err.name : 'non-error thrown');
    return fail(500, UNEXPECTED_ERROR);
  }
}
