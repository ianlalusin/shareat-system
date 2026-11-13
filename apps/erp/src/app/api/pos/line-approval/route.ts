import { grantLineApproval } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-576 - a manager's approval of ONE line action (cancel a line, give or remove a line discount, discount every line), asked by the till BEFORE it saves the action to its outbox, so the
 * manager PIN never sits in the tablet's log and a wrong PIN is refused on the spot. A person session AND the paired tablet are required (the senior-id-check pair); the store and pairing are
 * the cookie's, never a request value; capability `record_sale` (the domain judges it). Body { pin, action, targetId } plus, for a discount, { kind, presetId, valueType, value, qty, lineId } (apply to all: presetId): the token is bound to them, and to the NEW discount's id. A wrong PIN is charged as a miss on the store's terminal (committed at
 * once) and answers the one approval sentence. 200 { ok, token, approverId, exp }: a signed token bound to this store, this tablet, the approver, the action and the target, good for 15 minutes.
 *
 * POST with a JSON body, never GET: a PIN must not sit in a URL. A method the file does not export is 405 (Next). Online only: offline the till goes ahead and flags the action for review.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('line-approval', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to ask for a manager approval.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the approval request as application/json.');
    let body: unknown;
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    const b = (body ?? {}) as { pin?: unknown; action?: unknown; targetId?: unknown; kind?: unknown; presetId?: unknown; valueType?: unknown; value?: unknown; qty?: unknown; lineId?: unknown };
    if (typeof b.pin !== 'string' || typeof b.action !== 'string' || typeof b.targetId !== 'string') return fail(400, 'Send the PIN, the action and the target as text.');
    const grant = await withOrgPrincipal(session.actor.orgId, (tx) =>
      grantLineApproval(tx, session.actor, { storeId: pairing.storeId, pairingId: pairing.pairingId, pin: b.pin, action: b.action, targetId: b.targetId, detail: { kind: b.kind, presetId: b.presetId, valueType: b.valueType, value: b.value, qty: b.qty, lineId: b.lineId } }),
    );
    return json(200, { ok: true, ...grant });
  });
}
