import { logger } from '@shareat/core/logger';
import { closeDay, sendV1Bridge } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { createV1BridgeWriter } from '@/lib/v1-bridge';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * T-531 R7 - the Z. The DEVICE (paired tablet cookie) AND a person session are both required: the person closes, a manager approves with their PIN, and the PIN
 * is checked on the server by `closeDay` (never here, never logged, never stored: this file does not log the body). Online only.
 * Body `{ closeId, approval: { employeeId, pin } }`. 200 with the result (`wrote:false` on a replay of the same closeId); 409 with a refusal sentence; 401 for no
 * session / no tablet / a wrong PIN; 403 for a person without `record_sale`.
 *
 * AFTER the close commits, the December bridge writes the day to v1 in its own transaction (row 436). Its failure never undoes the close: it is recorded, and the Till
 * tab offers Resend.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('day-close', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to close the day.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the close as application/json.');
    let body: { closeId?: unknown; approval?: { employeeId?: unknown; pin?: unknown } };
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    const a = body?.approval;
    if (typeof body?.closeId !== 'string' || !UUID.test(body.closeId)) return fail(400, 'The close id is missing or not valid.');
    if (!a || typeof a.pin !== 'string' || a.pin === '' || a.pin.length > 32) return fail(400, 'A manager must approve the close with their PIN.');
    if (typeof a.employeeId !== 'string' || a.employeeId.trim() === '' || a.employeeId.length > 20) return fail(400, "Type the manager's Employee ID.");

    const { actor } = session;
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      closeDay(tx, actor, { storeId: pairing.storeId, pairingId: pairing.pairingId, closeId: body.closeId as string, approval: { pin: a.pin as string, employeeId: a.employeeId as string } }),
    );

    // After the commit, outside the close's transaction. Never throws into the answer.
    let v1: { status: string; reason?: string } | null = null;
    if (result.wrote) {
      try {
        const sent = await withOrgPrincipal(actor.orgId, (tx) => sendV1Bridge(tx, actor, { storeId: pairing.storeId, businessDates: [result.businessDate] }, { writer: createV1BridgeWriter() }));
        v1 = sent.results[0] ?? null;
      } catch (err) {
        logger.warn({ storeId: pairing.storeId, code: (err as { code?: string } | null)?.code }, 'pos day close: the v1 bridge step failed after the close committed');
      }
    }
    return json(200, { ok: true, ...result, v1 });
  });
}
