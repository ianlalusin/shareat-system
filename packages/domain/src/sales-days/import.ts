/**
 * T-375 S3 (R5) - `importSalesDay`: the only way a store LINKED to POS gets, or changes, a sales day.
 * `docs/tasks/375-pos-v1-day-feed.md` S3.
 *
 * Order (the order is the design):
 *   1. `authorize('submit_sales_day')` - before any read, fetch or business refusal (I1);
 *   2. the store's link (unlinked refuses) and tenders;
 *   3. the day-state gate, with no lock yet: a verified day refuses, a submitted day needs `verify_sales_day`, a
 *      new date goes through the create-block (a voided date through `void_sales_day`) - all BEFORE POS is called;
 *   4. **fetch both kinds over HTTP holding no row lock** (T-373 R2, I4);
 *   5. derive (pure) - a refusal here writes nothing (I5), then re-check each wallet's money account is ACTIVE;
 *   6. lock the live day `FOR UPDATE` if there is one and re-check its state, then either insert the day (source
 *      `pos_v1_day_feed`) or replace its figures, remitted channel row and tender rows - every figure, channel and
 *      tender write inside `withSalesDayDerivation` (R6).
 *
 * The prior-7-days recheck is NOT part of this function (R10): the server action calls it AFTER this commits.
 */
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { auditLogRepo, moneyAccountsRepo, posV1Repo, salesDaysRepo, storesRepo, transaction, type Tx } from '@shareat/db';
import type { PosV1FeedKind } from '@shareat/db/schema';
import { parseBusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { gone, refuse } from '../shared/refusal';
import {
  fetchPosV1Day,
  PosNotConfiguredError,
  PosUnreachableError,
  type FetchPosV1Day,
  type PosV1DayFetcher,
} from '../pos/v1-feed';
import { deriveSalesDay, POS_V1_VAT_EXCLUSIVE_SENTENCE } from '../pos/v1-derive';
import { assertCanOpenDay, safeHumanDate } from './create-block';

/** The two fetchers an import calls, injectable so a test never needs a live POS. Live by default. */
export interface ImportFetchers {
  readonly sales: PosV1DayFetcher;
  readonly soldItems: PosV1DayFetcher;
}

const LIVE_FETCHERS: ImportFetchers = { sales: fetchPosV1Day, soldItems: fetchPosV1Day };

export interface ImportSalesDayInput {
  readonly storeId: string;
  /** A Manila business date, `YYYY-MM-DD`. */
  readonly businessDate: string;
}

export async function importSalesDay(
  tx: Tx | null,
  actor: Actor,
  input: ImportSalesDayInput,
  fetchers: ImportFetchers = LIVE_FETCHERS,
): Promise<{ id: string }> {
  if (tx) return runImport(tx, actor, input, fetchers);
  return transaction((trx) => runImport(trx, actor, input, fetchers));
}

const DAY_OUT_OF_REACH = 'That sales day does not exist, or it is not at a store where you may import.';

/**
 * Re-import of an existing day (the day page's button): the store and the date are the day's own. A day that does
 * not exist is answered exactly like a day the actor may not act on (an AuthorizationError), so the answer is no
 * oracle for which days exist.
 */
export async function reimportSalesDay(
  tx: Tx | null,
  actor: Actor,
  input: { readonly salesDayId: string },
  fetchers: ImportFetchers = LIVE_FETCHERS,
): Promise<{ id: string }> {
  if (!tx) return transaction((trx) => reimportSalesDay(trx, actor, input, fetchers));
  const day = await salesDaysRepo.getById(tx, actor.orgId, input.salesDayId);
  if (!day) {
    const raw = 'reimportSalesDay: no such sales day in this org';
    logger.warn({ salesDayId: input.salesDayId, actorOrgId: actor.orgId }, raw);
    throw new AuthorizationError(raw, 'submit_sales_day', DAY_OUT_OF_REACH);
  }
  // A denied actor gets the very same sentence as a missing day (DEF-546's pattern).
  try {
    return await runImport(tx, actor, { storeId: day.storeId, businessDate: day.businessDate }, fetchers);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      const uniform = new AuthorizationError(`reimportSalesDay: ${err.message}`, 'submit_sales_day', DAY_OUT_OF_REACH);
      uniform.cause = err;
      throw uniform;
    }
    throw err;
  }
}

type Day = NonNullable<Awaited<ReturnType<typeof salesDaysRepo.getById>>>;

