/**
 * T-508 S3 (R4, R5, R11) - the live-data loader for the store-menu projection. Reads through the repos (no SQL here), builds the
 * plain `MenuSnapshot` for ONE store, and hands it to the pure `projectStoreMenu`. Station names and SLA come from the live
 * station rows at this instant, so a rename changes the projected name and the content hash.
 */
import { resolvePosTerminalLink } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import { kitchenRepo, menuRepo, type Tx } from '@shareat/db';
import { loadLiveStoreOffers } from './live-offers';
import { projectStoreMenu, type MenuSnapshot, type ProjectedStoreMenu } from './project';

export async function loadStoreMenu(tx: Tx, orgId: string, storeId: string, at?: Date, opts?: { showWithdrawnStore?: boolean }): Promise<ProjectedStoreMenu> {
  return (await loadStoreMenuWithVersions(tx, orgId, storeId, at, opts)).menu;
}

/**
 * The same menu, plus (T-565) for each variant whose STORE offer is dayparted the id of the window version that offer was judged by at `at`
 * (a variant with an all-day offer, or none, is absent). A POS line records it. The windows are those in force at `at`, never today's edited ones.
 */
export async function loadStoreMenuWithVersions(
  tx: Tx,
  orgId: string,
  storeId: string,
  at?: Date,
  opts?: { showWithdrawnStore?: boolean },
): Promise<{ menu: ProjectedStoreMenu; versionOfVariant: ReadonlyMap<string, string> }> {
  const when = at ?? (await menuRepo.dbNow(tx));
  const [catalog, live, optionOffers, upcoming, stations, routes] = await Promise.all([
    menuRepo.catalogOfOrg(tx, orgId),
    loadLiveStoreOffers(tx, orgId, storeId, when), // T-510 S1b: at most one offer per variant and channel, chosen by the daypart open now
    menuRepo.optionOffersInForce(tx, storeId, when),
    menuRepo.upcomingOfferDates(tx, storeId, when),
    kitchenRepo.listStations(tx, orgId, storeId),
    kitchenRepo.listRoutes(tx, orgId, storeId),
  ]);
  // Fail closed: a variant whose offers cannot be resolved is simply not offered; say so, never fall back to another price.
  if (live.faults.length > 0) logger.warn({ storeId, faults: live.faults }, 'loadStoreMenu: offers that cannot be resolved are left out');
  const snapshot: MenuSnapshot = {
    ...catalog,
    stores: [{ storeId, at: when, offers: live.offers, optionOffers, upcoming, notOfferedNow: live.notOfferedNow, nextDaypartBoundary: live.nextBoundaryAt, hours: live.hours ?? undefined, slots: live.slots }],
    stations,
    routes,
  };
  const versionOfVariant = new Map<string, string>();
  for (const o of live.offers) {
    const version = o.channel === 'store' && !o.withdrawn && o.daypartId !== null ? live.daypartVersionIds.get(o.daypartId) : undefined;
    if (version !== undefined) versionOfVariant.set(o.variantId, version);
  }
  return { menu: projectStoreMenu(snapshot, storeId, when, opts), versionOfVariant };
}

/**
 * T-508 S4 (R6) - the menu a POS tablet is served. The store is the device's ACTIVE terminal link, never anything the request names.
 * No link / unknown / non-uuid device -> AuthenticationError (the route answers 401).
 */
export async function loadMenuForTerminal(tx: Tx, orgId: string, input: { posStoreId: string; deviceId: string }): Promise<ProjectedStoreMenu> {
  const link = await resolvePosTerminalLink(tx, { orgId, posStoreId: input.posStoreId, deviceId: input.deviceId });
  return loadStoreMenu(tx, orgId, link.erpStoreId);
}
