import { checkSeniorIdRepeat } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-575 (bible row 462) - "has this senior/PWD card number been used at this store lately?", asked by the payment screen when the ID box loses focus. A person session AND the
 * paired tablet are required (the x-reading pair); the store is the pairing's, never a request value; capability `record_sale` (the domain judges it). Online only: the tablet skips the
 * question offline.
 *
 * POST with a JSON body, never GET: a card number is personal data and must not sit in a URL, a log line or a browser history. A method the file does not export is 405 (Next).
 * The answer is { ok, used, lastReceiptNo, lastAt } and never the holder's name.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('senior-id-check', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to check a card number.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the card number as application/json.');
    let body: unknown;
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    const idNumber = (body as { idNumber?: unknown } | null)?.idNumber;
    if (typeof idNumber !== 'string') return fail(400, 'Send the card number as text.');
    const answer = await withOrgPrincipal(session.actor.orgId, (tx) => checkSeniorIdRepeat(tx, session.actor, { storeId: pairing.storeId, pairingId: pairing.pairingId, idNumber }));
    return json(200, { ok: true, ...answer });
  });
}
