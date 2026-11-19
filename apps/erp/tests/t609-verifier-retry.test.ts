/**
 * T-609 - a failed verifier delete is RETRIED at the next refresh. The new etag is saved only after the expiry has run, so a throwing
 * delete fails the refresh and the next one gets a 200 again (not a 304 that would leave the revoked verifier on the tablet).
 * Mutant (run by hand): move `expireRevokedVerifiers` back after `saveSnapshot` - the retry answers 304 and the verifier stays: red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb } from './helpers/fake-idb';

const ctl = vi.hoisted(() => ({ failDelete: false }));
vi.mock('@/lib/pos-device', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pos-device')>();
  return { ...real, deleteVerifier: async (id: string) => (ctl.failDelete ? Promise.reject(new Error('disk full')) : real.deleteVerifier(id)) };
});

import { listVerifiers, putVerifier, readSnapshot } from '@/lib/pos-device';
import { refreshSnapshot } from '@/app/pos/_shell/snapshot-sync';

const NOW = 1_800_000_000_000;
const body = { staff: [{ personId: 'p-ana', employeeId: '007', displayName: 'Ana', posCapabilities: [] }], device: { pairingId: 'pair-1', lastSeq: 0, lastTerminalSeq: 0 }, rules: null };
// An honest server: 304 when the tablet already holds this etag, else the 200.
const server = (async (_u: string, init: RequestInit) =>
  new Headers(init.headers).get('if-none-match') === '"v1"' ? new Response(null, { status: 304 }) : new Response(JSON.stringify(body), { status: 200, headers: { etag: '"v1"' } })) as unknown as typeof fetch;

beforeEach(async () => {
  vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 1 }));
  ctl.failDelete = false;
  for (const [id, code] of [['p-ana', '007'], ['p-gone', '099']] as const) await putVerifier({ personId: id, employeeId: code, salt: 's', hash: 'h', iterations: 210_000, createdAtMs: NOW });
});
afterEach(() => vi.unstubAllGlobals());

describe('T-609 - a delete that fails is retried at the next refresh', () => {
  it('the failed refresh keeps no new etag, and the next refresh deletes the verifier', async () => {
    ctl.failDelete = true;
    expect((await refreshSnapshot({ fetch: server, nowMs: NOW })).kind).toBe('failed');
    expect(await readSnapshot(), 'no etag saved on a failed expiry').toBeNull();
    expect(await listVerifiers()).toHaveLength(2);

    ctl.failDelete = false;
    expect((await refreshSnapshot({ fetch: server, nowMs: NOW + 1 })).kind).toBe('updated');
    expect((await listVerifiers()).map((v) => v.personId)).toEqual(['p-ana']);
  });
});
