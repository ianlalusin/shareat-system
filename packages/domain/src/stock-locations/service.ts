/**
 * T-160 — the stock-location service. DEF-135 (2026-09-03): the schema, migration `0062`, the
 * pure rules and 20 integration tests against real Postgres were built 2026-08-29 with ZERO
 * writers — the only INSERT into `stock_locations` anywhere in the codebase was a raw SQL line in
 * a dev-seed script. This file, `packages/db/src/repo/stock-locations.ts`'s new functions, and
 * `apps/erp/src/app/inventory/locations/` are what closes that gap.
 *
 * ⭐ Every mutation authorises `manage_locations` — store-scoped, manager+ (CAPABILITY-MATRIX.md,
 * already declared, not touched here) — as its FIRST statement (bible §7 rule 1).
 * `updateLocation`/`setDefaultLocation`/`deactivateLocation`/`reactivateLocation` load the row
 * FIRST and authorise at ITS OWN store, never a store the caller merely claims.
 *
 * ⚠️ **Every business refusal here THROWS — never `{ ok: false }`.** This module has no
 * multi-step workflow with several preconditions to check before a first write (contrast
 * `receiveDelivery`, `transferNow`, which return `{ ok: false, reason }` precisely because they
 * must check sufficiency, period-open, and more before writing anything, atomically). Every
 * function here is a single admin write, so it follows the shape `commissary/catalogue.ts`
 * already established for exactly this kind of function — the actions layer catches and
 * translates (see `apps/erp/src/app/inventory/locations/actions.ts`'s local `errorMessage`).
 */
import { authorize, type Actor } from '@shareat/auth';
import { stockLocationsRepo, type Tx } from '@shareat/db';
import type { LocationPurpose, LocationRole } from '@shareat/db/schema';
import { defaultsToClear, normaliseRole } from './rules';

const CAPABILITY = 'manage_locations' as const;

// -----------------------------------------------------------------------------------------
// The location-type catalogue — v1's, kept. A screen with no types to pick from is unusable.
// -----------------------------------------------------------------------------------------

const LOCATION_TYPE_CATALOGUE: readonly { code: string; name: string }[] = [
  { code: 'STOCKROOM', name: 'Stockroom' },
  { code: 'DISPLAY', name: 'Display' },
  { code: 'KITCHEN', name: 'Kitchen' },
  { code: 'RECEIVING', name: 'Receiving' },
  { code: 'QUARANTINE', name: 'Quarantine' },
  { code: 'TRANSIT', name: 'In-Transit' },
  { code: 'RETURNS', name: 'Returns' },
];

export interface EnsureLocationTypesInput {
  /**
   * ⚠️ **Not literally where the rows land** — `location_types` is org-wide (§5's contract), and
   * the org is the ACTOR's, never a caller-supplied one (review 2026-09-03). Every capability this
   * module checks is store-scoped (CAPABILITY-MATRIX.md), so the screen's currently-selected store
   * stands in for "this actor may administer locations at all" — the same store the "Set up rooms"
   * button is clicked from. Documented here rather than silently narrowed, per bible §3.4a.
   */
  readonly storeId: string;
}

/** Idempotent: seeds whichever of the seven catalogue codes this org does not already have. A
 *  second call, or a third, adds nothing — proven in `stock-locations-service.test.ts`. */
export async function ensureLocationTypes(
  tx: Tx,
  actor: Actor,
  input: EnsureLocationTypesInput,
): Promise<{ created: number }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  const existing = await stockLocationsRepo.listLocationTypes(tx, actor.orgId);
  const existingCodes = new Set(existing.map((t) => t.code));

  let created = 0;
  for (let i = 0; i < LOCATION_TYPE_CATALOGUE.length; i++) {
    const entry = LOCATION_TYPE_CATALOGUE[i]!;
    if (existingCodes.has(entry.code)) continue;
    await stockLocationsRepo.insertLocationType(tx, {
      orgId: actor.orgId,
      code: entry.code,
      name: entry.name,
      sortOrder: i,
    });
    created += 1;
  }
  return { created };
}

// -----------------------------------------------------------------------------------------
// Seeding a store's rooms — §5/§7 test 1-2.
// -----------------------------------------------------------------------------------------

export interface SeedStoreLocationsInput {
  readonly storeId: string;
}

export interface SeedStoreLocationsResult {
  readonly created: readonly { id: string; code: string; purpose: LocationPurpose }[];
}

/**
 * Idempotent per §5/§7: a `single_room` store gets one default OPERATING room ("Main") plus one
 * Receiving room; a `multi_room` store gets a default STORAGE room ("Stockroom") plus the same
 * Receiving room. **The same two rows either way** — only the default room's code/role differ. A
 * second call, once both exist, creates nothing; a store that already has a non-Receiving room
 * from elsewhere (e.g. seeded by hand) gets only the Receiving room it is missing.
 *
 * ⛔ Assumes `ensureLocationTypes` has already run for this org — the screen's "Set up rooms"
 * button calls both, in sequence, in the same request. Throws a readable message naming the
 * missing type rather than a raw FK error if it has not.
 */
