import { logger } from '@shareat/core/logger';
import { closeBacklog, sendV1Bridge } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { createV1BridgeWriter } from '@/lib/v1-bridge';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * T-531 R11 - "Close day by day": closes the unclosed backlog one business day at a time (bible row 450). A store manager's act: the person session must be a
 * manager or above AND a different manager's PIN approves (both judged by `closeBacklog`; the PIN is never logged or stored). Body `{ closeRunId, approval: { employeeId, pin } }`.
 * 200 with the Zs written (`wrote:false` on a replay of the same run); 409 with a refusal sentence; 401 / 403 as the Z. Each closed date goes to v1 afterwards, in date order.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('day-close-backlog', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to close the days.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the request as application/json.');
    let body: { closeRunId?: unknown; approval?: { employeeId?: unknown; pin?: unknown } };
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    const a = body?.approval;
    if (typeof body?.closeRunId !== 'string' || !UUID.test(body.closeRunId)) return fail(400, 'The run id is missing or not valid.');
    if (!a || typeof a.pin !== 'string' || a.pin === '' || a.pin.length > 32) return fail(400, 'A manager must approve with their PIN.');
    if (typeof a.employeeId !== 'string' || a.employeeId.trim() === '' || a.employeeId.length > 20) return fail(400, "Type the manager's Employee ID.");

    const { actor } = session;
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      closeBacklog(tx, actor, { storeId: pairing.storeId, pairingId: pairing.pairingId, closeRunId: body.closeRunId as string, approval: { pin: a.pin as string, employeeId: a.employeeId as string } }),
    );

    let v1: { businessDate: string; status: string; reason?: string }[] = [];
    if (result.wrote) {
      try {
        const sent = await withOrgPrincipal(actor.orgId, (tx) => sendV1Bridge(tx, actor, { storeId: pairing.storeId, businessDates: result.closes.map((c) => c.businessDate) }, { writer: createV1BridgeWriter() }));
        v1 = sent.results;
      } catch (err) {
        logger.warn({ storeId: pairing.storeId, code: (err as { code?: string } | null)?.code }, 'pos day close (by day): the v1 bridge step failed after the close committed');
      }
    }
    return json(200, { ok: true, ...result, v1 });
  });
}
