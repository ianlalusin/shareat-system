/**
 * T-508 S1 - the only place SQL is written for kitchen stations and kitchen routes.
 * docs/tasks/508-kitchen-stations-and-menu-to-pos.md R1-R3; tables in `packages/db/schema/kitchen.ts` (migration 0232).
 *
 * Plain reads and writes. Authorisation (`manage_store_settings`, R10) and the audit rows are the domain's job (S2); the
 * database refuses what must never happen (a cross-store route, a route to a retired station, a duplicate active name,
 * an SLA outside 1-240), and its refusals (23503, 23505, 23514) propagate as they are for the domain to word.
 * Two refusals are decided here because a person needs a sentence, not a constraint name:
 *   - retiring a station that still has routes (R3): `KitchenStationInUseError`, carrying the route count;
 *   - a station that is not at this store, or is retired, when routing an item to it: a "could not be found" refusal.
 *
 * Every function takes the caller's transaction first. Every read and write filters by org AND store; RLS is the backstop.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { kitchenRoutes, kitchenStations } from '../../schema/kitchen';
import { RefusalError, refuse } from '../refusal';
import { recordGone } from './record-gone';
import type { Tx } from '../client';

export type KitchenStationRow = typeof kitchenStations.$inferSelect;
export type KitchenRouteRow = typeof kitchenRoutes.$inferSelect;

/**
 * R3: a station that still has routes cannot be retired. `routeCount` is how many items route to it, for the sentence and
 * for the link to the routing screen the ERP shows.
 */
export class KitchenStationInUseError extends RefusalError {
  readonly routeCount: number;

  constructor(message: string, userMessage: string, routeCount: number) {
    super(message, userMessage);
    this.name = 'KitchenStationInUseError';
    this.routeCount = routeCount;
  }
}

/** A factory, not `throw new`: the sentence goes through `refuse` (UUIDs redacted) and the repo-throw census (T-343) stays satisfied. */
function stationInUse(stationName: string, routeCount: number): KitchenStationInUseError {
  const items = routeCount === 1 ? 'item' : 'items';
  const them = routeCount === 1 ? 'it' : 'them';
  const e = refuse(
    `kitchen station has ${routeCount} routes`,
    `${stationName} still cooks ${routeCount} ${items}. Move ${them} to another station on the Kitchen routing screen first, then retire ${stationName}.`,
  );
  return new KitchenStationInUseError(e.message, e.userMessage, routeCount);
}

// ---------------------------------------------------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------------------------------------------------
/** Active stations of one store in screen order (sort order, then name). `includeRetired` adds the retired ones, retired first. */
export async function listStations(
  tx: Tx,
  orgId: string,
  storeId: string,
  opts: { includeRetired?: boolean } = {},
): Promise<KitchenStationRow[]> {
  const where = and(
    eq(kitchenStations.orgId, orgId),
    eq(kitchenStations.storeId, storeId),
    opts.includeRetired ? undefined : eq(kitchenStations.status, 'active'),
  );
  return tx
    .select()
    .from(kitchenStations)
    .where(where)
    .orderBy(asc(kitchenStations.sortOrder), asc(sql`lower(${kitchenStations.name})`), asc(kitchenStations.id));
}

/** One station of this store, `forUpdate` locks it so a route check and a retire cannot interleave. */
export async function getStation(
  tx: Tx,
  orgId: string,
  storeId: string,
  stationId: string,
  forUpdate = false,
): Promise<KitchenStationRow | undefined> {
  const q = tx
    .select()
    .from(kitchenStations)
    .where(and(eq(kitchenStations.id, stationId), eq(kitchenStations.orgId, orgId), eq(kitchenStations.storeId, storeId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  return row;
}

export interface CreateStationInput {
  orgId: string;
  storeId: string;
  name: string;
  sortOrder?: number;
  /** 1-240, default 10 (the database refuses anything else: 23514). */
  slaMinutes?: number;
  printOnOutage?: boolean;
  createdBy: string;
}

export async function createStation(tx: Tx, input: CreateStationInput): Promise<KitchenStationRow> {
  const [row] = await tx
    .insert(kitchenStations)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      name: input.name.trim(),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.slaMinutes === undefined ? {} : { slaMinutes: input.slaMinutes }),
      ...(input.printOnOutage === undefined ? {} : { printOnOutage: input.printOnOutage }),
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

/** Rename is free (R4: no copy of the name exists anywhere). A name already used by another ACTIVE station of the store is 23505. */
export async function renameStation(tx: Tx, orgId: string, storeId: string, stationId: string, name: string): Promise<KitchenStationRow> {
  return patchStation(tx, orgId, storeId, stationId, { name: name.trim() });
}

export interface StationPatch {
  slaMinutes?: number;
  printOnOutage?: boolean;
  sortOrder?: number;
}

export async function updateStation(tx: Tx, orgId: string, storeId: string, stationId: string, patch: StationPatch): Promise<KitchenStationRow> {
  return patchStation(tx, orgId, storeId, stationId, patch);
}

async function patchStation(
  tx: Tx,
  orgId: string,
  storeId: string,
  stationId: string,
  patch: { name?: string } & StationPatch,
): Promise<KitchenStationRow> {
  const [row] = await tx
    .update(kitchenStations)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.slaMinutes === undefined ? {} : { slaMinutes: patch.slaMinutes }),
      ...(patch.printOnOutage === undefined ? {} : { printOnOutage: patch.printOnOutage }),
      ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(kitchenStations.id, stationId), eq(kitchenStations.orgId, orgId), eq(kitchenStations.storeId, storeId)))
    .returning();
  if (!row) throw recordGone(`kitchen station ${stationId} not found at store ${storeId}`, 'kitchen station');
  return row;
}

