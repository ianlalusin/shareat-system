/**
 * T-508 S5 (R7, R9) - the device's menu store: which source is on (`erp` | `firestore`, told by the server, default `firestore`),
 * the last good cached ERP menu, and the refresh triggers: start, connectivity regained, every 5 minutes, and at `nextChangeAt`.
 * Factory so tests inject fakes; `getMenuStore()` is the app singleton. With source `firestore` it never fetches.
 */
import type { CachedMenu, MenuSource } from './cache';
import { loadMenuCache, loadMenuSource, saveMenuCache, saveMenuSource } from './cache';
import { refreshMenuCache, type MenuResponse } from './refresh';

export const MENU_REFRESH_MS = 5 * 60_000;
export interface MenuState { source: MenuSource; cached: CachedMenu | null }

export interface MenuStoreDeps {
  connectivity: { getState(): { online: boolean; menuSource?: MenuSource | null }; subscribe(l: () => void): () => void };
  fetchMenu: (storeId: string, ifNoneMatch: string | null) => Promise<MenuResponse>;
  load?: typeof loadMenuCache; save?: typeof saveMenuCache; loadSource?: typeof loadMenuSource; saveSource?: typeof saveMenuSource;
  now?: () => number;
}

export function createMenuStore(d: MenuStoreDeps) {
  const load = d.load ?? loadMenuCache, save = d.save ?? saveMenuCache;
  const loadSource = d.loadSource ?? loadMenuSource, saveSource = d.saveSource ?? saveMenuSource;
  const now = d.now ?? Date.now;
  let state: MenuState = { source: 'firestore', cached: null };
  const listeners = new Set<() => void>();
  const set = (next: MenuState) => { if (next.source !== state.source || next.cached !== state.cached) { state = next; for (const l of [...listeners]) l(); } };

  async function refresh(storeId: string): Promise<void> {
    if (state.source !== 'erp') return;
    const r = await refreshMenuCache({
      storeId, online: d.connectivity.getState().online, read: () => load(storeId), write: save,
      fetchMenu: (inm) => d.fetchMenu(storeId, inm), now,
    });
    if (r.cache && (r.changed || !state.cached || state.cached.storeId !== storeId)) set({ ...state, cached: r.cache });
  }

  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

  return {
    getState: () => state,
    subscribe,
    refresh,
    /** Starts the triggers for one POS store; returns stop(). */
    start(storeId: string): () => void {
      let stopped = false, wasOnline = d.connectivity.getState().online, timer: ReturnType<typeof setTimeout> | undefined;
      const go = () => { if (!stopped) void refresh(storeId); };
      const arm = () => {
        if (timer) clearTimeout(timer);
        const at = state.cached?.nextChangeAt ? Date.parse(state.cached.nextChangeAt) - now() : NaN;
        if (Number.isFinite(at) && at > 0) timer = setTimeout(go, at);
      };
      const adoptSource = (s: MenuSource) => { const was = state.source; if (s !== was) { set({ ...state, source: s }); void saveSource(s).catch(() => {}); if (s === 'erp') go(); } };
      void (async () => {
        try { const s = await loadSource(); if (s && !stopped && !d.connectivity.getState().menuSource) adoptSource(s); } catch { /* keep default */ }
        try { const c = await load(storeId); if (c && !stopped && state.source === 'erp') set({ ...state, cached: c }); } catch { /* none */ }
        go();
      })();
      const unsubConn = d.connectivity.subscribe(() => {
        const c = d.connectivity.getState();
        if (c.menuSource) adoptSource(c.menuSource);
        if (c.online && !wasOnline) go();
        wasOnline = c.online;
      });
      const unsubMenu = subscribe(arm);
      const poll = setInterval(go, MENU_REFRESH_MS);
      const initial = d.connectivity.getState().menuSource;
      if (initial) adoptSource(initial);
      return () => { stopped = true; unsubConn(); unsubMenu(); clearInterval(poll); if (timer) clearTimeout(timer); };
    },
  };
}
