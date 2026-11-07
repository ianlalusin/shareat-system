import { loadPosSnapshot } from '@shareat/domain';
import { fail, guarded, json, notModified, POS_UNPAIRED, posDeps, tabletPairing } from '@/lib/pos-api';

export const dynamic = 'force-dynamic';

/** `If-None-Match` as the browser sends it: one or more (weak) validators, or `*`. */
const matches = (header: string | null, etag: string): boolean =>
  header !== null && header.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag);

/**
 * T-525 R7 - everything the tablet needs to sell offline, as one closed list, behind an ETag. The paired-tablet cookie ONLY: the staff list is needed
 * BEFORE anyone signs in, so no person session is read.
 * The tablet fetches it at sign-in and every 5 minutes, and NEVER blanks a good snapshot on a failed fetch (A6, T-508): that rule is T-530's.
 */
export async function GET(req: Request): Promise<Response> {
  return guarded('snapshot', async () => {
    const pairing = await tabletPairing();
    if (!pairing) return fail(401, POS_UNPAIRED);
    const snap = await loadPosSnapshot({ pairingId: pairing.pairingId, orgId: pairing.orgId, storeId: pairing.storeId }, posDeps);
    const headers = { 'cache-control': 'private, no-cache', etag: snap.etag, ...(snap.nextChangeAt ? { 'x-next-change-at': snap.nextChangeAt } : {}) };
    if (matches(req.headers.get('if-none-match'), snap.etag)) return notModified(headers);
    return json(200, { ok: true, ...snap.body }, headers);
  });
}
