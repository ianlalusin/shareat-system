/**
 * T-526 R3 - one snapshot refresh on the paired tablet. A 200 saves it, moves the counters above the server's, and drops verifiers of people
 * who left the staff list; a 304 only stamps the fetch time; any failure keeps the cached copy exactly as it was (A6: never blank it).
 */
import { resumeAbove, saveSnapshot, touchSnapshot, readSnapshot } from '@/lib/pos-device';
import { expireRevokedVerifiers, type SnapshotStaff } from './verifier-expiry';

export interface SnapshotBody {
  staff: SnapshotStaff[];
  device: { pairingId: string; lastSeq: number; lastTerminalSeq: number };
  rules?: unknown;
  [k: string]: unknown;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A 200 whose body is not the shape the shell reads (a proxy error page, a half-written reply) must not replace a good cache or move the
 * counters: staff is a list of people with string ids and a capability list, device carries numeric counters, and `rules` is present.
 */
export function isSnapshotBody(b: unknown): b is SnapshotBody {
  const x = b as Partial<SnapshotBody> | null;
  if (!x || typeof x !== 'object' || !('rules' in x)) return false;
  const device = x.device as Partial<SnapshotBody['device']> | undefined;
  if (!device || !isCount(device.lastSeq) || !isCount(device.lastTerminalSeq)) return false;
  return (
    Array.isArray(x.staff) &&
    x.staff.every((m) => !!m && isStr(m.personId) && isStr(m.employeeId) && isStr(m.displayName) && Array.isArray(m.posCapabilities))
  );
}

export type RefreshResult = { kind: 'updated' | 'not_modified' | 'failed' | 'unpaired' };

export async function refreshSnapshot(deps: { fetch: typeof fetch; nowMs: number }): Promise<RefreshResult> {
  const cached = await readSnapshot();
  const headers = new Headers();
  if (cached?.etag) headers.set('if-none-match', cached.etag);
  try {
    const res = await deps.fetch('/api/pos/snapshot', { credentials: 'same-origin', headers });
    if (res.status === 304) {
      await touchSnapshot(deps.nowMs);
      return { kind: 'not_modified' };
    }
    if (res.status === 401) return { kind: 'unpaired' };
    if (res.status !== 200) return { kind: 'failed' };
    const body: unknown = await res.json();
    if (!isSnapshotBody(body)) return { kind: 'failed' };
    await saveSnapshot({ body, etag: res.headers.get('etag') ?? '', fetchedAtMs: deps.nowMs });
    await resumeAbove({ lastSeq: body.device.lastSeq, lastTerminalSeq: body.device.lastTerminalSeq });
    await expireRevokedVerifiers(body.staff);
    return { kind: 'updated' };
  } catch {
    return { kind: 'failed' };
  }
}
