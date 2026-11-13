import { applyPosBatch, parsePosBatchPairingId, parsePosEvents, POS_PAIRING_MISMATCH, POS_PAIRING_MISMATCH_CODE } from '@shareat/domain';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';

export const dynamic = 'force-dynamic';

/**
 * T-525 R2 - the tablet's outbox drains here. The DEVICE is the credential (the paired-tablet cookie); no person session is needed or read, because an
 * offline event is sent hours later and each event names its person, whom the domain checks (R4). Store and pairing come from the cookie; the batch also names the pairing its events were made under (T-563).
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
    // T-563: the batch says which pairing its events were made under; the domain takes them under it (same store) or not at all.
    const madeOn = parsePosBatchPairingId(body);
    if (!madeOn) return fail(400, 'Send the pairingId the events were made under.');
    const answer = await applyPosBatch({ pairing: { pairingId: pairing.pairingId, orgId: pairing.orgId, storeId: pairing.storeId }, madeOn, events: parsed.events });
    if (!answer.ok) return json(409, { ok: false, error: POS_PAIRING_MISMATCH, code: POS_PAIRING_MISMATCH_CODE });
    return json(200, { ok: true, stateVersion: answer.stateVersion, results: answer.results });
  });
}
