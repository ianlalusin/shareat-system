/**
 * Server-only helpers for the inventory screens — the Phase 3 wave's first surface.
 *
 * ⚠️ **Sixteen tasks (T-160 to T-175) shipped before any of this existed.** The engine is tested
 * to 1,430 integration assertions and had never been looked at. These helpers only read; every
 * rule they surface lives in `packages/domain` and is enforced there.
 */
import { asc, eq, inArray, sql as dsql } from 'drizzle-orm';
import {
  schema,
  stockLayersRepo,
  stockLedgerRepo,
  transaction,
  type Tx,
} from '@shareat/db';

export { listStores } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface OnHandRow {
  itemId: string;
  code: string;
  name: string;
  baseUnit: string;
  quantity: string;
  /** Σ (remaining × unit cost) from the FIFO layers. `null` when the item has no open layer. */
  value: string | null;
  byLocation: { locationName: string; quantity: string }[];
}

export interface StockSummary {
  rows: OnHandRow[];
  /** Σ open layer value for the store — the subledger side of the Phase 3 gate. */
  layerValue: string;
  /** Σ 1310 + 1320 + 1330 for the store — the control side. */
  accountValue: string;
  /** ⭐ Goods on a truck. In NO layer, on purpose, so it is shown apart rather than netted in. */
  inTransitValue: string;
}

/**
 * ⭐ **The Phase 3 exit gate, rendered.** Bible invariant 6 asks that the inventory control
 * accounts equal the subledger, *"checked continuously, not at year end."* Until this page there
 * was nowhere a person could see it — it existed only inside test assertions.
 *
 * ⚠️ `1340` is deliberately NOT part of the comparison. Goods in transit are in no FIFO layer,
 * because a layer is a thing on a shelf; DEF-098 is what happens when the two are conflated. It is
 * shown as its own figure and reconciles against the open transit shortfalls instead.
 */
export async function stockSummary(orgId: string, storeId: string): Promise<StockSummary> {
  return transaction(async (tx) => {
    const [byLoc, valued, accounts] = await Promise.all([
      stockLedgerRepo.onHandByStore(tx, storeId),
      stockLayersRepo.valuation(tx, storeId),
      controlAccountTotals(tx, orgId, storeId),
    ]);

    const itemIds = [...new Set(byLoc.map((r) => r.itemId))];
    const [items, locations] = await Promise.all([
      itemIds.length
        ? tx
            .select({
              id: schema.items.id,
              code: schema.items.code,
              name: schema.items.name,
              baseUnit: schema.items.baseUnit,
            })
            .from(schema.items)
            .where(inArray(schema.items.id, itemIds))
            .orderBy(asc(schema.items.name))
        : Promise.resolve([]),
      tx
        .select({ id: schema.stockLocations.id, name: schema.stockLocations.name })
        .from(schema.stockLocations)
        .where(eq(schema.stockLocations.storeId, storeId)),
    ]);

    const locName = new Map(locations.map((l) => [l.id, l.name]));
    const valueByItem = new Map(valued.map((v) => [v.itemId, v.value]));
    const grouped = new Map<string, { locationName: string; quantity: string }[]>();
    const totalByItem = new Map<string, number>();

    for (const row of byLoc) {
      const list = grouped.get(row.itemId) ?? [];
      list.push({ locationName: locName.get(row.locationId) ?? 'Unknown room', quantity: row.quantity });
      grouped.set(row.itemId, list);
      totalByItem.set(row.itemId, (totalByItem.get(row.itemId) ?? 0) + Number(row.quantity));
    }

    const rows: OnHandRow[] = items.map((item) => ({
      itemId: item.id,
      code: item.code,
      name: item.name,
      baseUnit: item.baseUnit,
      quantity: (totalByItem.get(item.id) ?? 0).toFixed(3),
      value: valueByItem.get(item.id) ?? null,
      byLocation: (grouped.get(item.id) ?? []).sort((a, b) => a.locationName.localeCompare(b.locationName)),
    }));

    const layerValue = valued.reduce((n, v) => n + Number(v.value), 0).toFixed(2);
    return {
      rows,
      layerValue,
      accountValue: accounts.shelves,
      inTransitValue: accounts.inTransit,
    };
  });
}

async function controlAccountTotals(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<{ shelves: string; inTransit: string }> {
  const rows = (await tx.execute(dsql`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l
    join accounts a on a.id = l.account_id
    where a.org_id = ${orgId} and l.store_id = ${storeId}
      and a.code in ('1310','1320','1330','1340')
    group by a.code
  `)) as unknown as { code: string; net: string }[];

  let shelves = 0;
  let inTransit = 0;
  for (const r of rows) {
    if (r.code === '1340') inTransit += Number(r.net);
    else shelves += Number(r.net);
  }
  return { shelves: shelves.toFixed(2), inTransit: inTransit.toFixed(2) };
}
