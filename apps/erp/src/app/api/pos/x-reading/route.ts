import { xReading } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-531 R7 - the X reading: the open window of the paired tablet's till, written nowhere. A person session AND the paired tablet are required; the store is the
 * pairing's, never a request value. Capability `record_sale` (the domain judges it). Online only: there is no outbox kind for it.
 */
export async function GET(): Promise<Response> {
  return guarded('x-reading', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to see the reading.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    const reading = await withOrgPrincipal(session.actor.orgId, (tx) => xReading(tx, session.actor, { storeId: pairing.storeId, pairingId: pairing.pairingId }));
    return json(200, { ok: true, reading });
  });
}