export async function seedStoreLocations(
  tx: Tx,
  actor: Actor,
  input: SeedStoreLocationsInput,
): Promise<SeedStoreLocationsResult> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  const store = await stockLocationsRepo.getStoreStockModel(tx, input.storeId);
  if (!store) throw new Error(`seedStoreLocations: store ${input.storeId} does not exist.`);

  const existing = await stockLocationsRepo.listLocations(tx, input.storeId);
  const hasNonReceiving = existing.some((l) => l.status === 'active' && l.purpose !== 'receiving');
  const hasReceiving = existing.some((l) => l.status === 'active' && l.purpose === 'receiving');

  const types = await stockLocationsRepo.listLocationTypes(tx, store.orgId);
  const typeIdFor = (code: string): string => {
    const found = types.find((t) => t.code === code);
    if (!found) {
      throw new Error(
        `seedStoreLocations: location type "${code}" has not been seeded for this organisation — ` +
          'run "Set up rooms" again.',
      );
    }
    return found.id;
  };

  const created: { id: string; code: string; purpose: LocationPurpose }[] = [];
  const isSingleRoom = store.stockModel === 'single_room';

  if (!hasNonReceiving) {
    const code = isSingleRoom ? 'MAIN' : 'STOCKROOM';
    const { id } = await stockLocationsRepo.insertLocation(tx, {
      orgId: store.orgId,
      storeId: input.storeId,
      code,
      name: isSingleRoom ? 'Main' : 'Stockroom',
      typeId: typeIdFor(isSingleRoom ? 'KITCHEN' : 'STOCKROOM'),
      role: isSingleRoom ? 'operating' : 'storage',
      purpose: 'normal',
      isDefault: true,
      createdBy: actor.personId,
    });
    created.push({ id, code, purpose: 'normal' });
  }

  if (!hasReceiving) {
    const { id } = await stockLocationsRepo.insertLocation(tx, {
      orgId: store.orgId,
      storeId: input.storeId,
      code: 'RECEIVING',
      name: 'Receiving',
      typeId: typeIdFor('RECEIVING'),
      role: 'storage',
      purpose: 'receiving',
      isDefault: false,
      createdBy: actor.personId,
    });
    created.push({ id, code: 'RECEIVING', purpose: 'receiving' });
  }

  return { created };
}

// -----------------------------------------------------------------------------------------
// Room CRUD — create, rename/re-type/re-role, set default, deactivate/reactivate.
// -----------------------------------------------------------------------------------------

/** Invariant 2, both directions: clears every OTHER default in the store (active or not — see
 *  `clearDefaults`'s own comment) before setting this one, in the SAME transaction, so the partial
 *  unique index never sees two active defaults at once. */
async function applyDefault(tx: Tx, storeId: string, id: string): Promise<void> {
  const all = await stockLocationsRepo.listLocations(tx, storeId);
  const toClear = defaultsToClear(all, id);
  if (toClear.length > 0) {
    await stockLocationsRepo.clearDefaults(tx, storeId, id);
  }
  await stockLocationsRepo.updateLocation(tx, id, { isDefault: true });
}

export interface CreateLocationInput {
  readonly storeId: string;
  readonly code: string;
  readonly name: string;
  readonly typeId: string;
  readonly role: string;
  /** `true` only for "this is the Receiving room". Defaults to `'normal'`. */
  readonly purpose?: LocationPurpose;
  readonly isDefault?: boolean;
}

export async function createLocation(
  tx: Tx,
  actor: Actor,
  input: CreateLocationInput,
): Promise<{ id: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new Error('createLocation: a room needs a code.');
  if (!name) throw new Error('createLocation: a room needs a name.');

  const store = await stockLocationsRepo.getStoreStockModel(tx, input.storeId);
  if (!store) throw new Error(`createLocation: store ${input.storeId} does not exist.`);

  const types = await stockLocationsRepo.listLocationTypes(tx, store.orgId);
  if (!types.some((t) => t.id === input.typeId)) {
    throw new Error(`createLocation: that room type does not exist for this organisation.`);
  }

  const purpose: LocationPurpose = input.purpose === 'receiving' ? 'receiving' : 'normal';
  // ⭐ The fail-safe direction (rules.ts's `normaliseRole`) — never trust an unrecognised role off
  // the wire. A room ticked "this is Receiving" is always storage regardless of what the role
  // select posted; the CHECK constraint would refuse the mismatch anyway, but a person who
  // explicitly asked for a parking spot should never see a role error for a field they didn't mean
  // to set.
  const role: LocationRole = purpose === 'receiving' ? 'storage' : normaliseRole(input.role);

  const { id } = await stockLocationsRepo.insertLocation(tx, {
    orgId: store.orgId,
    storeId: input.storeId,
    code,
    name,
    typeId: input.typeId,
    role,
    purpose,
    isDefault: false,
    createdBy: actor.personId,
  });

  // ⭐ Inserted with isDefault:false above, THEN promoted — inserting isDefault:true directly could
  // collide with an existing active default inside the same statement; clearing first (as
  // `applyDefault` does) is what `stock-locations.test.ts`'s own "flag can be MOVED within one
  // transaction" case relies on.
  if (input.isDefault) {
    await applyDefault(tx, input.storeId, id);
  }

  return { id };
}

