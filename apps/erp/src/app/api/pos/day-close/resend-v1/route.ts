import { resendV1Bridge } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { createV1BridgeWriter } from '@/lib/v1-bridge';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * T-531 R5/R7 - Resend a day to v1: rebuilt from the database and rewritten (a full overwrite, so it is idempotent). Capability `approve_pos_correction` (a
 * manager), judged by the domain. A refusal (no key, no v1 name for a tender, a date after 2026-12-31) is 409 with its sentence. Body `{ businessDate }`. Online only.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('day-close-resend-v1', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to send a day to v1.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the request as application/json.');
    let body: { businessDate?: unknown };
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    if (typeof body?.businessDate !== 'string' || !DATE.test(body.businessDate)) return fail(400, 'Say which day to send, as YYYY-MM-DD.');
    const { actor } = session;
    const out = await withOrgPrincipal(actor.orgId, (tx) => resendV1Bridge(tx, actor, { storeId: pairing.storeId, businessDate: body.businessDate as string }, { writer: createV1BridgeWriter() }));
    return json(200, { ok: true, ...out });
  });
}
