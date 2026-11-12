/**
 * T-563 (audit P-004) - an event carries the pairing it was made under; the drain sends one batch per origin, oldest first; a row with no
 * pairing is held and never sent. docs/tasks/563-pos-pairing-boundary.md R1, R2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '../../../tests/helpers/fake-idb';
import { OUTBOX_STORE, openDeviceDb } from './db';
import { bindPairing, getMeta } from './meta';
import { countPending, drain, enqueue, listPending } from './outbox';
import { POS_PAIRING_MISMATCH, type NewPosEvent, type PosEvent, type SendOutcome } from './types';

vi.setConfig({ testTimeout: 60_000 });

let fake: FakeIdbFactory;
const event = (over: Partial<NewPosEvent> = {}): NewPosEvent => ({
  kind: 'lines.added',
  personId: 'person-1',
  occurredAtDevice: '2026-11-07T10:00:00.000Z',
  payload: { lineId: 'line-1' },
  ...over,
});
const ok = (batch: PosEvent[]): SendOutcome => ({ kind: 'ok', stateVersion: 1, results: batch.map((e) => ({ seq: e.seq, status: 'applied' as const })) });

beforeEach(async () => {
  fake = createFakeIdb({ commitDelayMs: 2 });
  vi.stubGlobal('indexedDB', fake);
  const db = await openDeviceDb();
  db.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function putLegacyRow(seq: number): Promise<void> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).put({ seq, kind: 'lines.added', personId: 'person-1', occurredAtDevice: '2026-11-07T10:00:00.000Z', payload: {} });
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

describe('T-563 R1 - enqueue stamps the bound pairing', () => {
  it('refuses with no pairing bound, burns no seq and stores nothing', async () => {
    await expect(enqueue(event())).rejects.toThrow(/pair/i);
    expect(await countPending()).toBe(0);
    await bindPairing('P1');
    expect((await enqueue(event())).seq).toBe(1);
  });

  it('stamps the pairing bound at that moment, on the stored row', async () => {
    await bindPairing('P1');
    const first = await enqueue(event());
    expect(first.pairingId).toBe('P1');
    await bindPairing('P2');
    const second = await enqueue(event());
    expect(second.pairingId).toBe('P2');
    expect((await listPending(10)).map((e) => [e.seq, e.pairingId])).toEqual([[1, 'P1'], [2, 'P2']]);
    expect(await getMeta('app.pairingId')).toBe('P2');
  });

  it('a payload that names a pairing is still refused (the pairing is the device store\'s to attach)', async () => {
    await bindPairing('P1');
    await expect(enqueue(event({ payload: { pairingId: 'P9' } }))).rejects.toThrow();
  });

  it('a legacy row with no pairing stays in the outbox and counts as pending', async () => {
    await putLegacyRow(1);
    expect(await countPending()).toBe(1);
    expect((await listPending(10))[0]!.pairingId).toBeUndefined();
  });
});

describe('T-563 R2 - the drain sends per origin', () => {
  it('a row with no pairing is never handed to send', async () => {
    await putLegacyRow(5);
    const send = vi.fn(async (b: PosEvent[]) => ok(b));
    const report = await drain(send);
    expect(send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ stopped: 'empty', sent: 0, removed: 0 });
    expect(await countPending()).toBe(1);
  });

  it('one batch per origin, oldest origin first, every event in a batch sharing its pairingId', async () => {
    await bindPairing('P1');
    await enqueue(event());
    await enqueue(event());
    await bindPairing('P2');
    await enqueue(event());
    await bindPairing('P1');
    await enqueue(event());
    const seen: { pairingIds: string[]; seqs: number[] }[] = [];
    const send = vi.fn(async (b: PosEvent[]) => {
      seen.push({ pairingIds: [...new Set(b.map((e) => e.pairingId!))], seqs: b.map((e) => e.seq) });
      return ok(b);
    });
    const report = await drain(send);
    expect(seen).toEqual([
      { pairingIds: ['P1'], seqs: [1, 2, 4] },
      { pairingIds: ['P2'], seqs: [3] },
    ]);
    expect(report).toMatchObject({ stopped: 'empty', sent: 4, removed: 4, heldOrigins: [] });
    expect(await countPending()).toBe(0);
  });

  it('a 409 POS_PAIRING_MISMATCH holds that origin (rows stay) and the drain goes on to the next origin', async () => {
    await bindPairing('P1');
    await enqueue(event());
    await enqueue(event());
    await bindPairing('P2');
    await enqueue(event());
    const send = vi.fn(async (b: PosEvent[]): Promise<SendOutcome> => (b[0]!.pairingId === 'P1' ? { kind: 'http', status: 409, code: POS_PAIRING_MISMATCH } : ok(b)));
    const report = await drain(send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ stopped: 'empty', sent: 1, removed: 1, heldOrigins: ['P1'] });
    expect((await listPending(10)).map((e) => e.seq)).toEqual([1, 2]);
    // the next drain asks again (a pair-back must be able to release them) and, when the server now takes them, they go
    const later = await drain(async (b) => ok(b));
    expect(later).toMatchObject({ stopped: 'empty', removed: 2, heldOrigins: [] });
    expect(await countPending()).toBe(0);
  });

  it('any other 409 (or 5xx) stops the drain as before and holds nothing', async () => {
    await bindPairing('P1');
    await enqueue(event());
    const report = await drain(async () => ({ kind: 'http', status: 409 }));
    expect(report).toMatchObject({ stopped: 'http', status: 409, heldOrigins: [] });
    expect(await countPending()).toBe(1);
  });
});
