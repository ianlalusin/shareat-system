// ASSUMED API (T-530a): readSnapshot, isSnapshotUsable, getVerifierByEmployeeId, imported ONLY through the index `@/lib/pos-device` (mocked at the module boundary;
//   isSnapshotUsable is given its real pure rule: usable when now - fetchedAtMs <= maxAgeMs).
// ASSUMED API (NOT in the T-530a contract, see the hand-back question): a durable key-value port for the miss counter. The spec says it lives in the device
//   store's `meta`, but T-530a exposes no meta accessor. T-526 therefore takes an injected port: `meta: { get(key): Promise<unknown>; set(key, value): Promise<void> }`.
// ASSUMED API: apps/erp/src/app/pos/_shell/offline-switch.ts exports
//   attemptOfflineSwitch({ employeeId, pin, nowMs, meta, storage }): Promise<
//     | { ok: true; personId: string; displayName: string; posCapabilities: string[] }
//     | { ok: false; reason: 'wrong' | 'paused' | 'snapshot_unusable'; message: string } >
//   On ok it writes the actor to `storage` (sessionStorage port, setItem) so a reload keeps it; on any refusal it writes nothing.
// ASSUMED API: apps/erp/src/app/pos/_shell/constants.ts exports POS_OFFLINE_SNAPSHOT_MAX_AGE_MS (see t526-snapshot-sync.test.ts).
// ASSUMED API: apps/erp/src/lib/pos-device/pin-verifier.ts (see t526-pin-verifier.test.ts).
/**
 * T-526 R5 / R6 - the offline cashier switch: right PIN sets the actor; 5 misses pause that Employee ID for 5 minutes (injected clock); the count and the
 * pause survive a reopen; a snapshot older than 24 hours refuses offline sign-in. Written BEFORE the code (tester lane).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dev } = vi.hoisted(() => ({
  dev: {
    readSnapshot: vi.fn(async (): Promise<unknown> => null),
    getVerifierByEmployeeId: vi.fn(async (_employeeId: string): Promise<unknown> => null),
    isSnapshotUsable: (s: { fetchedAtMs: number } | null, nowMs: number, maxAgeMs: number) => s !== null && nowMs - s.fetchedAtMs <= maxAgeMs,
  },
}));
vi.mock('@/lib/pos-device', () => dev);

import { deriveVerifier } from '@/lib/pos-device/pin-verifier';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const PIN_ANA = '482916';
const PIN_BEN = '135790';
const WRONG = 'Wrong Employee ID or PIN.';
const PAUSED = 'Too many wrong PINs for this Employee ID. Wait 5 minutes.';
const staff = [
  { personId: 'p-ana', displayName: 'Ana Cruz', employeeId: '007', posCapabilities: ['record_sale', 'request_pos_refill'] },
  { personId: 'p-ben', displayName: 'Ben Reyes', employeeId: '012', posCapabilities: ['serve_pos_ticket'] },
];
const snapshotAt = (fetchedAtMs: number, st = staff) => ({ body: { staff: st }, etag: '"e"', fetchedAtMs });

function memoryMeta() {
  const m = new Map<string, unknown>();
  return { m, get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => void m.set(k, v) };
}
function fakeStorage() {
  const m = new Map<string, string>();
  return { m, setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
}

let anaV: Record<string, unknown>;
let benV: Record<string, unknown>;
beforeAll(async () => {
  anaV = { personId: 'p-ana', employeeId: '007', ...(await deriveVerifier(PIN_ANA)), createdAtMs: NOW - 1000 };
  benV = { personId: 'p-ben', employeeId: '012', ...(await deriveVerifier(PIN_BEN)), createdAtMs: NOW - 1000 };
}, 30_000);

beforeEach(() => {
  dev.readSnapshot.mockReset();
  dev.getVerifierByEmployeeId.mockReset();
  dev.readSnapshot.mockResolvedValue(snapshotAt(NOW - 1000));
  dev.getVerifierByEmployeeId.mockImplementation(async (id: string) => (id === '007' ? anaV : id === '012' ? benV : null));
});

async function loadSwitch() {
  vi.resetModules(); // a "reopen": no in-memory state survives, only what the meta port holds
  return (await import('@/app/pos/_shell/offline-switch')).attemptOfflineSwitch;
}

describe('T-526 R5 - offline switch: the PIN check', () => {
  it('the right Employee ID + PIN sets the actor: the snapshot person, name and capabilities, and writes it to sessionStorage', async () => {
    const attempt = await loadSwitch();
    const storage = fakeStorage();
    const r = await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW, meta: memoryMeta(), storage });
    expect(r).toEqual({ ok: true, personId: 'p-ana', displayName: 'Ana Cruz', posCapabilities: ['record_sale', 'request_pos_refill'] });
    expect(storage.m.size).toBe(1);
    expect([...storage.m.values()][0]).toContain('p-ana');
    expect([...storage.m.values()].join('')).not.toContain(PIN_ANA);
  }, 30_000);

  it('a wrong PIN says exactly "Wrong Employee ID or PIN." and writes no actor', async () => {
    const attempt = await loadSwitch();
    const storage = fakeStorage();
    const r = await attempt({ employeeId: '007', pin: '000000', nowMs: NOW, meta: memoryMeta(), storage });
    expect(r).toEqual({ ok: false, reason: 'wrong', message: WRONG });
    expect(storage.m.size).toBe(0);
  }, 30_000);

  it('an unknown Employee ID gets the SAME sentence (no hint which half was wrong)', async () => {
    const attempt = await loadSwitch();
    const r = await attempt({ employeeId: '555', pin: PIN_ANA, nowMs: NOW, meta: memoryMeta(), storage: fakeStorage() });
    expect(r).toEqual({ ok: false, reason: 'wrong', message: WRONG });
  });

  it('a verifier whose person is no longer in the snapshot staff list does not sign in, even with the right PIN', async () => {
    dev.readSnapshot.mockResolvedValue(snapshotAt(NOW - 1000, [staff[1]!]));
    const attempt = await loadSwitch();
    const r = await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW, meta: memoryMeta(), storage: fakeStorage() });
    expect(r).toMatchObject({ ok: false, reason: 'wrong', message: WRONG });
  }, 30_000);
});

describe('T-526 R4/R5 - the 24 hour snapshot limit', () => {
  it('a snapshot exactly 24 h old still allows the switch; 1 ms older refuses it, with the right PIN, and writes no actor', async () => {
    const attempt = await loadSwitch();
    dev.readSnapshot.mockResolvedValue(snapshotAt(NOW - DAY));
    expect((await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW, meta: memoryMeta(), storage: fakeStorage() })).ok).toBe(true);

    dev.readSnapshot.mockResolvedValue(snapshotAt(NOW - DAY - 1));
    const storage = fakeStorage();
    const r = await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW, meta: memoryMeta(), storage });
    expect(r).toMatchObject({ ok: false, reason: 'snapshot_unusable' });
    expect(storage.m.size).toBe(0);
  }, 30_000);

  it('no snapshot at all (never signed in online) refuses too', async () => {
    dev.readSnapshot.mockResolvedValue(null);
    const attempt = await loadSwitch();
    expect(await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW, meta: memoryMeta(), storage: fakeStorage() })).toMatchObject({ ok: false, reason: 'snapshot_unusable' });
  });
});

describe('T-526 R5 - 5 misses pause an Employee ID for 5 minutes (injected clock)', () => {
  async function miss(attempt: Awaited<ReturnType<typeof loadSwitch>>, meta: ReturnType<typeof memoryMeta>, at: number, id = '007') {
    return attempt({ employeeId: id, pin: '000000', nowMs: at, meta, storage: fakeStorage() });
  }

  it('misses 1 to 5 each say "Wrong..."; the 6th attempt, with the RIGHT PIN, is refused as paused with the T-464 sentence', async () => {
    const attempt = await loadSwitch();
    const meta = memoryMeta();
    for (let i = 1; i <= 5; i++) expect(await miss(attempt, meta, NOW + i * 1000), `miss ${i}`).toEqual({ ok: false, reason: 'wrong', message: WRONG });
    const sixth = await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW + 6000, meta, storage: fakeStorage() });
    expect(sixth).toEqual({ ok: false, reason: 'paused', message: PAUSED });
  }, 60_000);

  it('4 misses is NOT a pause: the right PIN still signs in (the control for the 5th)', async () => {
    const attempt = await loadSwitch();
    const meta = memoryMeta();
    for (let i = 1; i <= 4; i++) await miss(attempt, meta, NOW + i * 1000);
    expect((await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW + 5000, meta, storage: fakeStorage() })).ok).toBe(true);
  }, 60_000);

  it('the pause lasts 5 minutes from the 5th miss: still paused 1 ms before, signed in again after', async () => {
    const attempt = await loadSwitch();
    const meta = memoryMeta();
    const fifth = NOW + 5000;
    for (let i = 1; i <= 4; i++) await miss(attempt, meta, NOW + i * 1000);
    await miss(attempt, meta, fifth);
    expect(await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: fifth + FIVE_MIN - 1, meta, storage: fakeStorage() })).toMatchObject({ ok: false, reason: 'paused' });
    expect((await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: fifth + FIVE_MIN + 1, meta, storage: fakeStorage() })).ok).toBe(true);
  }, 60_000);

  it('the pause is per Employee ID: 012 signs in while 007 is paused', async () => {
    const attempt = await loadSwitch();
    const meta = memoryMeta();
    for (let i = 1; i <= 5; i++) await miss(attempt, meta, NOW + i * 1000);
    const r = await attempt({ employeeId: '012', pin: PIN_BEN, nowMs: NOW + 6000, meta, storage: fakeStorage() });
    expect(r).toMatchObject({ ok: true, personId: 'p-ben' });
  }, 60_000);

  it('the pause survives a reopen (modules reloaded, same durable meta)', async () => {
    const meta = memoryMeta();
    const first = await loadSwitch();
    for (let i = 1; i <= 5; i++) await miss(first, meta, NOW + i * 1000);
    const reopened = await loadSwitch();
    expect(await reopened({ employeeId: '007', pin: PIN_ANA, nowMs: NOW + 6000, meta, storage: fakeStorage() })).toEqual({ ok: false, reason: 'paused', message: PAUSED });
  }, 60_000);

  it('the miss COUNT survives a reopen too: 3 misses, reopen, 2 more -> paused', async () => {
    const meta = memoryMeta();
    const first = await loadSwitch();
    for (let i = 1; i <= 3; i++) await miss(first, meta, NOW + i * 1000);
    const reopened = await loadSwitch();
    for (let i = 4; i <= 5; i++) await miss(reopened, meta, NOW + i * 1000);
    expect(await reopened({ employeeId: '007', pin: PIN_ANA, nowMs: NOW + 6000, meta, storage: fakeStorage() })).toMatchObject({ ok: false, reason: 'paused' });
  }, 60_000);

  it('a right PIN clears the count: 4 misses, a success, 4 more misses is still not a pause', async () => {
    const attempt = await loadSwitch();
    const meta = memoryMeta();
    for (let i = 1; i <= 4; i++) await miss(attempt, meta, NOW + i * 1000);
    expect((await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW + 5000, meta, storage: fakeStorage() })).ok).toBe(true);
    for (let i = 6; i <= 9; i++) await miss(attempt, meta, NOW + i * 1000);
    expect((await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW + 10_000, meta, storage: fakeStorage() })).ok).toBe(true);
  }, 90_000);

  it('a paused attempt writes no actor even though the PIN is right', async () => {
    const attempt = await loadSwitch();
    const meta = memoryMeta();
    for (let i = 1; i <= 5; i++) await miss(attempt, meta, NOW + i * 1000);
    const storage = fakeStorage();
    await attempt({ employeeId: '007', pin: PIN_ANA, nowMs: NOW + 6000, meta, storage });
    expect(storage.m.size).toBe(0);
  }, 60_000);
});
