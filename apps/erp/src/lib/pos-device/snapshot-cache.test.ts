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

  it('touch with a nextChangeAt persists it across a reopen; touch without keeps it', async () => {
    await saveSnapshot({ body: {}, etag: 'e1', fetchedAtMs: 1_000 });
    await touchSnapshot(2_000, '2026-11-12T10:00:00.000Z');
    expect(await readSnapshot()).toMatchObject({ fetchedAtMs: 2_000, nextChangeAt: '2026-11-12T10:00:00.000Z' }); // each read reopens the DB

    await touchSnapshot(3_000);
    expect(await readSnapshot()).toMatchObject({ fetchedAtMs: 3_000, nextChangeAt: '2026-11-12T10:00:00.000Z' });
  });

  it('a full save round-trips nextChangeAt', async () => {
    const snapshot = { body: { menu: [] }, etag: 'e2', fetchedAtMs: 5_000, nextChangeAt: '2026-11-13T00:00:00.000Z' };
    await saveSnapshot(snapshot);
    expect(await readSnapshot()).toEqual(snapshot);
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
