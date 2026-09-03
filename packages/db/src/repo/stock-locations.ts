import { and, asc, eq } from 'drizzle-orm';
import { stockLocations } from '../../schema/stock-locations';
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
