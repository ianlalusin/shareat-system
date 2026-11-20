/**
 * T-603 - store gates for the screens that pick a store (and for single records that belong to one).
 *
 * Keyed on the route map, so the nav, the route gate and the store filter read ONE list of capabilities and cannot disagree.
 * A page asks `storePageScope(route, sp.store)`; a `[id]` page asks `recordInScope(actor, route, record.storeId)` and calls
 * `notFound()` on false (T-577: a record outside the viewer's stores is the same page as a forged id).
 */
import type { ReactNode } from 'react';
import { asc, eq } from 'drizzle-orm';
import type { Actor } from '@shareat/auth';
import { schema } from '@shareat/db';
import { withOrgPrincipal } from '../app/expenses/lib';
import type { StoreOption } from '../app/reports/lib';
import { canReadAtStore, isOrgWideRole } from './can-read-at-store';
import { heldStoreIdsOrAll, heldStoresFor } from './held-stores';
import { requirePageAccess, StoreNotAvailable } from './page-access';
import { capabilitiesForRoute } from './route-capability';

export type StorePageScope = { actor: Actor; stores: StoreOption[]; storeId: string } | { refusal: ReactNode };

/** The route gate, then the stores where the actor holds one of the route's words. A requested store outside that list is one sentence, never a quiet fallback (T-435). */
export async function storePageScope(route: string, requested: string | undefined): Promise<StorePageScope> {
  const { actor, refusal } = await requirePageAccess(route);
  if (refusal) return { refusal };
  const capabilities = capabilitiesForRoute(route);
  // Closed (retired) stores stay pickable where the viewer holds them: cash, stock and money screens still have to be worked for a closed branch.
  // An org-wide role (admin, super_admin) is never store-filtered on a read, whatever its scope rows say (T-577 round 3), so it gets every store;
  // anyone else gets the stores where one of the route's words is held (`includeRetired`: only where they have a scope row, as `can()` does).
  const { stores, activeIds } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const all = await tx
      .select({ id: schema.stores.id, name: schema.stores.name, code: schema.stores.code, isActive: schema.stores.isActive })
      .from(schema.stores)
      .where(eq(schema.stores.orgId, actor.orgId))
      .orderBy(asc(schema.stores.name));
    const held = (await isOrgWideRole(tx, actor)) ? all : await heldStoresFor(tx, actor, capabilities, { includeRetired: true });
    return { stores: held.map(({ id, name, code }) => ({ id, name, code })), activeIds: new Set(all.filter((r) => r.isActive).map((r) => r.id)) };
  });
  // The default is an open store, never a closed one that sorts first by name.
  const storeId = requested ?? (stores.find((s) => activeIds.has(s.id)) ?? stores[0])?.id;
  if (!storeId || !stores.some((s) => s.id === storeId)) return { refusal: <StoreNotAvailable /> };
  return { actor, stores, storeId };
}

/** May `actor` read a record at `storeId` on `route`? (any of the route's words there; org-wide roles always). */
export function recordInScope(actor: Actor, route: string, storeId: string): Promise<boolean> {
  return withOrgPrincipal(actor.orgId, (tx) => canReadAtStore(tx, actor, storeId, capabilitiesForRoute(route)));
}

/** The store ids a LIST may show on `route`; `undefined` = every store (the viewer is not store-limited). */
export function listStoreIds(actor: Actor, route: string): Promise<readonly string[] | undefined> {
  return withOrgPrincipal(actor.orgId, (tx) => heldStoreIdsOrAll(tx, actor, capabilitiesForRoute(route)));
}
