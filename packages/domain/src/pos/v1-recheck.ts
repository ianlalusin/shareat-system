/**
 * T-375 S6 (R10) - rechecks: store what POS says NOW about a day already imported, so a change after verify is a
 * finding (`posDayFeedDrift`, `posDaySoldItemsDrift`) and not a surprise. `docs/tasks/375-pos-v1-day-feed.md` S6.
 *
 * Neither function takes a `tx`. Each is: one short transaction to authorize and read, then the fetches with NOTHING
 * open (I4, T-373 R2), then one short transaction that writes the batch. A batch holds BOTH kinds (`purpose =
 * 'recheck'`) and is written with the day locked `FOR UPDATE`, exactly as the import writes its feed rows
 * (`import.ts`): usage's serialization relies on every feed insert taking the day lock, or a feed could commit
 * between usage's read of the latest items and its post, unseen (S5-lite audit).
 *
 * POS is called with the BASIS feed's stored `pos_store_id` (W9), never the link's current one, so relinking a store
 * never redirects an old day. An OPEN or SUBMITTED day may be rechecked too: it stores a batch and no finding results
 * (an unverified day re-imports).
 */
import { authorize, type Actor } from '@shareat/auth';
import { posV1Repo, salesDaysRepo, storesRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import type { PosV1FeedKind } from '@shareat/db/schema';
import { logger } from '@shareat/core/logger';
import { isZero, money } from '@shareat/core/money';
import { POS_V1_SALES_FIELDS } from '@shareat/db/pos-v1/wire';
import { gone, refuse } from '../shared/refusal';
import { fetchPosV1Day, type PosV1DayFetcher } from './v1-feed';

/** The two fetchers a recheck calls, injectable so a test never needs a live POS. Live by default. */
export interface RecheckFetchers {
  readonly sales: PosV1DayFetcher;
  readonly soldItems: PosV1DayFetcher;
}

const LIVE_FETCHERS: RecheckFetchers = { sales: fetchPosV1Day, soldItems: fetchPosV1Day };

/** How far back the automatic recheck looks (R10): the 7 days before the day just imported. */
export const RECHECK_RECENT_DAYS = 7;

export interface RecheckResult {
  readonly salesDayId: string;
  /** null when nothing was stored (POS answered "no data" for a verified day that has sales; logged). */
  readonly batchId: string | null;
}

/**
 * T-382 R9a (REV-2): true when the store has no live link, or the basis feed names another POS store than the live
 * link, or the basis was fetched before the link's last relink (`updatedAt`; NULL on a link never relinked).
 */
async function importedUnderEarlierLink(
  tx: Tx,
  orgId: string,
  storeId: string,
  basis: { readonly posStoreId: string; readonly fetchedAt: Date },
): Promise<boolean> {
  const link = await posV1Repo.getLinkByStore(tx, orgId, storeId);
  if (!link) return true;
  if (basis.posStoreId !== link.posStoreId) return true;
  return link.updatedAt !== null && basis.fetchedAt.getTime() < link.updatedAt.getTime();
}

/** The Check POS again button: the verifier's act. */
export async function recheckPosDay(
  actor: Actor,
  input: { readonly salesDayId: string },
  fetchers: RecheckFetchers = LIVE_FETCHERS,
): Promise<RecheckResult> {
  return runRecheck(actor, input, fetchers, 'verify_sales_day');
}

async function runRecheck(
  actor: Actor,
  input: { readonly salesDayId: string },
  fetchers: RecheckFetchers,
  capability: 'verify_sales_day' | 'submit_sales_day',
): Promise<RecheckResult> {
  const { orgId } = actor;

  // 1. authorize and read.
  const target = await withOrgPrincipal(orgId, async (tx) => {
    const day = await salesDaysRepo.getById(tx, orgId, input.salesDayId);
    if (!day) throw gone(`recheckPosDay: sales day ${input.salesDayId} does not exist in org ${orgId}`, 'sales day');
    await authorize(tx, actor, capability, { storeId: day.storeId });
    if (day.source !== 'pos_v1_day_feed' || day.status === 'voided') {
      throw refuse(
        `recheckPosDay: sales day ${day.id} is ${day.status}/${day.source}`,
        'Only a day that came from POS, and has not been voided, can be checked against POS.',
      );
    }
    const basis = await posV1Repo.basisFor(tx, orgId, day.id);
    if (!basis) throw gone(`recheckPosDay: feed day ${day.id} has no basis feed`, 'POS record for this day');
    // T-382 R9a: no recheck of a day imported under an earlier link (or with no live link at all).
    if (await importedUnderEarlierLink(tx, orgId, day.storeId, basis)) {
      const store = await storesRepo.getById(tx, orgId, day.storeId);
      throw refuse(
        `recheckPosDay: day ${day.id} was imported under an earlier link of store ${day.storeId}`,
        `${store?.name ?? 'This store'} isn't linked to a POS store, so its POS figures can't be read.`,
      );
    }
    return {
      storeId: day.storeId,
      businessDate: day.businessDate,
      posStoreId: basis.posStoreId,
      hasSales: day.status === 'verified' && !isZero(money(day.totalSales)),
    };
  });

  // 2. fetch both kinds, holding no transaction and no lock.
  const call = (f: PosV1DayFetcher, kind: PosV1FeedKind) => f({ posStoreId: target.posStoreId, businessDate: target.businessDate, kind });
  const sales = await call(fetchers.sales, 'sales');
  const soldItems = await call(fetchers.soldItems, 'sold_items');
  const fetchedAt = new Date();

  // POS answering "no data" for a VERIFIED day that has sales is a POS glitch, not a change: storing it would make
  // "latest check" read as not found. Nothing is stored; the warning names the date.
  const salesBody = sales.payload as Record<string, unknown> | null;
  if (target.hasSales && (typeof salesBody !== 'object' || salesBody === null || salesBody[POS_V1_SALES_FIELDS.found] !== true)) {
    logger.warn(
      { salesDayId: input.salesDayId, businessDate: target.businessDate },
      `recheck of POS day ${target.businessDate} not stored: POS reported no sales data for a verified day that has sales`,
    );
    return { salesDayId: input.salesDayId, batchId: null };
  }

  // 3. write the batch under the day lock.
  return withOrgPrincipal(orgId, async (tx) => {
    const day = await salesDaysRepo.getByIdForUpdate(tx, orgId, input.salesDayId);
    if (!day || day.status === 'voided') {
      throw refuse(`recheckPosDay: sales day ${input.salesDayId} was voided or removed while POS was asked`, 'That day was voided while POS was being checked.');
    }
    const batch = await posV1Repo.insertBatch(tx, {
      orgId,
      storeId: target.storeId,
      businessDate: target.businessDate,
      purpose: 'recheck',
      posStoreId: target.posStoreId,
      fetchedBy: actor.personId,
      fetchedAt,
      rows: [
        { kind: 'sales', body: sales.body, payload: sales.payload },
        { kind: 'sold_items', body: soldItems.body, payload: soldItems.payload },
      ],
    });
    return { salesDayId: input.salesDayId, batchId: batch.batchId };
  });
}

export interface RecheckRecentResult {
  readonly rechecked: string[];
  readonly failed: { readonly businessDate: string; readonly salesDayId: string }[];
}

/**
 * The store's verified feed days in the 7 days before `beforeDate`, each rechecked. Called by the import's server
 * action AFTER the import has committed. A failure on one day is logged (naming the date and the day) and never
 * reaches the caller; the other days are still checked. It runs under `submit_sales_day`,
 * the capability the import itself needs (it stores feeds and posts nothing), so a cashier's import rechecks too.
 */
export async function recheckRecentDays(
  actor: Actor,
  storeId: string,
  beforeDate: string,
  fetchers: RecheckFetchers = LIVE_FETCHERS,
): Promise<RecheckRecentResult> {
  const result: RecheckRecentResult = { rechecked: [], failed: [] };
  let days: { id: string; businessDate: string }[];
  // Authorize, then read. Under the capability the import itself needs (it stores feeds and posts nothing), so a
  // cashier's import rechecks too.
  days = await withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'submit_sales_day', { storeId });
    const candidates = await posV1Repo.verifiedFeedDaysBefore(tx, actor.orgId, storeId, beforeDate, RECHECK_RECENT_DAYS);
    // T-382 R9a: a day imported under an earlier link is skipped (not rechecked, no failure logged).
    const keep: typeof candidates = [];
    for (const d of candidates) {
      const basis = await posV1Repo.basisFor(tx, actor.orgId, d.id);
      if (basis && !(await importedUnderEarlierLink(tx, actor.orgId, storeId, basis))) keep.push(d);
      else if (!basis) keep.push(d); // runRecheck reports the missing basis as it always did
    }
    return keep;
  });
  // Concurrently (at most 7 days): a slow POS costs one day's two fetches, not fourteen in a row. Each day runs its own
  // authorize-read, fetch and write transaction, and the write locks only that day's own row (no cross-day lock, so no
  // deadlock).
  const settled = await Promise.allSettled(
    days.map((d) => runRecheck(actor, { salesDayId: d.id }, fetchers, 'submit_sales_day')),
  );
  settled.forEach((o, i) => {
    const d = days[i]!;
    if (o.status === 'fulfilled') {
      result.rechecked.push(d.businessDate);
      return;
    }
    result.failed.push({ businessDate: d.businessDate, salesDayId: d.id });
    logger.warn(
      { salesDayId: d.id, businessDate: d.businessDate, err: o.reason instanceof Error ? o.reason.message : String(o.reason) },
      `recheck of POS day ${d.businessDate} failed (sales day ${d.id})`,
    );
  });
  return result;
}
