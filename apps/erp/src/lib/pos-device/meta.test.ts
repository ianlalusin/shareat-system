/**
 * T-530a — `meta.ts`: the `app.*` scratchpad, and the counters it must never touch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '../../../tests/helpers/fake-idb';
import { getMeta, setMeta } from './meta';
import { countPending, enqueue } from './outbox';

let fake: FakeIdbFactory;

beforeEach(() => {
  fake = createFakeIdb({ commitDelayMs: 2 });
  vi.stubGlobal('indexedDB', fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T-530a — app.* values', () => {
  it('app keys round-trip; counters are off limits', async () => {
    expect(await getMeta('app.signInMisses')).toBeNull();
    await setMeta('app.signInMisses', 3);
    expect(await getMeta<number>('app.signInMisses')).toBe(3);

    // Survives a reopen (every call opens its own connection).
    expect(await getMeta<number>('app.signInMisses')).toBe(3);

    // Structured-clone data, not just scalars.
    await setMeta('app.lastSeen', { at: 1_700_000_000_000, by: 'person-1' });
    expect(await getMeta('app.lastSeen')).toEqual({ at: 1_700_000_000_000, by: 'person-1' });

    // The counters are outbox.ts's alone: refused, and nothing changes.
    await expect(getMeta('nextSeq')).rejects.toThrow();
    await expect(setMeta('nextSeq', 9)).rejects.toThrow();
    await expect(getMeta('nextTerminalSeq')).rejects.toThrow();
    await expect(setMeta('nextTerminalSeq', 9)).rejects.toThrow();

    expect(await countPending()).toBe(0);
    expect((await enqueue({
      kind: 'stand.opened',
      personId: 'person-1',
      occurredAtDevice: '2026-11-07T10:00:00.000Z',
      payload: { standId: 'stand-1' },
    })).seq).toBe(1);
  });
});