/** What a day that already exists on the date allows. Used before the fetch (no lock) and again under the lock. */
async function gateExistingDay(tx: Tx, actor: Actor, input: ImportSalesDayInput, day: Day): Promise<void> {
  const when = safeHumanDate(input.businessDate);
  if (day.status === 'verified') {
    throw refuse(
      `importSalesDay: sales day ${day.id} is verified`,
      `${when} is already verified. If POS changed since, it shows under Findings and is corrected there.`,
    );
  }
  if (day.source === 'legacy_typed') {
    // Unreachable in practice (a store cannot be linked while it has such a day, W6): defensive.
    throw refuse(
      `importSalesDay: sales day ${day.id} was typed in before store ${input.storeId} was linked`,
      'This day was typed in before the store was linked to POS. Ask the office.',
    );
  }
  // Re-importing a SUBMITTED day is the verifier's act, as `editSalesDay` (edit.ts).
  if (day.status === 'submitted') await authorize(tx, actor, 'verify_sales_day', { storeId: input.storeId });
}

async function fetchBoth(
  fetchers: ImportFetchers,
  posStoreId: string,
  businessDate: string,
  when: string,
): Promise<{ sales: FetchPosV1Day; soldItems: FetchPosV1Day }> {
  const call = (f: PosV1DayFetcher, kind: PosV1FeedKind) => f({ posStoreId, businessDate, kind });
  try {
    const sales = await call(fetchers.sales, 'sales');
    const soldItems = await call(fetchers.soldItems, 'sold_items');
    return { sales, soldItems };
  } catch (err) {
    if (err instanceof PosNotConfiguredError) {
      throw refuse(err.message, "The POS connection isn't set up on this server, so sales can't be imported.");
    }
    if (err instanceof PosUnreachableError) {
      throw refuse(err.message, `POS couldn't be reached, so ${when} wasn't imported. Try again later — sales only come from POS.`);
    }
    throw err;
  }
}

