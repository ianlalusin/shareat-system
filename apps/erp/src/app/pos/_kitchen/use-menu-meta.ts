'use client';

/**
 * T-529 - the stations and package refills for the Kitchen and Refills tabs. The store tablet has them in its cached snapshot (so the tab works offline);
 * a kitchen browser or a phone has no snapshot, so it asks `/api/pos/menu-meta` once and then every minute (the route answers 304 when nothing changed).
 * A failed read keeps what it had: the last good stations are better than none.
 */
import { useEffect, useMemo, useState } from 'react';
import type { MenuLike } from '../_orders/menu-filter';
import { POS_MENU_META_REFRESH_MS } from '../_shell/constants';
import type { PosContextValue } from '../_shell/pos-context';
import { menuMetaOf, type MenuMeta } from './menu-meta';

export function useMenuMeta(pos: Pick<PosContextValue, 'storeId' | 'ordersSnapshot'> | null): MenuMeta | null {
  const storeId = pos?.storeId ?? null;
  const snapshotMenu = pos?.ordersSnapshot?.menu ?? null;
  const fromSnapshot = useMemo(() => (snapshotMenu ? menuMetaOf(snapshotMenu as MenuLike) : null), [snapshotMenu]);
  const [fetched, setFetched] = useState<MenuMeta | null>(null);
  const needFetch = storeId !== null && fromSnapshot === null;
  useEffect(() => {
    if (!needFetch || !storeId) return;
    let stopped = false;
    const read = async () => {
      try {
        const res = await fetch(`/api/pos/menu-meta?storeId=${encodeURIComponent(storeId)}`, { credentials: 'same-origin' });
        if (!res.ok) return;
        const body = (await res.json()) as Partial<MenuMeta>;
        if (!stopped && Array.isArray(body.stations) && body.refillCatalog) setFetched({ stations: body.stations, refillCatalog: body.refillCatalog });
      } catch {
        // offline: keep the last good copy
      }
    };
    void read();
    const t = setInterval(read, POS_MENU_META_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [needFetch, storeId]);
  return fromSnapshot ?? fetched;
}
