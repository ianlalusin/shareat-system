/**
 * T-533 S1 - the SQL behind the store POS mode switch (`packages/domain/src/pos/store-mode.ts`). docs/tasks/533-pos-lipa-switch.md R1.
 * The domain decides every rule; these only read and write. Every function takes the caller's transaction first and filters by org AND store; RLS is the backstop.
 * `pos_stores` grants UPDATE on mode, live_from, state_version, changed_by and changed_at only (migration 0238), which is exactly the set `setMode` writes.
 */
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { posStores, type PosStoreRow } from '../../schema/pos-v2';
import { salesDays } from '../../schema/sales-days';
import type { Tx } from '../client';

/** The store's switch row, locked FOR UPDATE until the transaction ends, or undefined when the store has none. */
export async function getForUpdate(tx: Tx, orgId: string, storeId: string): Promise<PosStoreRow | undefined> {
  const [row] = await tx
    .select()
    .from(posStores)
    .where(and(eq(posStores.orgId, orgId), eq(posStores.storeId, storeId)))
    .for('update');
  return row;
}

/** Create the store's switch row (mode `off`, state_version 0) unless one exists: a race for the first-ever row never raises a unique-key error. Returns the row and whether this call made it. */
export async function ensureOffRow(tx: Tx, input: { orgId: string; storeId: string; changedBy: string }): Promise<{ row: PosStoreRow; created: boolean }> {
  const [made] = await tx.insert(posStores).values({ ...input, mode: 'off', liveFrom: null }).onConflictDoNothing().returning();
  if (made) return { row: made, created: true };
  return { row: (await getForUpdate(tx, input.orgId, input.storeId))!, created: false };
}

/** Set the mode and live date (null unless live) and bump state_version in the same statement. Returns the new state_version. */
export async function setMode(
  tx: Tx,
  orgId: string,
  storeId: string,
  set: { mode: 'off' | 'test' | 'live'; liveFrom: string | null; changedBy: string },
): Promise<number> {
  const [row] = await tx
    .update(posStores)
    .set({ mode: set.mode, liveFrom: set.liveFrom, changedBy: set.changedBy, changedAt: sql`now()`, stateVersion: sql`${posStores.stateVersion} + 1` })
    .where(and(eq(posStores.orgId, orgId), eq(posStores.storeId, storeId)))
    .returning({ v: posStores.stateVersion });
  return row!.v;
}

/** The earliest business date on or after `date` that has a sales day of this store in any source and any status except voided, or undefined. */
export async function firstLiveSalesDayOnOrAfter(tx: Tx, orgId: string, storeId: string, date: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ d: sql<string | null>`min(${salesDays.businessDate})::text` })
    .from(salesDays)
    .where(and(eq(salesDays.orgId, orgId), eq(salesDays.storeId, storeId), gte(salesDays.businessDate, date), ne(salesDays.status, 'voided')));
  return row?.d ?? undefined;
}
