import { applyPosEvents, parsePosEvents } from '@shareat/domain';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';

export const dynamic = 'force-dynamic';

/**
 * T-525 R2 - the tablet's outbox drains here. The DEVICE is the credential (the paired-tablet cookie); no person session is needed or read, because an
 * offline event is sent hours later and each event names its person, whom the domain checks (R4). Store and pairing come from the pairing only.
 * A cross-site form post carries no cookie (SameSite=Lax) and is also refused by the content-type check.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('events', async () => {
    const pairing = await tabletPairing();
    if (!pairing) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the events as application/json.');
    let body: unknown;
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    const parsed = parsePosEvents(body);
    if (!parsed.ok) return fail(400, parsed.error);
    const answer = await applyPosEvents({ pairing: { pairingId: pairing.pairingId, orgId: pairing.orgId, storeId: pairing.storeId }, events: parsed.events });
    return json(200, { ok: true, stateVersion: answer.stateVersion, results: answer.results });
  });
}
