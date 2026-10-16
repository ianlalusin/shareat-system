/**
 * T-419 - the ingredients recipe cooking used on a day, for the daily usage screen. DISPLAY ONLY: nothing here writes, and nothing
 * that judges or posts usage reads it (T-420 later lets the check count POSTED cooking). A draft cook is listed but never moved stock.
 */
import { authorize, type Actor } from '@shareat/auth';
import { productionRepo, type Tx } from '@shareat/db';

export interface CookUsageLine {
  readonly recordId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly unit: string;
  readonly recipeName: string;
  readonly isDraft: boolean;
}

/** Anyone who may record usage at the store may read it (same gate as `listUsageVariances`). */
export async function listCookUsageForDay(
  tx: Tx,
  actor: Actor,
  input: { readonly storeId: string; readonly date: string },
): Promise<CookUsageLine[]> {
  await authorize(tx, actor, 'record_stock_movement', { storeId: input.storeId });
  const rows = await productionRepo.listCookInputsForDay(tx, actor.orgId, input.storeId, input.date);
  return rows.map((r) => ({
    recordId: r.recordId, itemId: r.itemId, itemName: r.itemName, quantity: r.quantity, unit: r.unit,
    recipeName: r.recipeName, isDraft: r.status === 'draft',
  }));
}
