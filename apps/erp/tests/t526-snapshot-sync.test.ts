// ASSUMED API (T-530a): saveSnapshot, touchSnapshot, readSnapshot, isSnapshotUsable, resumeAbove({ lastSeq, lastTerminalSeq }), listVerifiers, deleteVerifier,
//   all imported ONLY through the index `@/lib/pos-device` (mocked here at the module boundary; isSnapshotUsable is given its real pure rule).
// ASSUMED API: apps/erp/src/app/pos/_shell/constants.ts exports POS_OFFLINE_SNAPSHOT_MAX_AGE_MS (= 24 h), POS_SNAPSHOT_REFRESH_MS (= 5 min),
//   POS_POLL_INTERVAL_MS (= 3000), POS_DRAIN_INTERVAL_MS (= 10_000).
// ASSUMED API: apps/erp/src/app/pos/_shell/verifier-expiry.ts exports expireRevokedVerifiers(staff): Promise<void>.
// ASSUMED API: apps/erp/src/app/pos/_shell/snapshot-sync.ts exports
//   refreshSnapshot({ fetch, nowMs }): Promise<{ kind: 'updated' | 'not_modified' | 'failed' | 'unpaired' }>
//   (GET /api/pos/snapshot with credentials 'same-origin' and If-None-Match from readSnapshot().etag)
// ASSUMED API: apps/erp/src/app/pos/_shell/messages.ts exports POS_NEEDS_INTERNET_ONCE, POS_TABLET_UNPAIRED_MESSAGE.
/**
 * T-526 R3 / R4 / R6 - the snapshot refresh cycle (200 saves + resumes + expires revoked verifiers; 304 touches; failure keeps the cache) and the
 * expiry of verifiers for staff who left the list. Written BEFORE the code (tester lane).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dev } = vi.hoisted(() => ({
  dev: {
    saveSnapshot: vi.fn(async () => undefined),
    touchSnapshot: vi.fn(async () => undefined),
    readSnapshot: vi.fn(async (): Promise<unknown> => null),
    resumeAbove: vi.fn(async () => undefined),
    bindPairing: vi.fn(async (_id: string) => undefined), // T-563
    listVerifiers: vi.fn(async (): Promise<unknown[]> => []),
    deleteVerifier: vi.fn(async (_personId: string): Promise<void> => undefined),
    isSnapshotUsable: (s: { fetchedAtMs: number } | null, nowMs: number, maxAgeMs: number) => s !== null && nowMs - s.fetchedAtMs <= maxAgeMs,
  },
}));
vi.mock('@/lib/pos-device', () => dev);

import { POS_DRAIN_INTERVAL_MS, POS_OFFLINE_SNAPSHOT_MAX_AGE_MS, POS_POLL_INTERVAL_MS, POS_SNAPSHOT_REFRESH_MS } from '@/app/pos/_shell/constants';
import { POS_NEEDS_INTERNET_ONCE, POS_TABLET_UNPAIRED_MESSAGE } from '@/app/pos/_shell/messages';
import { refreshSnapshot } from '@/app/pos/_shell/snapshot-sync';
import { expireRevokedVerifiers } from '@/app/pos/_shell/verifier-expiry';

const NOW = 1_800_000_000_000;
const staff = [
  { personId: 'p-ana', displayName: 'Ana Cruz', employeeId: '007', posCapabilities: ['record_sale'] },
  { personId: 'p-ben', displayName: 'Ben Reyes', employeeId: '012', posCapabilities: ['serve_pos_ticket'] },
];
const verifier = (personId: string, employeeId: string) => ({ personId, employeeId, salt: 's', hash: 'h', iterations: 210000, createdAtMs: NOW - 1000 });
const body = { ok: true, staff, device: { pairingId: 'pair-1', lastSeq: 40, lastTerminalSeq: 9 }, rules: null };

beforeEach(() => {
  for (const f of [dev.saveSnapshot, dev.touchSnapshot, dev.readSnapshot, dev.resumeAbove, dev.bindPairing, dev.listVerifiers, dev.deleteVerifier]) f.mockClear();
  dev.readSnapshot.mockResolvedValue(null);
  dev.listVerifiers.mockResolvedValue([]);
});

describe('T-526 R3 - the named constants (protocol limits, not business settings)', () => {
  it('24 h offline limit, 5 min snapshot refresh, 3 s state poll, 10 s drain', () => {
    expect(POS_OFFLINE_SNAPSHOT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(POS_SNAPSHOT_REFRESH_MS).toBe(5 * 60 * 1000);
    expect(POS_POLL_INTERVAL_MS).toBe(3000);
    expect(POS_DRAIN_INTERVAL_MS).toBe(10_000);
  });
  it('the exact sentences', () => {
    expect(POS_NEEDS_INTERNET_ONCE).toBe('This tablet needs the internet once to load the menu.');
    expect(POS_TABLET_UNPAIRED_MESSAGE).toBe('This tablet was un-paired. Ask a manager to pair it again.');
  });
});

describe('T-526 R3 - refreshSnapshot', () => {
  it('a 200: saves body + etag + fetch time, resumes the counters from device, then drops verifiers of people no longer in staff', async () => {
    dev.listVerifiers.mockResolvedValue([verifier('p-ana', '007'), verifier('p-gone', '099')]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { etag: '"v1"', 'content-type': 'application/json' } }));
    const r = await refreshSnapshot({ fetch: fetchMock as unknown as typeof fetch, nowMs: NOW });
    expect(r.kind).toBe('updated');
    expect(dev.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(dev.saveSnapshot).toHaveBeenCalledWith({ body, etag: '"v1"', fetchedAtMs: NOW });
    expect(dev.resumeAbove).toHaveBeenCalledWith({ lastSeq: 40, lastTerminalSeq: 9 });
    expect(dev.deleteVerifier).toHaveBeenCalledTimes(1);
    expect(dev.deleteVerifier).toHaveBeenCalledWith('p-gone');
    expect(dev.touchSnapshot).not.toHaveBeenCalled();
  });

  it('sends the same-origin cookie and the cached etag as If-None-Match', async () => {
    dev.readSnapshot.mockResolvedValue({ body, etag: '"v0"', fetchedAtMs: NOW - 1000 });
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    await refreshSnapshot({ fetch: fetchMock as unknown as typeof fetch, nowMs: NOW });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/pos/snapshot');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('if-none-match')).toBe('"v0"');
  });

  it('a 304: only touches the fetch time; nothing saved, nothing resumed, no verifier deleted (expiry is a 200-only duty)', async () => {
    dev.readSnapshot.mockResolvedValue({ body, etag: '"v0"', fetchedAtMs: NOW - 1000 });
    dev.listVerifiers.mockResolvedValue([verifier('p-gone', '099')]);
    const r = await refreshSnapshot({ fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch, nowMs: NOW });
    expect(r.kind).toBe('not_modified');
    expect(dev.touchSnapshot).toHaveBeenCalledWith(NOW);
    expect(dev.saveSnapshot).not.toHaveBeenCalled();
    expect(dev.resumeAbove).not.toHaveBeenCalled();
    expect(dev.deleteVerifier).not.toHaveBeenCalled();
  });

  it('a network failure keeps the cached snapshot untouched (A6: never blank it): no save, no touch, no verifier deleted', async () => {
    dev.readSnapshot.mockResolvedValue({ body, etag: '"v0"', fetchedAtMs: NOW - 1000 });
    dev.listVerifiers.mockResolvedValue([verifier('p-gone', '099')]);
    const r = await refreshSnapshot({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      nowMs: NOW,
    });
    expect(r.kind).toBe('failed');
    expect(dev.saveSnapshot).not.toHaveBeenCalled();
    expect(dev.touchSnapshot).not.toHaveBeenCalled();
    expect(dev.deleteVerifier).not.toHaveBeenCalled();
  });

  it('a 5xx keeps the cache the same way', async () => {
    const r = await refreshSnapshot({ fetch: (async () => new Response('{"ok":false}', { status: 503 })) as unknown as typeof fetch, nowMs: NOW });
    expect(r.kind).toBe('failed');
    expect(dev.saveSnapshot).not.toHaveBeenCalled();
    expect(dev.touchSnapshot).not.toHaveBeenCalled();
  });

  it('a 401 means the pairing is dead: reported as unpaired, and the cache is still not blanked', async () => {
    const r = await refreshSnapshot({ fetch: (async () => new Response('{"ok":false,"error":"x"}', { status: 401 })) as unknown as typeof fetch, nowMs: NOW });
    expect(r.kind).toBe('unpaired');
    expect(dev.saveSnapshot).not.toHaveBeenCalled();
    expect(dev.deleteVerifier).not.toHaveBeenCalled();
  });
});

describe('T-526 R4 - expireRevokedVerifiers', () => {
  it('deletes only the verifiers whose person is no longer in staff', async () => {
    dev.listVerifiers.mockResolvedValue([verifier('p-ana', '007'), verifier('p-ben', '012'), verifier('p-gone', '099')]);
    await expireRevokedVerifiers(staff);
    expect(dev.deleteVerifier.mock.calls).toEqual([['p-gone']]);
  });

  it('control: everyone still on staff -> nothing deleted', async () => {
    dev.listVerifiers.mockResolvedValue([verifier('p-ana', '007'), verifier('p-ben', '012')]);
    await expireRevokedVerifiers(staff);
    expect(dev.deleteVerifier).not.toHaveBeenCalled();
  });

  it('an empty staff list drops every verifier (a store emptied of staff keeps nobody offline)', async () => {
    dev.listVerifiers.mockResolvedValue([verifier('p-ana', '007'), verifier('p-ben', '012')]);
    await expireRevokedVerifiers([]);
    expect(dev.deleteVerifier.mock.calls.map((c) => c[0]).sort()).toEqual(['p-ana', 'p-ben']);
  });
});
