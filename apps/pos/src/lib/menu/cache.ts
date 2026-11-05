/**
 * T-508 S5 (R7) - the device's copy of the last good ERP menu. Lives in the tablet's shared IndexedDB (`meta` store, key `menu:<posStoreId>`),
 * never localStorage. Also remembers the last source the server reported, so an offline start still reads the right source.
 */
import type { ErpMenu as StoreMenuV2 } from './types';
import { STORE_META, inTerminalTransaction } from '@/lib/terminal/db';

export type MenuSource = 'erp' | 'firestore';
export interface CachedMenu { storeId: string; contentHash: string; fetchedAt: number; nextChangeAt: string | null; menu: StoreMenuV2 }

const key = (storeId: string) => `menu:${storeId}`;
const SOURCE_KEY = 'menuSource';

function read<T>(k: string): Promise<T | null> {
  return inTerminalTransaction<T | null>(STORE_META, 'readonly', (tx, done, fail) => {
    const req = tx.objectStore(STORE_META).get(k);
    req.onsuccess = () => done((req.result as T | undefined) ?? null);
    req.onerror = () => fail(req.error ?? new Error('Could not read the menu cache.'));
  });
}
function write(k: string, v: unknown): Promise<void> {
  return inTerminalTransaction<void>(STORE_META, 'readwrite', (tx, done) => { tx.objectStore(STORE_META).put(v, k); done(undefined); });
}

export const loadMenuCache = (storeId: string) => read<CachedMenu>(key(storeId));
export const saveMenuCache = (c: CachedMenu) => write(key(c.storeId), c);
export const loadMenuSource = () => read<MenuSource>(SOURCE_KEY);
export const saveMenuSource = (s: MenuSource) => write(SOURCE_KEY, s);
