/**
 * T-559 R3 / R4 (TESTER, written before the code) - the 304 handoff: S4 audit item (1). A boundary that changes nothing visible gives a 304; the cached
 * `nextChangeAt` must still move to the `x-next-change-at` header, or the shell's timer is dead after that boundary. docs/tasks/559 R3.
 * Runs against the REAL device store (T-530a, IndexedDB via the fake-idb helper), so the store and the sync are tested together.
 * CONTRACT (backward compatible): touchSnapshot(fetchedAtMs, nextChangeAt?) - the second argument is optional; without it the stored value stays.
 *   CachedSnapshot gains an optional `nextChangeAt?: string | null`. A 200 is saved exactly as before ({ body, etag, fetchedAtMs }).
 *   snapshotNextChangeAt(cached) = cached.nextChangeAt ?? cached.body.menu.nextChangeAt ?? null   (apps/erp/src/app/pos/_shell/snapshot-sync.ts)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb } from './helpers/fake-idb';
import { readSnapshot, saveSnapshot, touchSnapshot } from '@/lib/pos-device';
import { refreshSnapshot, snapshotNextChangeAt } from '@/app/pos/_shell/snapshot-sync';

const NOW = 1_800_000_000_000;
const staff = [{ personId: 'p-ana', displayName: 'Ana Cruz', employeeId: '007', posCapabilities: ['record_sale'] }];
const menu = { menu: { schemaVersion: 2 }, contentHash: 'h1', nextChangeAt: '2026-11-01T09:00:00.000Z' };
const body = { ok: true, staff, device: { pairingId: 'pair-1', lastSeq: 40, lastTerminalSeq: 9 }, rules: null, stands: [], menu };

beforeEach(async () => {
  vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 2 }));
  await saveSnapshot({ body, etag: '"v0"', fetchedAtMs: NOW - 1000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the device module: touchSnapshot(fetchedAtMs, nextChangeAt?)', () => {
  it('with a second argument it stores that next-change time and the new fetch time, and leaves body and etag alone', async () => {
    await touchSnapshot(NOW, '2026-11-01T10:00:00.000Z');
    expect(await readSnapshot()).toEqual({ body, etag: '"v0"', fetchedAtMs: NOW, nextChangeAt: '2026-11-01T10:00:00.000Z' });
  });
  it('backward compatible: without it only the fetch time moves, and an earlier stored next-change time stays', async () => {
    await touchSnapshot(NOW - 500, '2026-11-01T10:00:00.000Z');
    await touchSnapshot(NOW);
    expect(await readSnapshot()).toMatchObject({ fetchedAtMs: NOW, nextChangeAt: '2026-11-01T10:00:00.000Z' });
  });
  it('with nothing stored it does nothing and does not throw', async () => {
    vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 2 })); // a fresh, empty device database
    await expect(touchSnapshot(NOW, '2026-11-01T10:00:00.000Z')).resolves.toBeUndefined();
    expect(await readSnapshot()).toBeNull();
  });
});

describe('refreshSnapshot on a 304 hands the header to the cache', () => {
  const answer = (headers: Record<string, string>) => (async () => new Response(null, { status: 304, headers })) as unknown as typeof fetch;
  it('x-next-change-at on a 304 becomes the cached nextChangeAt (a boundary that changed nothing visible keeps the timer alive)', async () => {
    const r = await refreshSnapshot({ fetch: answer({ 'x-next-change-at': '2026-11-02T00:00:00.000Z' }), nowMs: NOW });
    expect(r.kind).toBe('not_modified');
    const cached = await readSnapshot();
    expect(cached).toMatchObject({ fetchedAtMs: NOW, nextChangeAt: '2026-11-02T00:00:00.000Z' });
    expect(snapshotNextChangeAt(cached)).toBe('2026-11-02T00:00:00.000Z');
  });
  it('a 304 with no header, or one that is not a time, leaves the stored time alone (and still stamps the fetch time)', async () => {
    await refreshSnapshot({ fetch: answer({}), nowMs: NOW });
    expect(await readSnapshot()).toMatchObject({ fetchedAtMs: NOW });
    expect((await readSnapshot())!.nextChangeAt).toBeUndefined();
    await refreshSnapshot({ fetch: answer({ 'x-next-change-at': 'soon' }), nowMs: NOW + 1 });
    expect((await readSnapshot())!.nextChangeAt).toBeUndefined();
  });
  it('a 200 is saved exactly as before (the menu inside already carries its own nextChangeAt)', async () => {
    const r = await refreshSnapshot({ fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { etag: '"v1"', 'x-next-change-at': '2026-11-03T00:00:00.000Z' } })) as unknown as typeof fetch, nowMs: NOW });
    expect(r.kind).toBe('updated');
    expect(await readSnapshot()).toEqual({ body, etag: '"v1"', fetchedAtMs: NOW });
  });
});

describe('snapshotNextChangeAt', () => {
  it('prefers the 304-updated cached value, falls back to the menu inside the body, else null', () => {
    expect(snapshotNextChangeAt({ body, etag: 'e', fetchedAtMs: 1, nextChangeAt: '2026-11-02T00:00:00.000Z' })).toBe('2026-11-02T00:00:00.000Z');
    expect(snapshotNextChangeAt({ body, etag: 'e', fetchedAtMs: 1 })).toBe('2026-11-01T09:00:00.000Z');
    expect(snapshotNextChangeAt({ body: { ...body, menu: { menu: {}, contentHash: 'x', nextChangeAt: null } }, etag: 'e', fetchedAtMs: 1 })).toBeNull();
    expect(snapshotNextChangeAt({ body: {}, etag: 'e', fetchedAtMs: 1 })).toBeNull();
    expect(snapshotNextChangeAt(null)).toBeNull();
  });
});
