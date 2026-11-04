/**
 * Kitchen stations and kitchen routes - T-508 S2a. `docs/tasks/508-kitchen-stations-and-menu-to-pos.md` R1-R5, R10.
 *
 * A station is a place that cooks (Grill, Drinks); a route says which station cooks one menu item at one store. Every writer
 * here needs `manage_store_settings` AT THE STORE OF THE ROW (R10), authorizes before it judges any field, writes the audit row
 * in the same transaction, and writes nothing (no row, no audit) when the value is already what was asked for.
 * The database is the authority on the hard rules (same-store route, no route to a retired station, one active name per store,
 * SLA 1-240); the checks here only word the refusal. Screens are S2b.
 */
import { auditLogRepo, kitchenRepo, menuRepo, storesRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { gone, refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { KITCHEN_STATION_NAME_RULES, KITCHEN_STATION_SETTINGS_RULES } from '../field-rules/kitchen';

const CAPABILITY = 'manage_store_settings' as const;

export interface KitchenStationView {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly slaMinutes: number;
  readonly printOnOutage: boolean;
}
export interface KitchenRouteView {
  readonly menuItemId: string;
  readonly stationId: string;
}
export interface KitchenOfferedItem {
  readonly itemId: string;
  readonly name: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly stationId: string | null;
}
export interface KitchenSetup {
  readonly stations: KitchenStationView[];
  readonly routes: KitchenRouteView[];
  /** Every item with a store offer here, with its station (null = unrouted). */
  readonly offeredItems: KitchenOfferedItem[];
  /** R5: the offered items with no route. They stay off the POS until routed. */
  readonly notOnPos: KitchenOfferedItem[];
}

const view = (s: kitchenRepo.KitchenStationRow): KitchenStationView => ({
  id: s.id,
  name: s.name,
  sortOrder: s.sortOrder,
  slaMinutes: s.slaMinutes,
  printOnOutage: s.printOnOutage,
});
const snap = (s: kitchenRepo.KitchenStationRow) => ({
  name: s.name,
  sortOrder: s.sortOrder,
  slaMinutes: s.slaMinutes,
  printOnOutage: s.printOnOutage,
  status: s.status,
});

/** Read first, so the gate can use the row's OWN store; missing, another org's, all the same sentence. */
async function stationOf(tx: Tx, actor: Actor, stationId: string): Promise<kitchenRepo.KitchenStationRow> {
  const s = await kitchenRepo.stationById(tx, actor.orgId, stationId);
  if (!s) throw gone(`kitchen station ${stationId} not found`, 'kitchen station');
  return s;
}

async function assertStore(tx: Tx, actor: Actor, storeId: string): Promise<void> {
  if (!(await storesRepo.getById(tx, actor.orgId, storeId))) throw gone(`store ${storeId} not found`, 'store');
}

/** ⚠️ Only to WORD the refusal: the unique index `kitchen_stations_store_active_name_key` is what refuses a duplicate, races included. */
function isNameTaken(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === 'kitchen_stations_store_active_name_key') return true;
  }
  return false;
}
const nameTaken = (name: string) =>
  refuse(
    'kitchen station name already in use at this store',
    `This store already has a kitchen station called ${name}. Names are compared ignoring capital letters.`,
  );

async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  storeId: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, { actorPersonId: actor.personId, action, storeId, entityId, before, after, source: 'web' });
}

const numText = (n: number | undefined) => (n === undefined ? '' : String(n));

