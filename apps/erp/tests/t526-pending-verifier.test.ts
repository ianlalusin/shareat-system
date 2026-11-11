// ASSUMED API (T-530a): putVerifier(v: StoredVerifier): Promise<void>, imported ONLY through the index `@/lib/pos-device` (mocked here at the module boundary).
// ASSUMED API: apps/erp/src/app/pos/_shell/pending-verifier.ts exports
//   POS_PENDING_VERIFIER_KEY = 'shareat_pos_pending_verifier'
//   POS_PENDING_VERIFIER_MAX_AGE_MS = 300_000
//   savePendingVerifier(storage, { employeeId, pin, nowMs }): Promise<void>        (the TabletSignInForm onSubmit hook calls it)
//   promotePendingVerifier({ storage, staff, personId, nowMs }): Promise<void>      (first /pos load after sign-in)
//   storage is `Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>`.
// ASSUMED API: apps/erp/src/lib/pos-device/pin-verifier.ts (see t526-pin-verifier.test.ts).
/**
 * T-526 R4 / R6 - the pending verifier: made in the browser at online sign-in, promoted on the first /pos load, ALWAYS deleted.
 * Written BEFORE the code (tester lane).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dev } = vi.hoisted(() => ({ dev: { putVerifier: vi.fn(async () => undefined) } }));
vi.mock('@/lib/pos-device', () => ({ putVerifier: dev.putVerifier }));

import { POS_PENDING_VERIFIER_KEY, POS_PENDING_VERIFIER_MAX_AGE_MS, promotePendingVerifier, savePendingVerifier } from '@/app/pos/_shell/pending-verifier';
import { POS_VERIFIER_ITERATIONS, deriveVerifier, verifyPin } from '@/lib/pos-device/pin-verifier';

const NOW = 1_800_000_000_000;
const PIN = '482916';
const staff = [
  { personId: 'p-ana', displayName: 'Ana Cruz', employeeId: '007', posCapabilities: ['record_sale'] },
  { personId: 'p-ben', displayName: 'Ben Reyes', employeeId: '012', posCapabilities: ['serve_pos_ticket'] },
];

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (...p: string[]) => readFileSync(resolve(here, '..', 'src', ...p), 'utf8');

let good: Awaited<ReturnType<typeof deriveVerifier>>;
beforeAll(async () => {
  good = await deriveVerifier(PIN);
}, 30_000);
beforeEach(() => dev.putVerifier.mockClear());

const pending = (employeeId: string, createdAtMs: number) => JSON.stringify({ employeeId, ...good, createdAtMs });

describe('T-526 R4 - savePendingVerifier (what the sign-in form does before it submits)', () => {
  it('stores exactly {employeeId, salt, hash, iterations, createdAtMs} under the named key, and never the PIN', async () => {
    const s = fakeStorage();
    await savePendingVerifier(s, { employeeId: '007', pin: PIN, nowMs: NOW });
    expect(POS_PENDING_VERIFIER_KEY).toBe('shareat_pos_pending_verifier');
    expect([...s.m.keys()]).toEqual([POS_PENDING_VERIFIER_KEY]);
    const raw = s.m.get(POS_PENDING_VERIFIER_KEY)!;
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(['createdAtMs', 'employeeId', 'hash', 'iterations', 'salt']);
    expect(parsed.employeeId).toBe('007');
    expect(parsed.createdAtMs).toBe(NOW);
    expect(parsed.iterations).toBe(POS_VERIFIER_ITERATIONS);
    expect(raw).not.toContain(PIN);
    expect(await verifyPin(PIN, parsed)).toBe(true);
    expect(await verifyPin('000000', parsed)).toBe(false);
  }, 30_000);

  it('a later attempt REPLACES the pending entry (a wrong PIN never promoted, the next attempt overwrites it)', async () => {
    const s = fakeStorage();
    await savePendingVerifier(s, { employeeId: '007', pin: '111111', nowMs: NOW });
    const first = s.m.get(POS_PENDING_VERIFIER_KEY);
    await savePendingVerifier(s, { employeeId: '012', pin: PIN, nowMs: NOW + 5000 });
    expect(s.m.size).toBe(1);
    expect(s.m.get(POS_PENDING_VERIFIER_KEY)).not.toBe(first);
    expect(JSON.parse(s.m.get(POS_PENDING_VERIFIER_KEY)!).employeeId).toBe('012');
  }, 30_000);

  it('the sign-in form wires it: TabletSignInForm has an onSubmit hook, still posts to signInWithTabletPinAction, and uses sessionStorage not localStorage', () => {
    const src = srcOf('app', 'sign-in', 'TabletSignInForm.tsx');
    expect(src).toMatch(/onSubmit=/);
    expect(src).toContain('savePendingVerifier');
    expect(src).toContain('action={signInWithTabletPinAction}');
    expect(src).toContain('sessionStorage');
    expect(src).not.toContain('localStorage');
  });

  it('the pending module never uses localStorage, console or fetch (the PIN and its verifier stay on the tablet)', () => {
    expect(srcOf('app', 'pos', '_shell', 'pending-verifier.ts')).not.toMatch(/localStorage|\bconsole\.|\bfetch\(/);
  });
});

describe('T-526 R4 - promotePendingVerifier (first /pos load after sign-in)', () => {
  it('a matching, fresh pending verifier is stored with the personId from the staff list, and the pending entry is deleted', async () => {
    const s = fakeStorage();
    s.setItem(POS_PENDING_VERIFIER_KEY, pending('007', NOW - 60_000));
    await promotePendingVerifier({ storage: s, staff, personId: 'p-ana', nowMs: NOW });
    expect(dev.putVerifier).toHaveBeenCalledTimes(1);
    expect(dev.putVerifier).toHaveBeenCalledWith({
      personId: 'p-ana',
      employeeId: '007',
      salt: good.salt,
      hash: good.hash,
      iterations: good.iterations,
      createdAtMs: NOW - 60_000,
    });
    expect(s.getItem(POS_PENDING_VERIFIER_KEY)).toBeNull();
  });

  it('a pending verifier for a DIFFERENT employee than the signed-in person is not stored, and is still deleted', async () => {
    const s = fakeStorage();
    s.setItem(POS_PENDING_VERIFIER_KEY, pending('012', NOW - 1000));
    await promotePendingVerifier({ storage: s, staff, personId: 'p-ana', nowMs: NOW });
    expect(dev.putVerifier).not.toHaveBeenCalled();
    expect(s.getItem(POS_PENDING_VERIFIER_KEY)).toBeNull();
  });

  it('the window is 5 minutes: exactly 5:00 old is stored, 1 ms older is not (both deleted)', async () => {
    expect(POS_PENDING_VERIFIER_MAX_AGE_MS).toBe(300_000);
    const edge = fakeStorage();
    edge.setItem(POS_PENDING_VERIFIER_KEY, pending('007', NOW - 300_000));
    await promotePendingVerifier({ storage: edge, staff, personId: 'p-ana', nowMs: NOW });
    expect(dev.putVerifier).toHaveBeenCalledTimes(1);
    expect(edge.getItem(POS_PENDING_VERIFIER_KEY)).toBeNull();

    dev.putVerifier.mockClear();
    const stale = fakeStorage();
    stale.setItem(POS_PENDING_VERIFIER_KEY, pending('007', NOW - 300_001));
    await promotePendingVerifier({ storage: stale, staff, personId: 'p-ana', nowMs: NOW });
    expect(dev.putVerifier).not.toHaveBeenCalled();
    expect(stale.getItem(POS_PENDING_VERIFIER_KEY)).toBeNull();
  });

  it('no pending entry is a no-op: nothing stored, nothing thrown', async () => {
    const s = fakeStorage();
    await expect(promotePendingVerifier({ storage: s, staff, personId: 'p-ana', nowMs: NOW })).resolves.toBeUndefined();
    expect(dev.putVerifier).not.toHaveBeenCalled();
    expect(s.m.size).toBe(0);
  });

  it('a signed-in person who is not in the snapshot staff list gets nothing stored (pending deleted)', async () => {
    const s = fakeStorage();
    s.setItem(POS_PENDING_VERIFIER_KEY, pending('007', NOW - 1000));
    await promotePendingVerifier({ storage: s, staff, personId: 'p-nobody', nowMs: NOW });
    expect(dev.putVerifier).not.toHaveBeenCalled();
    expect(s.getItem(POS_PENDING_VERIFIER_KEY)).toBeNull();
  });

  it('garbage in the pending slot is not stored, does not throw, and is deleted', async () => {
    for (const junk of ['{not json', '"a string"', '{"employeeId":"007"}', 'null']) {
      const s = fakeStorage();
      s.setItem(POS_PENDING_VERIFIER_KEY, junk);
      await expect(promotePendingVerifier({ storage: s, staff, personId: 'p-ana', nowMs: NOW })).resolves.toBeUndefined();
      expect(dev.putVerifier, junk).not.toHaveBeenCalled();
      expect(s.getItem(POS_PENDING_VERIFIER_KEY), junk).toBeNull();
    }
  });
});
