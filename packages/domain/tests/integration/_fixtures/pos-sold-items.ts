import type { Tx } from '@shareat/db';
import { posV1Repo } from '@shareat/db';
import { posV1SoldItemsBody, type PosV1SoldItemInput } from '../../../../db/src/pos-v1/fixtures';

/**
 * T-375 S5 (S5-lite) - test helper for a POS v1 RECHECK batch. `docs/tasks/375-pos-v1-day-feed.md` S5 TESTER list.
 *
 * A recheck batch holds BOTH kinds (V11): the `sales` body is COPIED from the day's newest stored `sales` feed (so the
 * day's money projection is unchanged and only the sold items move), and the `sold_items` body is built from
 * `soldItems`. It is written through `posV1Repo.insertBatch` with `purpose = 'recheck'`, the same door S6's recheck
 * uses, so a test never inserts a feed row by hand.
 *
 * `_fixtures/pos-day.ts` is NOT edited (S4's tester owns it); this file only reads what that one made.
 *
 * Options that exist so a test can say exactly what it needs:
 *  - `soldItemsRaw`: the `sold_items` response object, verbatim. Used to store an UNREADABLE body (a `physicalQty` of
 *    "x"), which `posV1SoldItemsBody` cannot build because it takes numbers.
 *  - `found`: passed to `posV1SoldItemsBody` (`found: false` is POS's "no data" shape, for an empty list).
 *  - `fetchedAt`: when the responses arrived. By default STRICTLY LATER than the day's newest stored `sold_items` feed
 *    (at least one millisecond after it), because "latest" is `(fetched_at desc, id desc)` and a tie would fall to a
 *    random uuid.
 *
 * Returns the ids by kind and the `fetchedAt` used.
 */
export async function insertRecheckBatch(
  tx: Tx,
  o: {
    orgId: string;
    storeId: string;
    businessDate: string;
    posStoreId: string;
    fetchedBy: string;
    soldItems?: readonly PosV1SoldItemInput[];
    soldItemsRaw?: Record<string, unknown>;
    found?: boolean;
    fetchedAt?: Date;
  },
): Promise<{ batchId: string; ids: { sales?: string; sold_items?: string }; fetchedAt: Date }> {
  const basis = await posV1Repo.latestForDay(tx, o.orgId, o.storeId, o.businessDate, 'sales');
  if (!basis) throw new Error(`insertRecheckBatch: the day ${o.businessDate} has no stored sales feed to copy`);
  const newestItems = await posV1Repo.latestForDay(tx, o.orgId, o.storeId, o.businessDate, 'sold_items');

  let fetchedAt = o.fetchedAt;
  if (!fetchedAt) {
    fetchedAt = new Date();
    const floor = Math.max(basis.fetchedAt.getTime(), newestItems?.fetchedAt.getTime() ?? 0) + 1;
    if (fetchedAt.getTime() < floor) fetchedAt = new Date(floor);
  }

  const itemsObj = o.soldItemsRaw ?? posV1SoldItemsBody(o.soldItems ?? [], o.found === undefined ? {} : { found: o.found });
  const itemsBody = JSON.stringify(itemsObj, null, 2);

  const { batchId, ids } = await posV1Repo.insertBatch(tx, {
    orgId: o.orgId,
    storeId: o.storeId,
    businessDate: o.businessDate,
    purpose: 'recheck',
    posStoreId: o.posStoreId,
    fetchedBy: o.fetchedBy,
    fetchedAt,
    rows: [
      { kind: 'sales', body: basis.body, payload: basis.payload },
      { kind: 'sold_items', body: itemsBody, payload: JSON.parse(itemsBody) as unknown },
    ],
  });
  return { batchId, ids, fetchedAt };
}