export async function createKitchenStation(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; name: string; slaMinutes?: number; printOnOutage?: boolean; sortOrder?: number },
): Promise<{ stationId: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  const { name } = assertFieldRules(KITCHEN_STATION_NAME_RULES, { name: input.name });
  const nums = assertFieldRules(KITCHEN_STATION_SETTINGS_RULES, { slaMinutes: numText(input.slaMinutes), sortOrder: numText(input.sortOrder) });
  await assertStore(tx, actor, input.storeId);
  let row: kitchenRepo.KitchenStationRow;
  try {
    row = await kitchenRepo.createStation(tx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      name: name!,
      ...(nums.slaMinutes === null ? {} : { slaMinutes: Number(nums.slaMinutes) }),
      ...(nums.sortOrder === null ? {} : { sortOrder: Number(nums.sortOrder) }),
      ...(input.printOnOutage === undefined ? {} : { printOnOutage: input.printOnOutage }),
      createdBy: actor.personId,
    });
  } catch (err) {
    if (isNameTaken(err)) throw nameTaken(name!);
    throw err;
  }
  await audit(tx, actor, 'kitchen_station.created', input.storeId, row.id, null, snap(row));
  return { stationId: row.id };
}

export async function renameKitchenStation(tx: Tx, actor: Actor, input: { stationId: string; name: string }): Promise<{ wrote: boolean }> {
  const before = await stationOf(tx, actor, input.stationId);
  await authorize(tx, actor, CAPABILITY, { storeId: before.storeId });
  const { name } = assertFieldRules(KITCHEN_STATION_NAME_RULES, { name: input.name });
  if (before.name === name) return { wrote: false };
  let after: kitchenRepo.KitchenStationRow;
  try {
    after = await kitchenRepo.renameStation(tx, actor.orgId, before.storeId, before.id, name!);
  } catch (err) {
    if (isNameTaken(err)) throw nameTaken(name!);
    throw err;
  }
  await audit(tx, actor, 'kitchen_station.renamed', before.storeId, before.id, { name: before.name }, { name: after.name });
  return { wrote: true };
}

/** SLA 1-240, print-on-outage, screen order. An omitted field is left alone. */
export async function updateKitchenStation(
  tx: Tx,
  actor: Actor,
  input: { stationId: string; slaMinutes?: number; printOnOutage?: boolean; sortOrder?: number },
): Promise<{ wrote: boolean }> {
  const before = await stationOf(tx, actor, input.stationId);
  await authorize(tx, actor, CAPABILITY, { storeId: before.storeId });
  const nums = assertFieldRules(KITCHEN_STATION_SETTINGS_RULES, { slaMinutes: numText(input.slaMinutes), sortOrder: numText(input.sortOrder) });
  const patch: kitchenRepo.StationPatch = {};
  if (nums.slaMinutes !== null && Number(nums.slaMinutes) !== before.slaMinutes) patch.slaMinutes = Number(nums.slaMinutes);
  if (nums.sortOrder !== null && Number(nums.sortOrder) !== before.sortOrder) patch.sortOrder = Number(nums.sortOrder);
  if (input.printOnOutage !== undefined && input.printOnOutage !== before.printOnOutage) patch.printOnOutage = input.printOnOutage;
  if (Object.keys(patch).length === 0) return { wrote: false };
  const after = await kitchenRepo.updateStation(tx, actor.orgId, before.storeId, before.id, patch);
  await audit(tx, actor, 'kitchen_station.updated', before.storeId, before.id, snap(before), snap(after));
  return { wrote: true };
}

/** R3: refused with a sentence that counts the routes while any item still cooks here (the repo words it). A retired station is a no-op. */
export async function retireKitchenStation(tx: Tx, actor: Actor, input: { stationId: string }): Promise<{ wrote: boolean }> {
  const before = await stationOf(tx, actor, input.stationId);
  await authorize(tx, actor, CAPABILITY, { storeId: before.storeId });
  if (before.status === 'retired') return { wrote: false };
  const after = await kitchenRepo.retireStation(tx, actor.orgId, before.storeId, before.id);
  await audit(tx, actor, 'kitchen_station.retired', before.storeId, before.id, snap(before), snap(after));
  return { wrote: true };
}

async function assertItem(tx: Tx, actor: Actor, menuItemId: string): Promise<void> {
  if (!(await menuRepo.getItem(tx, actor.orgId, menuItemId))) throw gone(`menu item ${menuItemId} not found`, 'menu item');
}

