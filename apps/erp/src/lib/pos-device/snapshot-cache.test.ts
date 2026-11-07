/**
 * T-530a — `snapshot-cache.ts`: the last good menu, and the rule that nothing here erases it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '../../../tests/helpers/fake-idb';
import { isSnapshotUsable, readSnapshot, saveSnapshot, touchSnapshot } from './snapshot-cache';

let fake: FakeIdbFactory;

beforeEach(() => {
  fake = createFakeIdb({ commitDelayMs: 2 });
  vi.stubGlobal('indexedDB', fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T-530a — the snapshot cache', () => {
  it('save, read, touch', async () => {
    expect(await readSnapshot()).toBeNull();

    await saveSnapshot({ body: { menu: ['adobo'] }, etag: 'e1', fetchedAtMs: 1_000 });
    expect(await readSnapshot()).toEqual({ body: { menu: ['adobo'] }, etag: 'e1', fetchedAtMs: 1_000 });

    await touchSnapshot(2_500);
    expect(await readSnapshot()).toEqual({ body: { menu: ['adobo'] }, etag: 'e1', fetchedAtMs: 2_500 });
  });

  it('touch with nothing stored does nothing', async () => {
    await touchSnapshot(1_234);
    expect(await readSnapshot()).toBeNull();
  });

  it('never blanks', async () => {
    const module = await import('./snapshot-cache');
    const destructive = Object.keys(module).filter((name) => /clear|delete|blank|reset|remove/i.test(name));
    expect(destructive).toEqual([]);
  });

  it('usable window', () => {
    const snapshot = { body: {}, etag: 'e', fetchedAtMs: 1_000 };
    expect(isSnapshotUsable(snapshot, 1_000 + 60_000, 60_000)).toBe(true); // exactly at the limit
    expect(isSnapshotUsable(snapshot, 1_000 + 60_001, 60_000)).toBe(false); // 1 ms later
    expect(isSnapshotUsable(null, 1_000, 60_000)).toBe(false);
  });
});
