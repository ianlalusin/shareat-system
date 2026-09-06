/**
 * The only place SQL is written for stores. T-152.
 *
 * ⚠️ **Small on purpose.** Store *identity* is read through Drizzle in the app helpers today; what
 * lives here is the **cash-custody policy** (bible row 129), because it is a money control and
 * changing it changes how much cash may sit in a drawer.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { stores, type RemittanceCadence } from '../../schema/stores';

export interface StoreCashPolicy {
  storeId: string;
  name: string;
  remittanceCadence: RemittanceCadence;
  /** ⚠️ Null only while the cadence is `daily` — the database refuses it otherwise. */
  unremittedCeiling: string | null;
}

export async function cashPolicy(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<StoreCashPolicy | null> {
  const [row] = await tx
    .select({
      storeId: stores.id,
      name: stores.name,
      remittanceCadence: stores.remittanceCadence,
      unremittedCeiling: stores.unremittedCeiling,
    })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, storeId)))
    .limit(1);
  return row ?? null;
}

/**
 * ⛔ **The database, not this function, is what makes the unsafe combination impossible.**
 *
 * `stores_pooling_requires_ceiling_check` refuses a non-daily cadence with no ceiling, so there is
 * deliberately **no second copy of that rule here** — bible §6.3: a rule re-implemented in
 * TypeScript is a second source of truth, and the two drift.
 *
 * ⚠️ Clearing the ceiling is expressed by passing `null`, which is only accepted alongside `daily`.
 */
export async function setCashPolicy(
  tx: Tx,
  orgId: string,
  input: { storeId: string; remittanceCadence: RemittanceCadence; unremittedCeiling: string | null },
): Promise<void> {
  await tx
    .update(stores)
    .set({
      remittanceCadence: input.remittanceCadence,
      unremittedCeiling: input.unremittedCeiling,
      updatedAt: new Date(),
    })
    .where(and(eq(stores.orgId, orgId), eq(stores.id, input.storeId)));
}

/**
 * T-204 — resolves a batch of store ids to their orgs, for the Firestore inbox relay: an event
 * carries a `storeId`, never an `orgId` (bible §5.1's own inbox shape), so `inbox_relay` needs a
 * `system`-principal cross-org lookup BEFORE it can open any org-scoped transaction. A storeId
 * absent from the returned map means no known store matches it — the caller leaves that event
 * un-stamped and excluded, per T-204 Contract §3 step 3.
 *
 * ⚠️ Deliberately no orgId filter — this runs as `system` (RLS bypassed by design, same as
 * `schedulerRepo.listOrgsToRun`) precisely because it must see every org's stores in one query.
 */
export async function orgIdsForStoreIds(
  tx: Tx,
  storeIds: readonly string[],
): Promise<Map<string, string>> {
  if (storeIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: stores.id, orgId: stores.orgId })
    .from(stores)
    .where(inArray(stores.id, [...storeIds]));
  return new Map(rows.map((r) => [r.id, r.orgId]));
}

// -----------------------------------------------------------------------------------------
// T-222 — store creation and management. ⛔ The SQL only; every rule lives in the database or
// the service. Note there is deliberately no `deleteStore`: a store accumulates journal
// entries, attendance and stock, so it is deactivated and never deleted (T-160's precedent
// for rooms, and v1's admin-only DELETE has no v2 counterpart).
// -----------------------------------------------------------------------------------------

export interface StoreRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly stockModel: string;
  readonly remittanceCadence: string;
  /** ⚠️ Decimal string or null — null is legal ONLY with a daily cadence, and the database is
   *  what enforces that pairing (`stores_pooling_requires_ceiling_check`). */
  readonly unremittedCeiling: string | null;
}

const STORE_COLUMNS = {
  id: stores.id,
  code: stores.code,
  name: stores.name,
  timezone: stores.timezone,
  isActive: stores.isActive,
  stockModel: stores.stockModel,
  remittanceCadence: stores.remittanceCadence,
  unremittedCeiling: stores.unremittedCeiling,
} as const;

/** Every store in the org, active first then by code — the `/admin/stores` list. */
export async function listForOrg(tx: Tx, orgId: string): Promise<StoreRow[]> {
  return tx
    .select(STORE_COLUMNS)
    .from(stores)
    .where(eq(stores.orgId, orgId))
    .orderBy(desc(stores.isActive), asc(stores.code)) as unknown as Promise<StoreRow[]>;
}

/** ⚠️ Scoped by org as well as id — an id from another tenant must read as absent, not as a row. */
export async function getById(tx: Tx, orgId: string, id: string): Promise<StoreRow | undefined> {
  const [row] = await tx
    .select(STORE_COLUMNS)
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, id)))
    .limit(1);
  return row as StoreRow | undefined;
}

export interface InsertStoreInput {
  readonly orgId: string;
  readonly code: string;
  readonly name: string;
  readonly timezone?: string;
  readonly stockModel?: 'single_room' | 'multi_room';
  readonly remittanceCadence?: string;
  readonly unremittedCeiling?: string | null;
}

export async function insertStore(tx: Tx, input: InsertStoreInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(stores)
    .values({
      orgId: input.orgId,
      code: input.code,
      name: input.name,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.stockModel ? { stockModel: input.stockModel } : {}),
      ...(input.remittanceCadence ? { remittanceCadence: input.remittanceCadence as 'daily' } : {}),
      ...(input.unremittedCeiling !== undefined ? { unremittedCeiling: input.unremittedCeiling } : {}),
    })
    .returning({ id: stores.id });
  return row!;
}

export interface UpdateStorePatch {
  readonly name?: string;
  readonly timezone?: string;
}

/**
 * ⛔ `code` is deliberately NOT patchable. Ian, T-222 open question 1: rename freely, but the code
 * is the stable handle — it is user-facing, appears on documents, and other records refer to it.
 */
export async function updateStore(tx: Tx, orgId: string, id: string, patch: UpdateStorePatch): Promise<void> {
  await tx
    .update(stores)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(stores.orgId, orgId), eq(stores.id, id)));
}

export async function setActive(tx: Tx, orgId: string, id: string, isActive: boolean): Promise<void> {
  await tx
    .update(stores)
    .set({ isActive, updatedAt: sql`now()` })
    .where(and(eq(stores.orgId, orgId), eq(stores.id, id)));
}

/**
 * ⭐ T-222 readiness input. Sales channels configured for this store — a **manual** check, because
 * which channels a branch sells through is a business fact and a default there would be, in v1's own
 * words, "a guess wearing the costume of a decision".
 */
export async function countSalesChannels(tx: Tx, orgId: string, storeId: string): Promise<number> {
  const [row] = (await tx.execute(sql`
    select count(*)::int as n from sales_channels
    where org_id = ${orgId} and store_id = ${storeId} and is_active = true
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

/**
 * ⭐ T-222 readiness input, and the sharpest one (spec §5). A PIN credential belongs to a
 * **(person, store) pair** — `setPin` hashes with `pinLookupHash(storeId, pin)` — so a brand-new
 * store has ZERO credentials while the sign-in page happily lists it. The first person to try
 * reports *"my PIN stopped working"*, the least informative possible symptom of a correct system.
 *
 * ⛔ Store creation does NOT auto-issue one: a credential is a security decision, and a
 * generated-and-displayed default PIN is the kind of convenience that ends up in a screenshot.
 */
export async function countActiveCredentials(tx: Tx, storeId: string): Promise<number> {
  const [row] = (await tx.execute(sql`
    select count(*)::int as n from person_credentials
    where store_id = ${storeId} and kind = 'pin' and revoked_at is null
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}
