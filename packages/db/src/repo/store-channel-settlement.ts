/**
 * Store channel-settlement config reads and writes. T-564 (T-515 re-applied on main).
 *
 * One row per store. The domain owns uniqueness wording and the immutable store key; this file
 * owns SQL only, like every other repo.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { storeChannelSettlementConfigs } from '../../schema/store-channel-settlement';

export interface StoreChannelSettlementConfigRow {
  id: string;
  orgId: string;
  storeId: string;
  storeKey: string;
  matchLabels: string[];
  fileHints: string[];
  wastageEmailIngestEnabled: boolean;
}

const COLUMNS = {
  id: storeChannelSettlementConfigs.id,
  orgId: storeChannelSettlementConfigs.orgId,
  storeId: storeChannelSettlementConfigs.storeId,
  storeKey: storeChannelSettlementConfigs.storeKey,
  matchLabels: storeChannelSettlementConfigs.matchLabels,
  fileHints: storeChannelSettlementConfigs.fileHints,
  wastageEmailIngestEnabled: storeChannelSettlementConfigs.wastageEmailIngestEnabled,
} as const;

export async function getConfigByStore(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<StoreChannelSettlementConfigRow | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(storeChannelSettlementConfigs)
    .where(and(eq(storeChannelSettlementConfigs.orgId, orgId), eq(storeChannelSettlementConfigs.storeId, storeId)))
    .limit(1);
  return row ?? null;
}

export async function listConfigs(tx: Tx, orgId: string): Promise<StoreChannelSettlementConfigRow[]> {
  return tx.select(COLUMNS).from(storeChannelSettlementConfigs).where(eq(storeChannelSettlementConfigs.orgId, orgId));
}

/** Upsert by (org_id, store_id). The unique (org_id, store_key) index is the authority on a clashing key; `store_key` is never updated. */
export async function upsertConfig(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    storeKey: string;
    matchLabels: string[];
    fileHints: string[];
    wastageEmailIngestEnabled: boolean;
  },
): Promise<void> {
  await tx
    .insert(storeChannelSettlementConfigs)
    .values(input)
    .onConflictDoUpdate({
      target: [storeChannelSettlementConfigs.orgId, storeChannelSettlementConfigs.storeId],
      set: {
        matchLabels: input.matchLabels,
        fileHints: input.fileHints,
        wastageEmailIngestEnabled: input.wastageEmailIngestEnabled,
        updatedAt: sql`now()`,
      },
    });
}