/**
 * R3: retire, never delete. Refused with the route count while any item still routes to the station. The station row is
 * locked first, so a `setRoute` racing this call either lands before (and is counted) or waits and then finds a retired
 * station; the composite FK on kitchen_routes is the backstop for a writer that does not take this lock.
 */
export async function retireStation(tx: Tx, orgId: string, storeId: string, stationId: string): Promise<KitchenStationRow> {
  const station = await getStation(tx, orgId, storeId, stationId, true);
  if (!station) throw recordGone(`kitchen station ${stationId} not found at store ${storeId}`, 'kitchen station');
  const routeCount = await countRoutesTo(tx, orgId, storeId, stationId);
  if (routeCount > 0) {
    throw stationInUse(station.name, routeCount);
  }
  const [row] = await tx
    .update(kitchenStations)
    .set({ status: 'retired', updatedAt: sql`now()` })
    .where(and(eq(kitchenStations.id, stationId), eq(kitchenStations.orgId, orgId), eq(kitchenStations.storeId, storeId)))
    .returning();
  return row!;
}

export async function countRoutesTo(tx: Tx, orgId: string, storeId: string, stationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(kitchenRoutes)
    .where(and(eq(kitchenRoutes.orgId, orgId), eq(kitchenRoutes.storeId, storeId), eq(kitchenRoutes.stationId, stationId)));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes (R2: one per menu item per store)
// ---------------------------------------------------------------------------------------------------------------------
export async function listRoutes(tx: Tx, orgId: string, storeId: string): Promise<KitchenRouteRow[]> {
  return tx
    .select()
    .from(kitchenRoutes)
    .where(and(eq(kitchenRoutes.orgId, orgId), eq(kitchenRoutes.storeId, storeId)))
    .orderBy(asc(kitchenRoutes.menuItemId));
}

export interface SetRouteInput {
  orgId: string;
  storeId: string;
  menuItemId: string;
  stationId: string;
  createdBy: string;
}

/**
 * Upsert: the item's route at this store becomes `stationId` (a second call moves it). The station must be an ACTIVE station
 * of this store; anything else is a "could not be found" refusal. The station row is locked for the duration so it cannot be
 * retired between the check and the write.
 */
export async function setRoute(tx: Tx, input: SetRouteInput): Promise<KitchenRouteRow> {
  const station = await getStation(tx, input.orgId, input.storeId, input.stationId, true);
  if (!station || station.status !== 'active') {
    throw recordGone(
      `kitchen station ${input.stationId} is not an active station of store ${input.storeId}`,
      'kitchen station',
      'active',
    );
  }
  const [row] = await tx
    .insert(kitchenRoutes)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      menuItemId: input.menuItemId,
      stationId: input.stationId,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [kitchenRoutes.storeId, kitchenRoutes.menuItemId],
      set: { stationId: input.stationId, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}

/** Removes the item's route at this store. Clearing a route that is not there is not an error. */
export async function clearRoute(tx: Tx, orgId: string, storeId: string, menuItemId: string): Promise<void> {
  await tx
    .delete(kitchenRoutes)
    .where(and(eq(kitchenRoutes.orgId, orgId), eq(kitchenRoutes.storeId, storeId), eq(kitchenRoutes.menuItemId, menuItemId)));
}

// ---------------------------------------------------------------------------------------------------------------------
// T-508 S2a reads for the domain (still no authorisation here)
// ---------------------------------------------------------------------------------------------------------------------
/** A station by id alone, so the domain can read the row's OWN store before it authorizes. Org-scoped; RLS is the backstop. */
export async function stationById(tx: Tx, orgId: string, stationId: string): Promise<KitchenStationRow | undefined> {
  const [row] = await tx
    .select()
    .from(kitchenStations)
    .where(and(eq(kitchenStations.id, stationId), eq(kitchenStations.orgId, orgId)));
  return row;
}

/** Ids of the ACTIVE items directly in one category (the "set every item in this category" action). */
export async function activeItemIdsInCategory(tx: Tx, orgId: string, categoryId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select id from menu_items where org_id = ${orgId} and category_id = ${categoryId} and status = 'active' order by id
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export interface OfferedItemRow {
  itemId: string;
  name: string;
  categoryId: string;
  categoryName: string;
  /** The item's route at this store, null when it has none (R5: it is then not on the POS). */
  stationId: string | null;
}

/**
 * R5: every ACTIVE item with a store-channel offer in force NOW at this store (any active variant, not withdrawn), with its
 * route or null. The routing screen lists these; the null ones are the red "Not on the POS yet" panel.
 */
export async function offeredItemsWithRoute(tx: Tx, orgId: string, storeId: string): Promise<OfferedItemRow[]> {
  const rows = (await tx.execute(sql`
    select i.id as item_id, i.name, c.id as category_id, c.name as category_name, r.station_id
      from menu_items i
      join menu_categories c on c.id = i.category_id
      left join kitchen_routes r on r.store_id = ${storeId} and r.menu_item_id = i.id
     where i.org_id = ${orgId} and i.status = 'active'
       and exists (
         select 1 from menu_item_variants v
          cross join lateral menu_offer_in_force(${storeId}, v.id, 'store', now()) f
          where v.menu_item_id = i.id and v.status = 'active' and not f.withdrawn
       )
     order by lower(c.name), c.id, i.sort_order, lower(i.name), i.id
  `)) as unknown as { item_id: string; name: string; category_id: string; category_name: string; station_id: string | null }[];
  return rows.map((r) => ({
    itemId: r.item_id,
    name: r.name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    stationId: r.station_id,
  }));
}
