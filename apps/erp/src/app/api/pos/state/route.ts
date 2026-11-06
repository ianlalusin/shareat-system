import { readPosState } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, notModified, tabletPairing } from '@/lib/pos-api';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * T-525 R8 - the 3-second poll. A live person session is required. The store is the paired tablet's when its cookie resolves; otherwise the `storeId`
 * query (a server phone or the kitchen screen). The domain judges store scope BEFORE the cheap `state_version` check, so a 304 never confirms another
 * store's version. `since` that is missing or not a plain non-negative whole number means "I hold nothing": always a 200.
 */
export async function GET(req: Request): Promise<Response> {
  return guarded('state', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to see the floor.');
    const q = new URL(req.url).searchParams;
    const storeId = (await tabletPairing())?.storeId ?? q.get('storeId');
    if (!storeId || !UUID.test(storeId)) return fail(400, 'Say which store to read.');
    const stationId = q.get('stationId');
    if (stationId !== null && !UUID.test(stationId)) return fail(400, 'That kitchen station is not valid.');
    const raw = q.get('since') ?? '';
    const since = /^\d{1,15}$/.test(raw) ? Number(raw) : -1;
    const answer = await readPosState(session.actor, { storeId: storeId.toLowerCase(), since, ...(stationId ? { stationId: stationId.toLowerCase() } : {}) });
    if (answer.status === 'forbidden') return fail(403, 'You do not have access to this store.');
    if (answer.status === 'not_modified') return notModified({ 'cache-control': 'no-store' });
    return json(200, { ok: true, ...answer.body });
  });
}
