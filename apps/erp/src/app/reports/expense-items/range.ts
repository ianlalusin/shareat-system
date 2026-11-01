import { inArray } from 'drizzle-orm';
import { schema, type Tx } from '@shareat/db';
import type { ExpenseItemsReport } from '@shareat/domain';
import { parseBusinessDate } from '@shareat/core/datetime';

/** A real calendar date written YYYY-MM-DD. */
export function isRealDate(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  try {
    parseBusinessDate(v);
    return true;
  } catch {
    return false;
  }
}

/** from/to from the URL; anything invalid (or from after to) falls back to month-to-date. */
export function resolveRange(from: string | null | undefined, to: string | null | undefined, today: string): { from: string; to: string } {
  const def = { from: `${today.slice(0, 7)}-01`, to: today };
  if (!isRealDate(from) || !isRealDate(to) || from > to) return def;
  return { from, to };
}

export interface StoreCol {
  id: string;
  name: string;
}

/**
 * The store columns of the all-stores view: every store in the viewer's list, plus any store (active or retired) that holds
 * figures in the range, so the store columns add up to the row total. One column or none when only one store is in play.
 */
export async function storeColumns(tx: Tx, report: ExpenseItemsReport, stores: readonly StoreCol[]): Promise<StoreCol[]> {
  const known = new Map(stores.map((s) => [s.id, s.name]));
  const seen = new Set<string>();
  for (const g of report.groups)
    for (const c of g.categories) for (const sc of c.subcategories) for (const i of sc.items) for (const b of i.byStore) seen.add(b.storeId);
  const missing = [...seen].filter((id) => !known.has(id));
  if (missing.length > 0) {
    const rows = await tx.select({ id: schema.stores.id, name: schema.stores.name }).from(schema.stores).where(inArray(schema.stores.id, missing));
    for (const r of rows) known.set(r.id, r.name);
  }
  const ids = new Set<string>([...stores.map((s) => s.id), ...seen]);
  return [...ids].map((id) => ({ id, name: known.get(id) ?? 'Store' })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