async function runImport(tx: Tx, actor: Actor, input: ImportSalesDayInput, fetchers: ImportFetchers): Promise<{ id: string }> {
  const { orgId } = actor;
  await authorize(tx, actor, 'submit_sales_day', { storeId: input.storeId });
  // Strict: a real calendar date, before any read or fetch.
  try {
    parseBusinessDate(input.businessDate);
  } catch {
    throw refuse(`importSalesDay: invalid business date ${JSON.stringify(input.businessDate)}`, "That isn't a valid date. Use YYYY-MM-DD.");
  }

  const store = await storesRepo.getById(tx, orgId, input.storeId);
  if (!store) throw gone(`importSalesDay: store ${input.storeId} does not exist in org ${orgId}`, 'store');
  const link = await posV1Repo.getLinkByStore(tx, orgId, input.storeId);
  if (!link) {
    throw refuse(
      `importSalesDay: store ${input.storeId} has no POS link`,
      `${store.name} isn't linked to a POS store yet, so its sales can't be imported. An admin links it under Settings › POS link.`,
    );
  }
  if (link.posTaxType === 'vat_exclusive') {
    // Derivation refuses it too (D2c); asked here as well so POS is not called for a day that cannot import.
    throw refuse(`importSalesDay: store ${input.storeId} is linked vat_exclusive`, POS_V1_VAT_EXCLUSIVE_SENTENCE);
  }
  const tenders = await posV1Repo.listTendersByStore(tx, orgId, input.storeId);
  const when = safeHumanDate(input.businessDate);

  // The day-state gate, before POS is called and with no lock held.
  const peek = await salesDaysRepo.findByBusinessDate(tx, orgId, input.storeId, input.businessDate);
  if (peek) await gateExistingDay(tx, actor, input, peek);
  else await assertCanOpenDay(tx, actor, input, 'importSalesDay');

  // The fetch: no row lock is held across HTTP (T-373 R2). Both kinds, captured together (R1).
  const fetched = await fetchBoth(fetchers, link.posStoreId, input.businessDate, when);
  // One instant, taken as the responses arrive: the feed rows' `fetched_at` and the day's `pos_sourced_at`.
  const fetchedAt = new Date();

  const derived = deriveSalesDay(fetched.sales.payload, {
    channelId: link.salesChannelId,
    taxType: link.posTaxType,
    tenders,
    businessDate: input.businessDate,
    storeName: store.name,
  });
  if (!derived.ok) throw refuse(derived.raw, derived.sentence);

  // S2 audit: the resolver is pure, so a wallet whose money account was retired since the tender was set up is
  // caught here, by the tender's name.
  for (const t of derived.tenders) {
    const account = await moneyAccountsRepo.getById(tx, orgId, t.moneyAccountId);
    if (!account || !account.isActive) {
      const name = tenders.find((x) => x.moneyAccountId === t.moneyAccountId)?.name ?? 'A wallet tender';
      throw refuse(
        `importSalesDay: money account ${t.moneyAccountId} of tender "${name}" is retired or missing`,
        `${name}'s money account is no longer active, so ${when} can't be imported. An admin sets ${name}'s account under Settings › POS link.`,
      );
    }
  }

  // Lock the live day, then decide what this import is.
  const live = await salesDaysRepo.findByBusinessDate(tx, orgId, input.storeId, input.businessDate);
  const day = live ? await salesDaysRepo.getByIdForUpdate(tx, orgId, live.id) : undefined;
  const liveDay = day && day.status !== 'voided' ? day : undefined;
  if (liveDay) await gateExistingDay(tx, actor, input, liveDay);
  else if (peek) await assertCanOpenDay(tx, actor, input, 'importSalesDay'); // the day we gated on is gone: gate as new

  const batch = await posV1Repo.insertBatch(tx, {
    orgId,
    storeId: input.storeId,
    businessDate: input.businessDate,
    purpose: 'import',
    posStoreId: link.posStoreId,
    fetchedBy: actor.personId,
    fetchedAt,
    rows: [
      { kind: 'sales', body: fetched.sales.body, payload: fetched.sales.payload },
      { kind: 'sold_items', body: fetched.soldItems.body, payload: fetched.soldItems.payload },
    ],
  });
  const salesFeedId = batch.ids.sales!;

  const f = derived.figures;
  const channelRows = [{ channelId: derived.channel.channelId, amount: derived.channel.amount, noSales: false }];
  const tenderRows = derived.tenders.map((t) => ({ moneyAccountId: t.moneyAccountId, amount: t.amount }));

  if (!liveDay) {
    const id = await salesDaysRepo.withSalesDayDerivation(tx, async () => {
      const { id: newId } = await salesDaysRepo.insertSalesDay(tx, {
        orgId,
        storeId: input.storeId,
        businessDate: input.businessDate,
        source: 'pos_v1_day_feed',
        posV1DayFeedId: salesFeedId,
        posSourced: true,
        posSourcedAt: fetchedAt,
        totalSales: f.totalSales,
        unliSales: f.unliSales,
        alaCarteSales: f.alaCarteSales,
        seniorDiscount: f.seniorDiscount,
        pwdDiscount: f.pwdDiscount,
        otherDiscount: f.otherDiscount,
        comps: f.comps,
        serviceCharge: f.serviceCharge,
        otherCharges: f.otherCharges,
        cashCollected: f.cashCollected,
        onlineCollected: f.onlineCollected,
        creditSales: f.creditSales,
        refunds: f.refunds,
        createdBy: actor.personId,
      });
      await salesDaysRepo.replaceRemittedChannels(tx, orgId, newId, channelRows);
      await salesDaysRepo.replaceTenders(tx, newId, tenderRows);
      return newId;
    });
    return { id };
  }

  // Re-import of an open or submitted feed day: the figures, the REMITTED channel row and the tender rows follow
  // POS; status, sign-off and the platform rows stay.
  const before = await snapshot(tx, liveDay);
  await salesDaysRepo.withSalesDayDerivation(tx, async () => {
    await salesDaysRepo.updateDerivedFigures(tx, orgId, liveDay.id, {
      posV1DayFeedId: salesFeedId,
      posSourcedAt: fetchedAt,
      totalSales: f.totalSales,
      unliSales: f.unliSales,
      alaCarteSales: f.alaCarteSales,
      seniorDiscount: f.seniorDiscount,
      pwdDiscount: f.pwdDiscount,
      otherDiscount: f.otherDiscount,
      comps: f.comps,
      serviceCharge: f.serviceCharge,
      otherCharges: f.otherCharges,
      cashCollected: f.cashCollected,
      onlineCollected: f.onlineCollected,
      creditSales: f.creditSales,
      refunds: f.refunds,
    });
    await salesDaysRepo.replaceRemittedChannels(tx, orgId, liveDay.id, channelRows);
    await salesDaysRepo.replaceTenders(tx, liveDay.id, tenderRows);
  });
  const refreshed = await salesDaysRepo.getById(tx, orgId, liveDay.id);
  const after = await snapshot(tx, refreshed ?? liveDay);
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'reimport_sales_day',
    entity: 'sales_days',
    entityId: liveDay.id,
    before,
    after,
    // The ERP screen is this function's only caller today (the `editSalesDay` precedent).
    source: 'web',
  });
  return { id: liveDay.id };
}

/** The figures, their feed, the channels and the tenders, for the re-import's audit row. */
async function snapshot(tx: Tx, day: Day): Promise<Record<string, unknown>> {
  const channels = await salesDaysRepo.getChannelsForDay(tx, day.id);
  const tenders = await salesDaysRepo.getTendersForDay(tx, day.id);
  return {
    status: day.status,
    posV1DayFeedId: day.posV1DayFeedId,
    totalSales: day.totalSales,
    unliSales: day.unliSales,
    alaCarteSales: day.alaCarteSales,
    otherDiscount: day.otherDiscount,
    otherCharges: day.otherCharges,
    cashCollected: day.cashCollected,
    onlineCollected: day.onlineCollected,
    refunds: day.refunds,
    channels: channels.map((c) => ({ channelId: c.channelId, amount: c.amount, noSales: c.noSales })),
    tenders: tenders.map((t) => ({ moneyAccountId: t.moneyAccountId, amount: t.amount })),
  };
}
