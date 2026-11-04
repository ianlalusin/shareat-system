/**
 * T-508 S3 (R4, R5, R11) - the live-data loader for the store-menu projection. Reads through the repos (no SQL here), builds the
 * plain `MenuSnapshot` for ONE store, and hands it to the pure `projectStoreMenu`. Station names and SLA come from the live
 * station rows at this instant, so a rename changes the projected name and the content hash.
 */
import { resolvePosTerminalLink } from '@shareat/auth';
import { kitchenRepo, menuRepo, type Tx } from '@shareat/db';
import { projectStoreMenu, type MenuSnapshot, type ProjectedStoreMenu } from './project';

export async function loadStoreMenu(tx: Tx, orgId: string, storeId: string, at?: Date): Promise<ProjectedStoreMenu> {
  const when = at ?? (await menuRepo.dbNow(tx));
  const [catalog, offers, optionOffers, upcoming, stations, routes] = await Promise.all([
    menuRepo.catalogOfOrg(tx, orgId),
    menuRepo.offersInForce(tx, storeId, when),
    menuRepo.optionOffersInForce(tx, storeId, when),
    menuRepo.upcomingOfferDates(tx, storeId, when),
    kitchenRepo.listStations(tx, orgId, storeId),
    kitchenRepo.listRoutes(tx, orgId, storeId),
  ]);
  const snapshot: MenuSnapshot = {
    ...catalog,
    stores: [{ storeId, at: when, offers, optionOffers, upcoming }],
    stations,
    routes,
  };
  return projectStoreMenu(snapshot, storeId, when);
}

/**
 * T-508 S4 (R6) - the menu a POS tablet is served. The store is the device's ACTIVE terminal link, never anything the request names.
 * No link / unknown / non-uuid device -> AuthenticationError (the route answers 401).
 */
export async function loadMenuForTerminal(tx: Tx, orgId: string, input: { posStoreId: string; deviceId: string }): Promise<ProjectedStoreMenu> {
  const link = await resolvePosTerminalLink(tx, { orgId, posStoreId: input.posStoreId, deviceId: input.deviceId });
  return loadStoreMenu(tx, orgId, link.erpStoreId);
}
