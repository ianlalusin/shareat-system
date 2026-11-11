import { createHash } from 'node:crypto';
import { can } from '@shareat/auth';
import { loadStoreMenu } from '@shareat/domain';
import { fail, guarded, json, notModified, tabletPairing } from '@/lib/pos-api';
import { currentSession } from '@/lib/session';
import { withOrgPrincipal } from '@/app/expenses/lib';
import { effectiveStore } from '@/app/pos/lib';
import { menuMetaOf } from '@/app/pos/_kitchen/menu-meta';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const matches = (header: string | null, etag: string): boolean =>
  header !== null && header.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag);

/**
 * T-529 R1/R2 - the stations and each package's refills, for a kitchen browser or a server's phone (neither holds a snapshot). A person session is
 * required, plus ANY ONE of serve_pos_ticket, request_pos_refill or confirm_pos_heads at the store (the three words that open Kitchen and Refills). The
 * store is `effectiveStore(pairing, ?storeId)`, as for the state poll. ETag + 304, so the 60-second re-read is nearly free. Menu data only: no prices.
 */
export async function GET(req: Request): Promise<Response> {
  return guarded('menu-meta', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to see the kitchen.');
    const { actor } = session;
    const pairing = await tabletPairing();
    const chosen = effectiveStore(pairing && pairing.orgId === actor.orgId ? pairing : null, new URL(req.url).searchParams.get('storeId') ?? undefined);
    if (chosen.refused) return fail(403, 'This tablet works at one store only.');
    if (!chosen.storeId || !UUID.test(chosen.storeId)) return fail(400, 'Say which store to read.');
    const at = { storeId: chosen.storeId.toLowerCase() };
    const meta = await withOrgPrincipal(actor.orgId, async (tx) => {
      const allowed = (await can(tx, actor, 'serve_pos_ticket', at)) || (await can(tx, actor, 'request_pos_refill', at)) || (await can(tx, actor, 'confirm_pos_heads', at));
      return allowed ? menuMetaOf((await loadStoreMenu(tx, actor.orgId, at.storeId, undefined, { showWithdrawnStore: true })).menu) : null;
    });
    if (!meta) return fail(403, 'You do not have access to this store.');
    const etag = `"${createHash('sha256').update(JSON.stringify(meta), 'utf8').digest('hex')}"`;
    const headers = { 'cache-control': 'private, no-cache', etag };
    if (matches(req.headers.get('if-none-match'), etag)) return notModified(headers);
    return json(200, { ok: true, ...meta }, headers);
  });
}
