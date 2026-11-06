/**
 * T-508 S5 (R7) - one refresh of the device menu cache. NEVER throws and NEVER blanks a good cache:
 * offline, a failed fetch, a non-2xx answer or a malformed body all keep what is stored; a 304 keeps it too.
 * Only a 200 with a different contentHash replaces it. T-510 S4b: a 304 that carries a different `x-next-change-at` keeps the menu but stores the
 * new next-change time (and says so via `rescheduled`), so the store re-arms its timer instead of waiting on a time that has passed.
 */
import type { ErpMenu as StoreMenuV2 } from './types';
import type { CachedMenu } from './cache';

export interface MenuResponse {
  status: number;
  body?: { menu?: StoreMenuV2; contentHash?: string; nextChangeAt?: string | null } | null;
  /** The `x-next-change-at` response header (sent on 200 and 304); absent or empty when the server has none. */
  nextChangeAt?: string | null;
}

export async function refreshMenuCache(d: {
  storeId: string;
  online: boolean;
  read: () => Promise<CachedMenu | null>;
  write: (c: CachedMenu) => Promise<void>;
  fetchMenu: (ifNoneMatch: string | null) => Promise<MenuResponse>;
  now: () => number;
}): Promise<{ cache: CachedMenu | null; changed: boolean; rescheduled?: boolean }> {
  let cache: CachedMenu | null = null;
  try { cache = await d.read(); } catch { cache = null; }
  if (!d.online) return { cache, changed: false };
  try {
    const res = await d.fetchMenu(cache ? `"${cache.contentHash}"` : null);
    if (res.status === 304 && cache) return await rescheduleFrom(cache, res.nextChangeAt, d);
    const b = res.body;
    if (res.status !== 200 || !b || !b.menu || typeof b.contentHash !== 'string' || b.menu.schemaVersion !== 2) return { cache, changed: false };
    if (cache && cache.contentHash === b.contentHash) return await rescheduleFrom(cache, res.nextChangeAt ?? b.nextChangeAt, d);
    const next: CachedMenu = { storeId: d.storeId, contentHash: b.contentHash, fetchedAt: d.now(), nextChangeAt: b.nextChangeAt ?? null, menu: b.menu };
    await d.write(next);
    return { cache: next, changed: true };
  } catch {
    return { cache, changed: false };
  }
}

/**
 * Same menu, maybe a new next-change time: store it when it is a readable time that differs from the cached one. The cache is RE-READ first and
 * written only if it still holds the menu this answer was for: a refresh that overlapped this one may have stored a newer menu, which a write
 * of the older one must never replace. Never throws (the caller's catch keeps the cache).
 */
async function rescheduleFrom(cache: CachedMenu, header: string | null | undefined, d: { read: () => Promise<CachedMenu | null>; write: (c: CachedMenu) => Promise<void> }): Promise<{ cache: CachedMenu; changed: false; rescheduled?: true }> {
  if (!header || !Number.isFinite(Date.parse(header)) || header === cache.nextChangeAt) return { cache, changed: false };
  const fresh = await d.read();
  if (!fresh || fresh.contentHash !== cache.contentHash) return { cache: fresh ?? cache, changed: false };
  const next: CachedMenu = { ...fresh, nextChangeAt: header };
  await d.write(next);
  return { cache: next, changed: false, rescheduled: true };
}
