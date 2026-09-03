import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { locationTypes, stockLocations } from '../../schema/stock-locations';
import type { LocationPurpose, LocationRole, LocationStatus } from '../../schema/stock-locations';
import { stores } from '../../schema/stores';
import type { StockModel } from '../../schema/stores';
import type { Tx } from '../client';

/**
 * ⭐ T-165. The room a trade-order dispatch/receipt draws from when the order line does not name
 * one. Since T-172's `fulfilLine` (2026-09-03) a branch order's line CAN name its room; this stays
 * the fallback for a line that does not, and for every commissary-initiated transfer. A
 * `single_room` store has exactly one candidate; a `multi_room` store's default is the same
 * fallback T-160 already established elsewhere (`is_default`).
 */
export async function defaultLocationFor(tx: Tx, storeId: string): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(and(eq(stockLocations.storeId, storeId), eq(stockLocations.isDefault, true), eq(stockLocations.status, 'active')))
    .limit(1);
  return row;
}

export interface LocationOption {
  id: string;
  storeId: string;
  code: string;
  name: string;
  isDefault: boolean;
}

/** T-172. The rooms a fulfilment line may draw from — the source-room picker's list. */
export async function listActiveLocations(tx: Tx, storeId: string): Promise<LocationOption[]> {
  return tx
    .select({
      id: stockLocations.id,
      storeId: stockLocations.storeId,
      code: stockLocations.code,
      name: stockLocations.name,
      isDefault: stockLocations.isDefault,
    })
    .from(stockLocations)
    .where(and(eq(stockLocations.storeId, storeId), eq(stockLocations.status, 'active')))
    .orderBy(asc(stockLocations.name));
}

// -----------------------------------------------------------------------------------------
// DEF-135 (2026-09-03) — the room CRUD itself. Until now the only writer of a real
// `stock_locations` row anywhere in the codebase was a raw SQL insert in a dev-seed script.
// -----------------------------------------------------------------------------------------

export interface LocationRow {
  id: string;
  orgId: string;
  storeId: string;
  code: string;
  name: string;
  typeId: string;
  typeName: string;
  role: LocationRole;
  purpose: LocationPurpose;
  isDefault: boolean;
  status: LocationStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
}

const LOCATION_ROW_COLUMNS = {
  id: stockLocations.id,
  orgId: stockLocations.orgId,
  storeId: stockLocations.storeId,
  code: stockLocations.code,
  name: stockLocations.name,
  typeId: stockLocations.typeId,
  typeName: locationTypes.name,
  role: stockLocations.role,
  purpose: stockLocations.purpose,
  isDefault: stockLocations.isDefault,
  status: stockLocations.status,
  createdBy: stockLocations.createdBy,
  createdAt: stockLocations.createdAt,
  updatedAt: stockLocations.updatedAt,
} as const;

/** Every room in a store, WHATEVER its status — the screen shows retired rooms too, so a manager
 *  can reactivate one instead of only ever seeing what is currently live. Default-first, then
 *  alphabetical: the room a receive falls back to (`resolveReceivingLocation`) is always the first
 *  thing on screen. */
export async function listLocations(tx: Tx, storeId: string): Promise<LocationRow[]> {
  return tx
    .select(LOCATION_ROW_COLUMNS)
    .from(stockLocations)
    .innerJoin(locationTypes, eq(locationTypes.id, stockLocations.typeId))
    .where(eq(stockLocations.storeId, storeId))
    .orderBy(desc(stockLocations.isDefault), asc(stockLocations.name));
}

export async function getLocation(tx: Tx, id: string): Promise<LocationRow | undefined> {
  const [row] = await tx
    .select(LOCATION_ROW_COLUMNS)
    .from(stockLocations)
    .innerJoin(locationTypes, eq(locationTypes.id, stockLocations.typeId))
    .where(eq(stockLocations.id, id))
    .limit(1);
  return row;
}

export interface InsertLocationInput {
  orgId: string;
  storeId: string;
  code: string;
  name: string;
  typeId: string;
  role: LocationRole;
  purpose: LocationPurpose;
  isDefault: boolean;
  createdBy: string;
}

export async function insertLocation(tx: Tx, input: InsertLocationInput): Promise<{ id: string }> {
  const [row] = await tx.insert(stockLocations).values(input).returning({ id: stockLocations.id });
  return row!;
}

export interface UpdateLocationPatch {
  name?: string;
  typeId?: string;
  role?: LocationRole;
  isDefault?: boolean;
}

export async function updateLocation(tx: Tx, id: string, patch: UpdateLocationPatch): Promise<void> {
  await tx
    .update(stockLocations)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(stockLocations.id, id));
}

/** ⭐ Invariant 2's other half. Clears the default flag off every OTHER room in the store,
 *  ACTIVE OR NOT — a retired room left holding the flag trips the partial unique index the moment
 *  it reactivates, at a form that has nothing to do with defaults (`rules.ts`'s `defaultsToClear`
 *  documents why; the domain service calls that first and passes the result here). */
export async function clearDefaults(tx: Tx, storeId: string, exceptId: string): Promise<void> {
  await tx
    .update(stockLocations)
    .set({ isDefault: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(stockLocations.storeId, storeId),
        eq(stockLocations.isDefault, true),
        ne(stockLocations.id, exceptId),
      ),
    );
}

export async function setLocationStatus(tx: Tx, id: string, status: LocationStatus): Promise<void> {
  await tx
    .update(stockLocations)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(stockLocations.id, id));
}

export interface LocationTypeRow {
  id: string;
  orgId: string;
  code: string;
  name: string;
  sortOrder: number;
}

export async function listLocationTypes(tx: Tx, orgId: string): Promise<LocationTypeRow[]> {
  return tx
    .select({
      id: locationTypes.id,
      orgId: locationTypes.orgId,
      code: locationTypes.code,
      name: locationTypes.name,
      sortOrder: locationTypes.sortOrder,
    })
    .from(locationTypes)
    .where(eq(locationTypes.orgId, orgId))
    .orderBy(asc(locationTypes.sortOrder), asc(locationTypes.name));
}

export async function insertLocationType(
  tx: Tx,
  input: { orgId: string; code: string; name: string; sortOrder: number },
): Promise<{ id: string }> {
  const [row] = await tx.insert(locationTypes).values(input).returning({ id: locationTypes.id });
  return row!;
}

/**
 * ⭐ Invariant 5's readable half. The trigger (migration `0122`) is the CONTROL — this exists only
 * so the service can explain why before the database ever raises (bible §6.3: a service-level
 * pre-check is allowed to produce a better sentence, never as the enforcement itself).
 *
 * True when Σ `stock_movements.quantity` for ANY ITEM at this location is non-zero — never the
 * location's own grand total, which a receipt and a later full use-up of a DIFFERENT item could
 * net to zero while stock of a third item still sits there.
 */
export async function holdsStock(tx: Tx, locationId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select exists (
      select 1 from stock_movements
      where location_id = ${locationId}
      group by item_id
      having sum(quantity) <> 0
    ) as holds
  `)) as unknown as { holds: boolean }[];
  return rows[0]?.holds ?? false;
}

export interface StoreForLocations {
  id: string;
  orgId: string;
  stockModel: StockModel;
}

/** The store's org and `stock_model` — everything `seedStoreLocations`/`createLocation` need to
 *  know about the store itself, in one read. `undefined` when the store does not exist. */
export async function getStoreStockModel(tx: Tx, storeId: string): Promise<StoreForLocations | undefined> {
  const [row] = await tx
    .select({ id: stores.id, orgId: stores.orgId, stockModel: stores.stockModel })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  return row;
}
