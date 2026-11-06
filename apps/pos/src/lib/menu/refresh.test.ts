/** T-508 S5 (R7) - the cache never blanks: offline, failed fetch, 304 keep it; a new hash replaces it. Plus the source switch and triggers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb } from '@/test-helpers/fakeIdb';
import { loadMenuCache, loadMenuSource, saveMenuCache, saveMenuSource, type CachedMenu } from './cache';
import { refreshMenuCache } from './refresh';
import { createMenuStore, MENU_REFRESH_MS } from './menuStore';
import { loadPrintLocations } from './printLocations';
import { sampleMenu } from '@/test-helpers/menuFixture';

vi.mock('@/lib/firebase/client', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocs: vi.fn() }));
vi.mock('./useErpMenu', () => ({ getMenuStore: () => ({ getState: () => ({ source: 'firestore', cached: null }) }) }));

const cached = (hash: string): CachedMenu => ({ storeId: 's1', contentHash: hash, fetchedAt: 1, nextChangeAt: null, menu: sampleMenu() });
function deps(initial: CachedMenu | null, fetchMenu: (inm: string | null) => Promise<any>, online = true) {
  let row = initial;
  const write = vi.fn(async (c: CachedMenu) => { row = c; });
  return { d: { storeId: 's1', online, read: async () => row, write, fetchMenu, now: () => 99 }, row: () => row, write };
}

describe('refreshMenuCache', () => {
  it('offline: keeps the cache and does not even fetch', async () => {
    const f = vi.fn();
    const t = deps(cached('h1'), f, false);
    const r = await refreshMenuCache(t.d);
    expect(f).not.toHaveBeenCalled();
    expect(r.cache!.contentHash).toBe('h1');
  });
  it('a failed fetch (throws) keeps the cache', async () => {
    const t = deps(cached('h1'), async () => { throw new Error('net'); });
    expect((await refreshMenuCache(t.d)).cache!.contentHash).toBe('h1');
    expect(t.write).not.toHaveBeenCalled();
  });
  it('a 500 or a malformed 200 keeps the cache', async () => {
    for (const res of [{ status: 500 }, { status: 200, body: { menu: null } }, { status: 200, body: null }]) {
      const t = deps(cached('h1'), async () => res);
      expect((await refreshMenuCache(t.d)).cache!.contentHash).toBe('h1');
      expect(t.write).not.toHaveBeenCalled();
    }
  });
  it('304 keeps the cache; the request carries If-None-Match with the stored hash', async () => {
    const f = vi.fn(async () => ({ status: 304 }));
    const t = deps(cached('h1'), f);
    const r = await refreshMenuCache(t.d);
    expect(f).toHaveBeenCalledWith('"h1"');
    expect(r).toMatchObject({ changed: false, cache: { contentHash: 'h1' } });
    expect(t.write).not.toHaveBeenCalled();
  });
  describe('304 and the x-next-change-at header (T-510 S4b)', () => {
    const withNext = (hash: string, nextChangeAt: string | null): CachedMenu => ({ ...cached(hash), nextChangeAt });
    it('a 304 with a different header keeps the menu and the hash, and stores the new nextChangeAt', async () => {
      const start = withNext('h1', '2030-01-01T00:02:00.000Z');
      const t = deps(start, async () => ({ status: 304, nextChangeAt: '2030-01-01T10:00:00.000Z' }));
      const r = await refreshMenuCache(t.d);
      expect(r.rescheduled).toBe(true);
      expect(r.changed).toBe(false);
      expect(r.cache).toMatchObject({ contentHash: 'h1', nextChangeAt: '2030-01-01T10:00:00.000Z', fetchedAt: 1 });
      expect(r.cache!.menu).toBe(start.menu);
      expect(r.cache).not.toBe(start);
      expect(t.write).toHaveBeenCalledTimes(1);
      expect(t.row()!.nextChangeAt).toBe('2030-01-01T10:00:00.000Z');
    });
    it('a 304 whose header equals the stored value, is absent, empty or unreadable changes nothing', async () => {
      for (const header of ['2030-01-01T00:02:00.000Z', undefined, null, '', 'not-a-date']) {
        const t = deps(withNext('h1', '2030-01-01T00:02:00.000Z'), async () => ({ status: 304, nextChangeAt: header }));
        const r = await refreshMenuCache(t.d);
        expect(r.rescheduled).toBeFalsy();
        expect(r.cache!.nextChangeAt).toBe('2030-01-01T00:02:00.000Z');
        expect(t.write).not.toHaveBeenCalled();
      }
    });
    it('a 304 header fills in a nextChangeAt the cache did not have', async () => {
      const t = deps(withNext('h1', null), async () => ({ status: 304, nextChangeAt: '2030-01-01T10:00:00.000Z' }));
      expect((await refreshMenuCache(t.d)).cache!.nextChangeAt).toBe('2030-01-01T10:00:00.000Z');
    });
    it('an overlapping refresh: the 304 never writes the old menu back over a newer cache', async () => {
      const old = withNext('h1', '2030-01-01T00:02:00.000Z');
      const newer = withNext('h2', '2030-01-01T00:30:00.000Z');
      let reads = 0;
      const write = vi.fn(async () => {});
      const r = await refreshMenuCache({
        storeId: 's1', online: true, read: async () => (++reads === 1 ? old : newer), write,
        fetchMenu: async () => ({ status: 304, nextChangeAt: '2030-01-01T10:00:00.000Z' }), now: () => 99,
      });
      expect(write).not.toHaveBeenCalled();
      expect(r.cache).toBe(newer);
      expect(r.rescheduled).toBeFalsy();
    });
    it('a 304 whose cache is unchanged on the re-read still writes (the normal case)', async () => {
      const old = withNext('h1', '2030-01-01T00:02:00.000Z');
      const write = vi.fn(async () => {});
      const r = await refreshMenuCache({ storeId: 's1', online: true, read: async () => old, write, fetchMenu: async () => ({ status: 304, nextChangeAt: '2030-01-01T10:00:00.000Z' }), now: () => 99 });
      expect(write).toHaveBeenCalledTimes(1);
      expect(r.rescheduled).toBe(true);
    });
    it('a 304 with no cache stores nothing (nothing invented)', async () => {
      const t = deps(null, async () => ({ status: 304, nextChangeAt: '2030-01-01T10:00:00.000Z' }));
      const r = await refreshMenuCache(t.d);
      expect(r.cache).toBeNull();
      expect(t.write).not.toHaveBeenCalled();
    });
  });
  it('a new hash replaces the cache (hash, menu, fetchedAt, nextChangeAt)', async () => {
    const t = deps(cached('h1'), async () => ({ status: 200, body: { menu: sampleMenu(), contentHash: 'h2', nextChangeAt: '2030-01-01T00:00:00.000Z' } }));
    const r = await refreshMenuCache(t.d);
    expect(r.changed).toBe(true);
    expect(t.row()).toMatchObject({ contentHash: 'h2', fetchedAt: 99, nextChangeAt: '2030-01-01T00:00:00.000Z' });
  });
  it('first ever fetch (no cache) stores the menu and sends no If-None-Match', async () => {
    const f = vi.fn(async () => ({ status: 200, body: { menu: sampleMenu(), contentHash: 'h1' } }));
    const t = deps(null, f);
    expect((await refreshMenuCache(t.d)).cache!.contentHash).toBe('h1');
    expect(f).toHaveBeenCalledWith(null);
  });
  it('first ever fetch failing leaves no cache (nothing invented)', async () => {
    const t = deps(null, async () => ({ status: 500 }));
    expect((await refreshMenuCache(t.d)).cache).toBeNull();
  });
});

describe('IndexedDB cache', () => {
  beforeEach(() => { vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 0 })); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('round-trips per store and remembers the source', async () => {
    expect(await loadMenuCache('s1')).toBeNull();
    await saveMenuCache(cached('h1'));
    expect((await loadMenuCache('s1'))!.contentHash).toBe('h1');
    expect(await loadMenuCache('s2')).toBeNull();
    await saveMenuSource('erp');
    expect(await loadMenuSource()).toBe('erp');
  });
});

type Conn = { online: boolean; menuSource?: 'erp' | 'firestore' | null };
function harness(source: 'erp' | 'firestore' | null, cache: CachedMenu | null = null) {
  let conn: Conn = { online: true, menuSource: source };
  const ls = new Set<() => void>();
  const fetchMenu = vi.fn(async (_s: string, _inm: string | null) => ({ status: 304 }) as any);
  const store = createMenuStore({
    connectivity: { getState: () => conn, subscribe: (l) => { ls.add(l); return () => { ls.delete(l); }; } },
    fetchMenu, load: async () => cache, save: async () => {}, loadSource: async () => null, saveSource: async () => {},
  });
  return { store, fetchMenu, setConn: (c: Conn) => { conn = c; ls.forEach((l) => l()); } };
}

describe('menu store: the switch and the triggers', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('source firestore (default): never fetches, never exposes a menu', async () => {
    const h = harness('firestore', cached('h1'));
    const stop = h.store.start('s1');
    await vi.advanceTimersByTimeAsync(MENU_REFRESH_MS * 2);
    expect(h.fetchMenu).not.toHaveBeenCalled();
    expect(h.store.getState()).toEqual({ source: 'firestore', cached: null });
    stop();
  });
  it('source erp: loads the cache at start, fetches with If-None-Match, then every 5 minutes', async () => {
    const h = harness('erp', cached('h1'));
    const stop = h.store.start('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState().cached!.contentHash).toBe('h1');
    expect(h.fetchMenu).toHaveBeenLastCalledWith('s1', '"h1"');
    h.fetchMenu.mockClear();
    await vi.advanceTimersByTimeAsync(MENU_REFRESH_MS);
    expect(h.fetchMenu).toHaveBeenCalledTimes(1);
    stop();
  });
  it('refreshes when connectivity is regained; stays quiet while offline and keeps the menu', async () => {
    const h = harness('erp', cached('h1'));
    h.setConn({ online: false, menuSource: 'erp' });
    const stop = h.store.start('s1');
    await vi.advanceTimersByTimeAsync(0);
    h.fetchMenu.mockClear();
    await vi.advanceTimersByTimeAsync(MENU_REFRESH_MS);
    expect(h.fetchMenu).not.toHaveBeenCalled();
    expect(h.store.getState().cached!.contentHash).toBe('h1');
    h.setConn({ online: true, menuSource: 'erp' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchMenu).toHaveBeenCalledTimes(1);
    stop();
  });
  it('a 304 that carries a later x-next-change-at re-arms the timer: no refetch at the old time, one at the new time (T-510 S4b)', async () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const h = harness('erp', { ...cached('h1'), nextChangeAt: '2030-01-01T00:02:00.000Z' });
    h.fetchMenu.mockImplementation(async () => ({ status: 304, nextChangeAt: '2030-01-01T00:04:00.000Z' }) as any); // before the 5-minute poll, so only the timer can fire
    const seen: Array<string | null> = [];
    h.store.subscribe(() => seen.push(h.store.getState().cached?.nextChangeAt ?? null));
    const stop = h.store.start('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState().cached!.nextChangeAt).toBe('2030-01-01T00:04:00.000Z');
    expect(seen).toContain('2030-01-01T00:04:00.000Z'); // a new cache object notified the listeners
    h.fetchMenu.mockClear();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000); // the OLD time passes: nothing
    expect(h.fetchMenu).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000); // past the new time (00:04:00)
    expect(h.fetchMenu).toHaveBeenCalledTimes(1);
    stop();
  });
  it('refreshes at nextChangeAt', async () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const h = harness('erp', { ...cached('h1'), nextChangeAt: '2030-01-01T00:02:00.000Z' });
    const stop = h.store.start('s1');
    await vi.advanceTimersByTimeAsync(0);
    h.fetchMenu.mockClear();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(h.fetchMenu).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('menu store: re-linking to another store', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const forStore = (storeId: string, hash: string): CachedMenu => ({ ...cached(hash), storeId });
  function relinkStore(caches: Record<string, CachedMenu>) {
    return createMenuStore({
      connectivity: { getState: () => ({ online: true, menuSource: 'erp' as const }), subscribe: () => () => {} },
      fetchMenu: async () => { throw new Error('net'); },
      load: async (id: string) => caches[id] ?? null, save: async () => {}, loadSource: async () => null, saveSource: async () => {},
    });
  }
  it("never serves store A's menu under store B when B has no cache and the fetch fails", async () => {
    const store = relinkStore({ A: forStore('A', 'hA') });
    const stopA = store.start('A');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().cached!.storeId).toBe('A');
    stopA();
    const stopB = store.start('B');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().cached).toBeNull();
    stopB();
  });
  it("serves B's own cache after the switch", async () => {
    const store = relinkStore({ A: forStore('A', 'hA'), B: forStore('B', 'hB') });
    const stopA = store.start('A');
    await vi.advanceTimersByTimeAsync(0);
    stopA();
    const stopB = store.start('B');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().cached).toMatchObject({ storeId: 'B', contentHash: 'hB' });
    stopB();
  });
});

describe('print locations follow the switch', () => {
  const fs = vi.fn(async (_id: string) => [{ id: 'fs-1', printOnOutage: true }]);
  it('firestore: calls the Firestore source, not the adapter', async () => {
    const r = await loadPrintLocations('s1', { state: () => ({ source: 'firestore', cached: { menu: sampleMenu() } }), firestore: fs });
    expect(fs).toHaveBeenCalledWith('s1');
    expect(r).toEqual([{ id: 'fs-1', printOnOutage: true }]);
  });
  it('erp: reads the projected stations and never touches Firestore', async () => {
    fs.mockClear();
    const r = await loadPrintLocations('s1', { state: () => ({ source: 'erp', cached: { menu: sampleMenu() } }), firestore: fs });
    expect(fs).not.toHaveBeenCalled();
    expect(r).toEqual([{ id: 'st-grill', printOnOutage: true }, { id: 'st-bar', printOnOutage: false }]);
  });
});
