/**
 * T-530a — `outbox.ts`: numbering, durability, validation, applying results and the drain loop.
 *
 * The fake commits only after `commitDelayMs`, and rows are visible to other transactions only at
 * `complete` — so a function that resolved on `request.onsuccess` instead of the transaction's
 * `complete` would be caught by "a failed transaction writes nothing".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '../../../tests/helpers/fake-idb';
import { openDeviceDb } from './db';
import { bindPairing } from './meta';
import {
  applyResults,
  countPending,
  drain,
  enqueue,
  listPending,
  reserveTerminalSeq,
  resumeAbove,
} from './outbox';
import type { NewPosEvent, PosEvent, PosEventResult, SendOutcome } from './types';

// The bulk cases here (50 racing enqueues, 250 events drained in batches) are many small IndexedDB
// transactions; each one is a few timer ticks in the fake, so the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000 });

let fake: FakeIdbFactory;

const event = (over: Partial<NewPosEvent> = {}): NewPosEvent => ({
  kind: 'lines.added',
  personId: 'person-1',
  occurredAtDevice: '2026-11-07T10:00:00.000Z',
  payload: { lineId: 'line-1' },
  ...over,
});

const ok = (batch: PosEvent[], stateVersion = 1): SendOutcome => ({
  kind: 'ok',
  stateVersion,
  results: batch.map((e) => ({ seq: e.seq, status: 'applied' as const })),
});

beforeEach(async () => {
  fake = createFakeIdb({ commitDelayMs: 2 });
  vi.stubGlobal('indexedDB', fake);
  // Open once so the version upgrade happens before a test races many transactions (the real app
  // opens on boot too; the fake is not built for 50 concurrent first-time upgrades).
  const db = await openDeviceDb();
  db.close();
  await bindPairing('P1'); // T-563: a tablet cannot queue a sale before its first snapshot named its pairing
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T-530a — numbering', () => {
  it('seq starts at 1 and counts up', async () => {
    expect((await enqueue(event())).seq).toBe(1);
    expect((await enqueue(event())).seq).toBe(2);
    expect((await enqueue(event())).seq).toBe(3);
  });

  it('racing enqueues never share a seq', async () => {
    const queued = await Promise.all(Array.from({ length: 50 }, () => enqueue(event())));
    const seqs = queued.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(await countPending()).toBe(50);
  });

  it('survives a reopen', async () => {
    await enqueue(event({ personId: 'person-1' }));
    // Every call opens and closes its own connection, so this IS a reopen of the same database.
    const pending = await listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.personId).toBe('person-1');
    expect((await enqueue(event())).seq).toBe(2);
  });

  it('a failed transaction writes nothing', async () => {
    fake.failNextTransaction();
    await expect(enqueue(event())).rejects.toThrow();
    expect(await countPending()).toBe(0);
    // The counter did not move: the next event is still seq 1.
    expect((await enqueue(event())).seq).toBe(1);
  });

  it('a synchronous put failure (uncloneable payload) leaves the counter and outbox untouched', async () => {
    await expect(enqueue(event({ payload: { fn: () => 1 } }))).rejects.toThrow();
    expect(await countPending()).toBe(0);
    expect(fake.rows('outbox')).toEqual([]);
    expect((await enqueue(event())).seq).toBe(1);
  });

  it('terminal numbers are never reused', async () => {
    expect(await reserveTerminalSeq()).toBe(1);
    expect(await reserveTerminalSeq()).toBe(2);
    expect(await reserveTerminalSeq()).toBe(3);
  });

  it('resumeAbove only raises', async () => {
    await resumeAbove({ lastSeq: 40, lastTerminalSeq: 40 });
    expect((await enqueue(event())).seq).toBe(41);
    expect(await reserveTerminalSeq()).toBe(41);
    await resumeAbove({ lastSeq: 10, lastTerminalSeq: 10 });
    expect((await enqueue(event())).seq).toBe(42);
    expect(await reserveTerminalSeq()).toBe(42);
  });
});

describe('T-530a — validation', () => {
  it('refuses a bad event', async () => {
    const bad: NewPosEvent[] = [
      event({ kind: 'not.a.kind' as NewPosEvent['kind'] }),
      event({ personId: '' }),
      event({ personId: '   ' }),
      event({ occurredAtDevice: 'not a time' }),
      event({ payload: { storeId: 'store-1' } }),
      event({ payload: { pairingId: 'pair-1' } }),
      event({ payload: [] as unknown as Record<string, unknown> }),
      event({ payload: null as unknown as Record<string, unknown> }),
    ];
    for (const candidate of bad) {
      await expect(enqueue(candidate)).rejects.toThrow();
    }
    expect(await countPending()).toBe(0);
  });
});

describe('T-530a — applying the server result', () => {
  it('applyResults removes and keeps by status', async () => {
    for (let i = 0; i < 6; i++) await enqueue(event());

    const results: PosEventResult[] = [
      { seq: 1, status: 'applied' },
      { seq: 2, status: 'duplicate' },
      { seq: 3, status: 'conflict', error: 'moved table' },
      { seq: 4, status: 'quarantined' },
      { seq: 5, status: 'retry' },
      // 6 is deliberately not listed: the server said nothing about it.
    ];
    const out = await applyResults(results);

    expect(out.removed).toEqual([1, 2, 3, 4]);
    expect(out.conflicts.map((c) => c.seq)).toEqual([3]);
    expect(out.retryFrom).toBe(5);
    expect((await listPending(10)).map((e) => e.seq)).toEqual([5, 6]);
  });
});

describe('T-530a — the drain loop', () => {
  it('drain sends in order and empties', async () => {
    for (let i = 0; i < 250; i++) await enqueue(event());

    const batches: number[][] = [];
    const send = async (batch: PosEvent[]): Promise<SendOutcome> => {
      batches.push(batch.map((e) => e.seq));
      return ok(batch);
    };

    const report = await drain(send);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches[0]?.[0]).toBe(1);
    expect(batches[1]?.[0]).toBe(101);
    expect(batches[2]?.[0]).toBe(201);
    expect(report.stopped).toBe('empty');
    expect(report.sent).toBe(250);
    expect(report.removed).toBe(250);
    expect(await countPending()).toBe(0);
  });

  it('drain stops on retry', async () => {
    for (let i = 0; i < 10; i++) await enqueue(event());

    const send = async (batch: PosEvent[]): Promise<SendOutcome> => ({
      kind: 'ok',
      stateVersion: 7,
      results: batch.map((e) =>
        e.seq <= 6 ? ({ seq: e.seq, status: 'applied' as const } as PosEventResult) : ({ seq: e.seq, status: 'retry' as const } as PosEventResult),
      ),
    });

    const report = await drain(send);
    expect(report.stopped).toBe('retry');
    expect(report.removed).toBe(6);
    expect((await listPending(10)).map((e) => e.seq)).toEqual([7, 8, 9, 10]);
  });

  it('drain stops on http, network and throw', async () => {
    for (let i = 0; i < 3; i++) await enqueue(event());

    const http = await drain(async () => ({ kind: 'http', status: 503 }));
    expect(http.stopped).toBe('http');
    expect(http.status).toBe(503);
    expect(await countPending()).toBe(3);

    const network = await drain(async () => ({ kind: 'network' }));
    expect(network.stopped).toBe('network');
    expect(await countPending()).toBe(3);

    const thrown = await drain(async () => {
      throw new Error('offline');
    });
    expect(thrown.stopped).toBe('network');
    expect(await countPending()).toBe(3);
  });

  it('short results stop the drain', async () => {
    for (let i = 0; i < 100; i++) await enqueue(event());

    let calls = 0;
    const send = async (batch: PosEvent[]): Promise<SendOutcome> => {
      calls++;
      // The server only judged the first 60 of the 100 it was sent.
      return { kind: 'ok', stateVersion: 3, results: batch.slice(0, 60).map((e) => ({ seq: e.seq, status: 'applied' as const })) };
    };

    const report = await drain(send);
    expect(calls).toBe(1);
    expect(report.stopped).toBe('retry');
    expect(report.removed).toBe(60);
    expect(await countPending()).toBe(40);
  });

  it('single flight', async () => {
    for (let i = 0; i < 3; i++) await enqueue(event());

    let calls = 0;
    const send = async (batch: PosEvent[]): Promise<SendOutcome> => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return ok(batch);
    };

    const [first, second] = await Promise.all([drain(send), drain(send)]);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(await countPending()).toBe(0);
  });

  it('a second drain after the first finishes runs again', async () => {
    await enqueue(event());
    let calls = 0;
    const send = async (batch: PosEvent[]): Promise<SendOutcome> => {
      calls++;
      return ok(batch);
    };
    await drain(send);
    await drain(send); // nothing left, but it must not return the old promise
    expect(calls).toBe(1);
  });
});