export interface UpdateLocationInput {
  readonly id: string;
  readonly name?: string;
  readonly typeId?: string;
  readonly role?: string;
}

export async function updateLocation(
  tx: Tx,
  actor: Actor,
  input: UpdateLocationInput,
): Promise<{ id: string }> {
  const row = await stockLocationsRepo.getLocation(tx, input.id);
  if (!row) throw new Error(`updateLocation: location ${input.id} does not exist.`);
  await authorize(tx, actor, CAPABILITY, { storeId: row.storeId });

  const patch: { name?: string; typeId?: string; role?: LocationRole } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error('updateLocation: a room needs a name.');
    patch.name = name;
  }

  if (input.typeId !== undefined && input.typeId !== row.typeId) {
    const types = await stockLocationsRepo.listLocationTypes(tx, row.orgId);
    if (!types.some((t) => t.id === input.typeId)) {
      throw new Error('updateLocation: that room type does not exist for this organisation.');
    }
    patch.typeId = input.typeId;
  }

  if (input.role !== undefined) {
    // ⭐ Invariant: `stock_locations_receiving_is_storage_check` — stated here as a sentence
    // rather than left for the constraint to explain, since a person editing the Receiving room's
    // role specifically asked for the one thing this room can never be.
    if (row.purpose === 'receiving') {
      throw new Error('updateLocation: the Receiving room is always a storage room and cannot be re-roled.');
    }
    patch.role = normaliseRole(input.role);
  }

  if (Object.keys(patch).length > 0) {
    await stockLocationsRepo.updateLocation(tx, input.id, patch);
  }
  return { id: input.id };
}

export async function setDefaultLocation(tx: Tx, actor: Actor, input: { id: string }): Promise<{ id: string }> {
  const row = await stockLocationsRepo.getLocation(tx, input.id);
  if (!row) throw new Error(`setDefaultLocation: location ${input.id} does not exist.`);
  await authorize(tx, actor, CAPABILITY, { storeId: row.storeId });

  if (row.status !== 'active') {
    throw new Error('setDefaultLocation: an inactive room cannot be the default — reactivate it first.');
  }
  if (row.isDefault) return { id: input.id };

  await applyDefault(tx, row.storeId, input.id);
  return { id: input.id };
}

export async function deactivateLocation(tx: Tx, actor: Actor, input: { id: string }): Promise<{ id: string }> {
  const row = await stockLocationsRepo.getLocation(tx, input.id);
  if (!row) throw new Error(`deactivateLocation: location ${input.id} does not exist.`);
  await authorize(tx, actor, CAPABILITY, { storeId: row.storeId });

  if (row.status === 'inactive') return { id: input.id };

  // ⭐ Invariant 5's readable half. Migration `0122`'s trigger is the CONTROL — checked directly
  // in raw SQL by `stock-locations-service.test.ts` test 6 — this exists only so a manager sees a
  // sentence naming the room instead of a raw trigger exception.
  const holds = await stockLocationsRepo.holdsStock(tx, input.id);
  if (holds) {
    throw new Error(`deactivateLocation: "${row.name}" still holds stock and cannot be deactivated.`);
  }

  // ⛔ The default room is where an undecided receive line falls back to (`defaultLocationFor`
  // filters on `active`); retiring it silently leaves the store with no default and the next
  // receipt with nowhere to park. Make another room the default first (review 2026-09-03).
  if (row.isDefault) {
    throw new Error(
      `deactivateLocation: "${row.name}" is the store's default room — make another room the default first.`,
    );
  }

  await stockLocationsRepo.setLocationStatus(tx, input.id, 'inactive');
  return { id: input.id };
}

/** Never blocked by invariant 6's single-room trigger for the store THIS row already belonged to
 *  — that trigger fires on this exact UPDATE when it would recreate an illegal second room
 *  (`stock-locations.test.ts`: "the trigger fires on UPDATE too"), and its raised message surfaces
 *  through the same `errorMessage` mapping as a create. */
export async function reactivateLocation(tx: Tx, actor: Actor, input: { id: string }): Promise<{ id: string }> {
  const row = await stockLocationsRepo.getLocation(tx, input.id);
  if (!row) throw new Error(`reactivateLocation: location ${input.id} does not exist.`);
  await authorize(tx, actor, CAPABILITY, { storeId: row.storeId });

  if (row.status === 'active') return { id: input.id };

  await stockLocationsRepo.setLocationStatus(tx, input.id, 'active');
  return { id: input.id };
}
