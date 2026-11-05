/**
 * T-508 S5 (R7) - one refresh of the device menu cache. NEVER throws and NEVER blanks a good cache:
 * offline, a failed fetch, a non-2xx answer or a malformed body all keep what is stored; a 304 keeps it too.
 * Only a 200 with a different contentHash replaces it.
 */
import type { ErpMenu as StoreMenuV2 } from './types';
import type { CachedMenu } from './cache';

export interface MenuResponse { status: number; body?: { menu?: StoreMenuV2; contentHash?: string; nextChangeAt?: string | null } | null }

export async function refreshMenuCache(d: {
  storeId: string;
  online: boolean;
  read: () => Promise<CachedMenu | null>;
  write: (c: CachedMenu) => Promise<void>;
  fetchMenu: (ifNoneMatch: string | null) => Promise<MenuResponse>;
  now: () => number;
}): Promise<{ cache: CachedMenu | null; changed: boolean }> {
  let cache: CachedMenu | null = null;
  try { cache = await d.read(); } catch { cache = null; }
  if (!d.online) return { cache, changed: false };
  try {
    const res = await d.fetchMenu(cache ? `"${cache.contentHash}"` : null);
    if (res.status === 304 && cache) return { cache, changed: false };
    const b = res.body;
    if (res.status !== 200 || !b || !b.menu || typeof b.contentHash !== 'string' || b.menu.schemaVersion !== 2) return { cache, changed: false };
    if (cache && cache.contentHash === b.contentHash) return { cache, changed: false };
    const next: CachedMenu = { storeId: d.storeId, contentHash: b.contentHash, fetchedAt: d.now(), nextChangeAt: b.nextChangeAt ?? null, menu: b.menu };
    await d.write(next);
    return { cache: next, changed: true };
  } catch {
    return { cache, changed: false };
  }
}