async function currentStation(tx: Tx, actor: Actor, storeId: string, menuItemId: string): Promise<string | null> {
  const routes = await kitchenRepo.listRoutes(tx, actor.orgId, storeId);
  return routes.find((r) => r.menuItemId === menuItemId)?.stationId ?? null;
}

/** One item cooks at one station at this store (a second call moves it). Same station again writes nothing. */
export async function setKitchenRoute(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; menuItemId: string; stationId: string },
): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  await assertStore(tx, actor, input.storeId);
  await assertItem(tx, actor, input.menuItemId);
  const current = await currentStation(tx, actor, input.storeId, input.menuItemId);
  if (current === input.stationId) return { wrote: false };
  await kitchenRepo.setRoute(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    menuItemId: input.menuItemId,
    stationId: input.stationId,
    createdBy: actor.personId,
  });
  await audit(tx, actor, 'kitchen_route.set', input.storeId, input.menuItemId, { stationId: current }, { stationId: input.stationId });
  return { wrote: true };
}

/** The item has no station at this store afterwards (it leaves the POS, R5). Nothing to clear writes nothing. */
export async function clearKitchenRoute(tx: Tx, actor: Actor, input: { storeId: string; menuItemId: string }): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  await assertStore(tx, actor, input.storeId);
  await assertItem(tx, actor, input.menuItemId);
  const current = await currentStation(tx, actor, input.storeId, input.menuItemId);
  if (current === null) return { wrote: false };
  await kitchenRepo.clearRoute(tx, actor.orgId, input.storeId, input.menuItemId);
  await audit(tx, actor, 'kitchen_route.cleared', input.storeId, input.menuItemId, { stationId: current }, { stationId: null });
  return { wrote: true };
}

/**
 * "Set every item in this category to station X" at one store, in the caller's one transaction. Only the ACTIVE items directly
 * in the category are touched. One audit row for the whole act: before = each changed item's old station, after = the new one.
 */
export async function setKitchenRoutesForCategory(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; categoryId: string; stationId: string },
): Promise<{ changed: number }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  await assertStore(tx, actor, input.storeId);
  if (!(await menuRepo.getCategory(tx, actor.orgId, input.categoryId))) throw gone(`menu category ${input.categoryId} not found`, 'menu category');
  const itemIds = await kitchenRepo.activeItemIdsInCategory(tx, actor.orgId, input.categoryId);
  const routes = new Map((await kitchenRepo.listRoutes(tx, actor.orgId, input.storeId)).map((r) => [r.menuItemId, r.stationId]));
  const changing = itemIds.filter((id) => routes.get(id) !== input.stationId);
  if (changing.length === 0) return { changed: 0 };
  for (const menuItemId of changing) {
    await kitchenRepo.setRoute(tx, { orgId: actor.orgId, storeId: input.storeId, menuItemId, stationId: input.stationId, createdBy: actor.personId });
  }
  await audit(
    tx,
    actor,
    'kitchen_route.category_set',
    input.storeId,
    input.categoryId,
    { items: changing.map((id) => ({ itemId: id, stationId: routes.get(id) ?? null })) },
    { stationId: input.stationId, itemCount: changing.length },
  );
  return { changed: changing.length };
}

/**
 * The routing screen's read. ⚠️ No capability gate, as `listSalesChannelsForAdmin`: the gate belongs to the WRITE.
 * Org-filtered by the repo and RLS, so another org's store simply returns nothing.
 */
export async function listKitchenSetup(tx: Tx, actor: Actor, input: { storeId: string }): Promise<KitchenSetup> {
  const stations = await kitchenRepo.listStations(tx, actor.orgId, input.storeId);
  const routes = await kitchenRepo.listRoutes(tx, actor.orgId, input.storeId);
  const offered = await kitchenRepo.offeredItemsWithRoute(tx, actor.orgId, input.storeId);
  return {
    stations: stations.map(view),
    routes: routes.map((r) => ({ menuItemId: r.menuItemId, stationId: r.stationId })),
    offeredItems: offered,
    notOnPos: offered.filter((o) => o.stationId === null),
  };
}
