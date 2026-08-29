/**
 * The only place SQL is written for stores. T-152.
 *
 * ⚠️ **Small on purpose.** Store *identity* is read through Drizzle in the app helpers today; what
 * lives here is the **cash-custody policy** (bible row 129), because it is a money control and
 * changing it changes how much cash may sit in a drawer.
 */
import { and, eq } from 'drizzle-orm';
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
