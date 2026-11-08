import { can } from '@shareat/auth';
import { goneSentence, RefusalError } from '@shareat/db';
import { getSessionBill } from '@shareat/domain';
import { fail, guarded, json, tabletPairing } from '@/lib/pos-api';
import { currentSession } from '@/lib/session';
import { withOrgPrincipal } from '@/app/expenses/lib';
import { effectiveStore } from '@/app/pos/lib';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = goneSentence('table');

/**
 * T-527 R1 - one table's live lines for the Orders table panel. A person session is required (a tablet cookie alone is not one). The store is
 * `effectiveStore(pairing, ?storeId)`: a paired tablet's own store wins and a different `?storeId` is refused. Needs `record_sale` at that store.
 * It returns the table and its lines, never `pricing` (the bill is T-528's to show), and a malformed or unknown id is the same 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  return guarded('session', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to see this table.');
    const { sessionId } = await ctx.params;
    if (!UUID.test(sessionId)) return fail(404, NOT_FOUND);
    const { actor } = session;
    const pairing = await tabletPairing();
    const { storeId, refused } = effectiveStore(pairing && pairing.orgId === actor.orgId ? pairing : null, new URL(req.url).searchParams.get('storeId') ?? undefined);
    if (refused) return fail(403, 'This tablet works at one store only.');
    if (!storeId || !UUID.test(storeId)) return fail(400, 'Say which store to read.');
    const at = { storeId: storeId.toLowerCase() };
    try {
      const bill = await withOrgPrincipal(actor.orgId, async (tx) => ((await can(tx, actor, 'record_sale', at)) ? getSessionBill(tx, actor, { ...at, sessionId: sessionId.toLowerCase() }) : null));
      if (!bill) return fail(403, 'You do not have access to this store.');
      const { pricing: _pricing, ...table } = bill;
      return json(200, { ok: true, ...table });
    } catch (err) {
      if (err instanceof RefusalError && err.userMessage === NOT_FOUND) return fail(404, NOT_FOUND);
      throw err;
    }
  });
}
