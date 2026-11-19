/**
 * T-609 test 5 - a person who can no longer sign in at the store is DELETED from the tablet's own store at the next snapshot refresh.
 * Real `refreshSnapshot` + real `verifier-store` over the fake IndexedDB the T-530a tests use: what is judged is what is left on the device.
 * Mutant (run by hand): make `expireRevokedVerifiers` add-only (drop the `deleteVerifier` call) - the first case goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb } from './helpers/fake-idb';
import { listVerifiers, putVerifier } from '@/lib/pos-device';
import { refreshSnapshot } from '@/app/pos/_shell/snapshot-sync';

const NOW = 1_800_000_000_000;
const verifier = (personId: string, employeeId: string) => ({ personId, employeeId, salt: 's', hash: 'h', iterations: 210_000, createdAtMs: NOW - 1000 });
const staff = (...ids: string[]) => ids.map((id) => ({ personId: id, employeeId: id.slice(-3), displayName: id, posCapabilities: ['record_sale'] }));
const snapshotResponse = (list: ReturnType<typeof staff>) =>
  (async () => new Response(JSON.stringify({ staff: list, device: { pairingId: 'pair-1', lastSeq: 0, lastTerminalSeq: 0 }, rules: null }), { status: 200, headers: { etag: '"v"' } })) as unknown as typeof fetch;

beforeEach(async () => {
  vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 1 }));
  for (const v of [verifier('p-ana', '007'), verifier('p-ben', '012'), verifier('p-gone', '099')]) await putVerifier(v);
});
afterEach(() => vi.unstubAllGlobals());

describe('T-609 - the device drops the verifiers a delivery no longer lists', () => {
  it('a person removed from the delivery is deleted from the local store; the others stay', async () => {
    const r = await refreshSnapshot({ fetch: snapshotResponse(staff('p-ana', 'p-ben')), nowMs: NOW });
    expect(r.kind).toBe('updated');
    expect((await listVerifiers()).map((v) => v.personId).sort()).toEqual(['p-ana', 'p-ben']);
  });

  it('control: a delivery listing everyone deletes nobody', async () => {
    await refreshSnapshot({ fetch: snapshotResponse(staff('p-ana', 'p-ben', 'p-gone')), nowMs: NOW });
    expect(await listVerifiers()).toHaveLength(3);
  });

  it('a failed refresh deletes nothing (offline revocation can only wait for the next successful sync)', async () => {
    const r = await refreshSnapshot({ fetch: (async () => new Response('x', { status: 503 })) as unknown as typeof fetch, nowMs: NOW });
    expect(r.kind).toBe('failed');
    expect(await listVerifiers()).toHaveLength(3);
  });
});
