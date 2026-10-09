/**
 * The daily POS usage pull — plan then finalize. T-177.
 *
 * ⭐ **Finalize writes T-168 usage records and posts through T-164** (invariant 5) by calling
 * `saveUsageDraft`/`postUsage` (`stock/usage-records.ts`) directly — the exact same document layer
 * a human uses, so there is one implementation of "how a usage record becomes stock movements and
 * a journal entry," never a second copy for POS-driven consumption.
 *
 * ⭐ **The server rebuilds the plan at finalize time** (invariant 2) — it does not trust the STORED
 * `pos_usage_pull_lines` rows written at plan time as the source of truth for what to write. It
 * re-reads the pinned stored `sold_items` feed (T-375 S5-lite: nothing is fetched from POS here) and
 * re-runs `plan.ts`'s pure explosion against CURRENT mappings/recipes, then
 * writes only the intersection of that fresh result and what the caller says it confirmed. A
 * confirmed key the rebuild no longer produces refuses the whole call (`PLAN_CHANGED`); a rebuilt
 * key the caller never confirmed is silently excluded, never written.
 *
 * ⭐ **T-388 (DEF-618) supersedes T-177 invariants 4 and 9 below.** A section is stamped only when NO confirmed line of it is
 * left unposted (R7). A short item, a room under count, and a room that cannot take usage are read BEFORE any write and
 * their lines HELD (named in words); every other line posts; finalizing again posts the held lines exactly once (R8).
 * The text below is the T-177 history.
 *
 * ⭐ **A frozen location refuses its lines, not the pull** (invariant 9). `stock_movements_check_-
 * not_frozen_trg` (T-169) throws when `postUsage` tries to consume against a frozen room — it does
 * NOT return `{ ok: false }` (see `usage-records.test.ts`'s own `rejects.toThrow(/frozen/)`). Lines
 * are grouped by their RESOLVED location and each group posts inside its own savepoint
 * (`tx.transaction()` — a nested Postgres transaction, per the DEF-090 lesson: a per-line try/catch
 * with no savepoint leaves the whole outer transaction aborted after the first DB-level refusal).
 * A frozen group's savepoint rolls back; every other group still commits.
 *
 * ⭐ **Finalize is section-scoped and a ONE-SHOT per (pull, section)** (invariant 4) — tracked by
 * the `*_finalized_at` columns this task adds (see `pos-mapping.ts` schema header), independent of
 * whether every individual line in that section actually posted. A line skipped for a frozen
 * location is not retried by calling finalize again; that section is done either way.
 *
 * T-377 S2 (DEF-597): when every unstamped section is empty (stored plan and fresh rebuild both), any successful
 * finalize call stamps them all, all or none. So a pull whose only non-empty section was just finalized completes.
 */
import { authorize, type Actor } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import { formatMoney, isZero, money } from '@shareat/core/money';
import {
  countSessionsRepo,
  itemsRepo,
  posMappingRepo,
  posV1Repo,
  salesDaysRepo,
  stockLayersRepo,
  stockLedgerRepo,
  stockLocationsRepo,
  storesRepo,
  type Tx,
} from '@shareat/db';
import type { PosV1FeedPurpose } from '@shareat/db/schema';
import { postUsage, saveUsageDraft } from '../stock/usage-records';
import { voidPullUsageRecord } from '../stock/void-pull-usage-record';
import { closedStockPeriodSentence } from '../stock/period-guard';
import { lockLiveSalesDay } from '../sales-days/live-day';
import { RefusalError, gone, humanDate, internalFault, refuse } from '../shared/refusal';
import { toBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { addQuantity, compareQuantity, quantity, ZERO_QUANTITY } from '../stock/quantity';
import { isFrozenBySessions } from '../stock/count-workflow';
import { assertUsageSource } from '../stock-locations/rules';
import { decideHolds, heldSentences, type HeldLine, type HoldInputLine } from './usage-holds';
import { explodePosSales, type PlanLine, type PlanSection, type PosSoldItemInput } from './plan';
import { sameItemsProjection, soldItemsFromFeed } from './v1-sold-items';

// -----------------------------------------------------------------------------------------
// The stored feed (T-375 S5-lite): usage never calls POS. The day's import (or a recheck) stored the sold items.
// -----------------------------------------------------------------------------------------
/** Invariant 3 — named with its reason, never inlined. */
export const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

async function rebuildLines(
  tx: Tx,
  orgId: string,
  storeId: string,
  defaultLocationId: string,
  posItems: readonly PosSoldItemInput[],
): Promise<PlanLine[]> {
  const maps = await posMappingRepo.listActiveMaps(tx, storeId);
  const recipeIds = [...new Set(maps.filter((m) => m.mode === 'recipe' && m.recipeId).map((m) => m.recipeId!))];
  const recipeRows = await posMappingRepo.getRecipesForExplosion(tx, orgId, recipeIds);
  const recipesById = new Map(
    recipeRows.filter((r) => r.status === 'active').map((r) => [r.id, { outputQuantity: r.outputQuantity, lines: r.lines }]),
  );
  return explodePosSales({
    posItems,
    mapsByPosItemKey: new Map(maps.map((m) => [m.posItemKey, m])),
    recipesById,
    defaultLocationId,
  });
}

/**
 * T-373 S1 (R2): lock the day first, then read. T-375 S5-lite: nothing is fetched, so the day lock (FOR SHARE) and
 * the pull lock come BEFORE the feed read, and a concurrent re-import (day FOR UPDATE) is either seen or waited for.
 * Returns the LOCKED day row (its `totalSales` is read from here, not from an earlier unlocked read). This module
 * returns Outcomes, so the refusal becomes its sentence.
 */
async function lockDayOutcome(
  tx: Tx,
  orgId: string,
  salesDayId: string,
  storeId: string,
): Promise<{ ok: false; reason: string } | { ok: true; day: { totalSales: string; source: string } }> {
  try {
    const day = await lockLiveSalesDay(tx, orgId, { salesDayId, storeId, doing: 'usage' });
    return { ok: true, day };
  } catch (err) {
    if (err instanceof RefusalError) return { ok: false, reason: err.userMessage };
    throw err;
  }
}

// -----------------------------------------------------------------------------------------
// Sentences (T-375 S5-lite, word for word)
// -----------------------------------------------------------------------------------------
const when = (businessDate: string): string => humanDate(businessDate as BusinessDate);
const SENTENCES = {
  unlinked: (store: string) => `${store} isn't linked to a POS store yet, so its usage can't be pulled. An admin links it under Settings › POS link.`,
  typed: (store: string, d: string) =>
    `${store}'s sales for ${d} were typed in before it was linked to POS, so there are no POS sold items to pull. Record that day's usage by hand under Inventory › Usage & wastage.`,
  changed: (d: string) => `POS's sold items for ${d} changed after this plan was built. Build the plan again.`,
  preS5: "This plan was built before usage read POS's stored sold items. Build the plan again.",
  partlyChanged: (d: string) => `POS's sold items for ${d} changed after part of this pull was posted. Void the pull and build the day again.`,
  partlyNoPin: "Part of this pull was posted before usage read POS's stored sold items. Void the pull and build the day again.",
  postedChanged: (name: string) =>
    `The mapping or recipe for ${name} changed after part of this section was posted. Void the pull and build the day again.`,
  noItems: (d: string, total: string) => `POS sent no sold items for ${d}, but the day has ${total} in sales, so usage can't be pulled. Tell the office.`,
  unreadable: (d: string) => `POS's stored sold items for ${d} can't be read, so usage can't be pulled. Tell the office.`,
} as const;

/** The pinned feed of a pull, which must be the sold_items feed of the pull's own store and day, else an internal fault. */
async function loadPinnedFeed(tx: Tx, orgId: string, pullId: string, feedId: string, storeId: string, businessDate: string) {
  const pinned = await posV1Repo.getFeedById(tx, orgId, feedId);
  if (!pinned || pinned.kind !== 'sold_items' || pinned.storeId !== storeId || pinned.businessDate !== businessDate) {
    throw internalFault(`usage-pull: pinned feed ${feedId} of pull ${pullId} is not this day's sold_items feed`);
  }
  return pinned;
}

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/**
 * T-382 R7 (REV-7): a typed day of a store with a LIVE link was typed before the link (`typed`); a typed day of a store
 * with no live link (never linked, or unlinked) gets the `unlinked` sentence, as before.
 */
async function typedDayRefusal(tx: Tx, orgId: string, storeId: string, businessDate: string): Promise<string> {
  const link = await posV1Repo.getLinkByStore(tx, orgId, storeId);
  const name = await storeNameOf(tx, orgId, storeId);
  return link ? SENTENCES.typed(name, when(businessDate)) : SENTENCES.unlinked(name);
}

async function storeNameOf(tx: Tx, orgId: string, storeId: string): Promise<string> {
  return (await storesRepo.getById(tx, orgId, storeId))?.name ?? 'This store';
}

/** Parse a stored feed; a refusal is logged with the feed id and the raw reason and becomes the unreadable sentence. */
function readFeed(
  feed: { id: string; payload: unknown },
  businessDate: string,
): { ok: true; found: boolean; items: PosSoldItemInput[] } | { ok: false; reason: string } {
  const parsed = soldItemsFromFeed(feed.payload);
  if (parsed.ok) return parsed;
  logger.warn({ feedId: feed.id, raw: parsed.raw }, `usage-pull: stored sold items unreadable: ${parsed.raw}`);
  return fail(SENTENCES.unreadable(when(businessDate)));
}

// -----------------------------------------------------------------------------------------
// buildPlan — read is open to anyone who can record usage (v1's own framing: "sorting a day's
// sales is the job, and a staff member has to be able to see what needs fixing before they can
// flag it"). Writing (finalize) is gated separately, manager+.
// -----------------------------------------------------------------------------------------
export interface BuildPlanInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly salesDayId: string;
  readonly locationId: string;
}

export type BuildPlanOutcome =
  | {
      readonly ok: true;
      readonly pullId: string;
      readonly lines: readonly PlanLine[];
      readonly snapshotTakenAt: Date;
      readonly soldItemsFeed: { readonly id: string; readonly fetchedAt: Date; readonly purpose: PosV1FeedPurpose };
    }
  | { readonly ok: false; readonly reason: string };

/**
 * T-374 S7 (audit 1): a rebuild of a partly finalized pull refreshes the snapshot and rewrites only the sections that
 * are NOT finalized. A finalized section's lines, and the pull -> usage-record links on them, are never touched.
 */
const finalizedSectionsOf = (p: { directFinalizedAt: Date | null; recipeFinalizedAt: Date | null; orphanFinalizedAt: Date | null }): PlanSection[] => [
  ...(p.directFinalizedAt ? (['direct'] as const) : []),
  ...(p.recipeFinalizedAt ? (['recipe'] as const) : []),
  ...(p.orphanFinalizedAt ? (['orphan'] as const) : []),
];

export async function buildPlan(tx: Tx, actor: Actor, input: BuildPlanInput): Promise<BuildPlanOutcome> {
  await authorize(tx, actor, 'record_stock_movement', { storeId: input.storeId });

  const salesDay = await salesDaysRepo.getById(tx, input.orgId, input.salesDayId);
  if (!salesDay) return { ok: false, reason: `sales day ${input.salesDayId} does not exist` };
  if (salesDay.storeId !== input.storeId) return { ok: false, reason: 'that sales day does not belong to this store' };

  // T-373 S1: refuse a voided day from the plain read (re-checked under the lock below).
  if (salesDay.status === 'voided') {
    return { ok: false, reason: `The sales day for ${humanDate(salesDay.businessDate as BusinessDate)} has been voided, so usage can't be recorded against it.` };
  }

  // T-375 S5-lite: the day's source. A typed day has no stored sold items (Q-D); none is fetched live.
  // T-382 R7: a feed day uses its STORED sold items whether or not the store is still linked (days imported before an
  // unlink stay as they are, stock usage included), so the link is no longer read for it.
  if (salesDay.source === 'legacy_typed') return fail(await typedDayRefusal(tx, input.orgId, input.storeId, salesDay.businessDate));

  const existing = await posMappingRepo.findLivePullForDay(tx, input.storeId, input.salesDayId);
  if (existing && existing.status !== 'planned') {
    return { ok: false, reason: `this day's pull is already ${existing.status} — invariant 12: only one live pull per (store, sales day)` };
  }

  // T-373 S1 R7: one date, one live pull, across a void.
  const pulledOnVoided = await posMappingRepo.findLivePullOnVoidedDayForDate(tx, input.storeId, salesDay.businessDate);
  if (pulledOnVoided) {
    return {
      ok: false,
      reason: `Stock usage for ${humanDate(salesDay.businessDate as BusinessDate)} was already pulled against the voided day, so pulling it again would count it twice.`,
    };
  }

  // T-373 S1 R1/R2: the day lock and the pull lock FIRST, then read (nothing is fetched).
  const lockedDay = await lockDayOutcome(tx, input.orgId, input.salesDayId, input.storeId);
  if (!lockedDay.ok) return lockedDay;
  // Q-D again, against the LOCKED day (the early refusal above read it unlocked).
  if (lockedDay.day.source === 'legacy_typed') return fail(await typedDayRefusal(tx, input.orgId, input.storeId, salesDay.businessDate));
  let finalizedSections: PlanSection[] = [];
  let lockedPull: NonNullable<Awaited<ReturnType<typeof posMappingRepo.getPullForUpdate>>> | undefined;
  // T-374 S7 (audit 2): the pull's own lock (same FOR UPDATE as void / finalize), then re-check under it. A void
  // that committed first leaves the pull `void`; a finalize that committed first leaves a section stamped.
  if (existing) {
    const locked = await posMappingRepo.getPullForUpdate(tx, existing.id);
    if (!locked || locked.status === 'void') {
      return { ok: false, reason: "This POS usage pull was voided, so its plan can't be rebuilt. Build the day again." };
    }
    if (locked.status !== 'planned') return { ok: false, reason: `this day's pull is already ${locked.status} — invariant 12: only one live pull per (store, sales day)` };
    finalizedSections = finalizedSectionsOf(locked);
    lockedPull = locked;
  }

  const latest = await posV1Repo.latestForDay(tx, input.orgId, input.storeId, salesDay.businessDate, 'sold_items');
  if (!latest) throw internalFault(`buildPlan: no sold_items feed for sales day ${input.salesDayId} (the import writes both kinds)`);

  // A partly finalized pull never moves its pin (S5L-R): the unfinalized sections are rebuilt from the PINNED feed.
  // T-388 R9: a pull with a POSTED line is partly finalized too, whether or not a section is stamped yet.
  let feed = latest;
  if (lockedPull && (finalizedSections.length > 0 || (await posMappingRepo.hasPostedLine(tx, lockedPull.id)))) {
    const d = when(salesDay.businessDate);
    if (!lockedPull.posV1DayFeedId) return fail(SENTENCES.partlyNoPin);
    if (lockedPull.posV1DayFeedId !== latest.id) {
      const pinned = await loadPinnedFeed(tx, input.orgId, lockedPull.id, lockedPull.posV1DayFeedId, input.storeId, salesDay.businessDate);
      const pinItems = soldItemsFromFeed(pinned.payload);
      const latestItems = soldItemsFromFeed(latest.payload);
      if (!pinItems.ok) {
        logger.warn({ feedId: pinned.id, raw: pinItems.raw }, `usage-pull: pinned sold items unreadable: ${pinItems.raw}`);
        return fail(SENTENCES.partlyChanged(d));
      }
      if (!latestItems.ok || !sameItemsProjection(latestItems.items, pinItems.items)) return fail(SENTENCES.partlyChanged(d));
      feed = pinned;
    }
  }

  const read = readFeed(feed, salesDay.businessDate);
  if (!read.ok) return read;
  // S5L-R (I5): `found: false` plans empty only on a PHP 0 day, judged from the LOCKED day row.
  if (!read.found && !isZero(money(lockedDay.day.totalSales))) {
    return fail(SENTENCES.noItems(when(salesDay.businessDate), formatMoney(money(lockedDay.day.totalSales))));
  }

  const lines = await rebuildLines(tx, input.orgId, input.storeId, input.locationId, read.items);
  const now = new Date();

  const pullId = existing
    ? await (async () => {
        await posMappingRepo.refreshPlannedPull(tx, existing.id, { locationId: input.locationId, snapshotTakenAt: now, posV1DayFeedId: feed.id });
        return existing.id;
      })()
    : (
        await posMappingRepo.insertPull(tx, {
          orgId: input.orgId,
          storeId: input.storeId,
          salesDayId: input.salesDayId,
          locationId: input.locationId,
          snapshotTakenAt: now,
          posV1DayFeedId: feed.id,
        })
      ).id;

  await posMappingRepo.replacePullLines(
    tx,
    pullId,
    lines.map((l) => ({
      section: l.section,
      lineKey: l.key,
      posItemKey: l.posItemKey,
      posItemName: l.posItemName,
      itemId: l.itemId,
      locationId: l.locationId,
      quantity: l.quantity,
      blocked: l.blocked ? { reason: l.blockReason ?? 'blocked' } : null,
    })),
    finalizedSections,
  );

  return { ok: true, pullId, lines, snapshotTakenAt: now, soldItemsFeed: { id: feed.id, fetchedAt: feed.fetchedAt, purpose: feed.purpose } };
}

// -----------------------------------------------------------------------------------------
// T-388: holds - the facts a section is judged on, and the words
// -----------------------------------------------------------------------------------------
/** The confirmed, unposted, stock-affecting lines of one section, as the pure hold decision takes them. */
function candidateLines(
  freshLines: readonly PlanLine[],
  section: 'direct' | 'recipe',
  confirmed: ReadonlySet<string>,
  postedKeys: ReadonlySet<string>,
): HoldInputLine[] {
  const out: HoldInputLine[] = [];
  for (const l of freshLines) {
    if (l.section !== section || l.blocked || !confirmed.has(l.key) || postedKeys.has(l.key)) continue;
    if (!l.itemId || !l.quantity || !l.locationId) continue;
    if (compareQuantity(quantity(l.quantity), ZERO_QUANTITY) <= 0) continue;
    out.push({ key: l.key, section, itemId: l.itemId, locationId: l.locationId, quantity: l.quantity });
  }
  return out;
}

interface HoldFacts {
  readonly onHand: Map<string, string>;
  readonly layerRemaining: Map<string, string>;
  readonly frozen: Set<string>;
  readonly unusable: Set<string>;
}

const byText = (a: string, b: string): number => a.localeCompare(b);

/**
 * R3/R4/R4a. With `lock`: the item's layers are locked first (the lock `consume()` takes), sorted by item id, then each
 * (item, room)'s movement rows (the lock transfers take) in (item, room) order. Without it (the page's `pullHolds`),
 * plain reads. A room's role, purpose, status and freeze are READ, never inferred from a thrown error.
 */
async function readHoldFacts(tx: Tx, storeId: string, lines: readonly HoldInputLine[], lock: boolean): Promise<HoldFacts> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))].sort(byText);
  const layerRemaining = new Map<string, string>();
  if (lock) {
    for (const itemId of itemIds) {
      const open = await stockLayersRepo.openLayersForUpdate(tx, itemId, storeId);
      layerRemaining.set(itemId, addQuantity(...open.map((layer) => quantity(layer.remainingQuantity))));
    }
  } else if (itemIds.length > 0) {
    const wanted = new Set(itemIds);
    for (const row of await stockLayersRepo.valuation(tx, storeId)) if (wanted.has(row.itemId)) layerRemaining.set(row.itemId, row.quantity);
  }

  const pairs = [...new Map(lines.map((l) => [`${l.itemId}|${l.locationId}`, l] as const)).values()].sort(
    (a, b) => byText(a.itemId, b.itemId) || byText(a.locationId, b.locationId),
  );
  const onHand = new Map<string, string>();
  for (const l of pairs) {
    onHand.set(
      `${l.itemId}|${l.locationId}`,
      lock ? await stockLedgerRepo.onHandForUpdate(tx, l.itemId, l.locationId) : await stockLedgerRepo.onHand(tx, l.itemId, l.locationId),
    );
  }

  const roomIds = [...new Set(lines.map((l) => l.locationId))].sort(byText);
  const unusable = new Set<string>();
  for (const roomId of roomIds) {
    const room = await stockLocationsRepo.getLocation(tx, roomId);
    if (!room || !assertUsageSource(room).ok) unusable.add(roomId);
  }
  const sessions = await countSessionsRepo.freezingSessionsFor(tx, roomIds);
  const frozen = new Set(roomIds.filter((roomId) => isFrozenBySessions(sessions, roomId)));
  return { onHand, layerRemaining, frozen, unusable };
}

/** Item and room names (and the item's base unit as stored) for the sentences. */
async function namesFor(tx: Tx, orgId: string, held: readonly HeldLine[]) {
  const items = new Map<string, { name: string; unit: string }>();
  const rooms = new Map<string, string>();
  for (const itemId of new Set(held.map((h) => h.itemId))) {
    const item = await itemsRepo.getItemById(tx, orgId, itemId);
    items.set(itemId, { name: item?.name ?? 'an item', unit: item?.baseUnit ?? '' });
  }
  for (const roomId of new Set(held.map((h) => h.locationId))) {
    rooms.set(roomId, (await stockLocationsRepo.getLocation(tx, roomId))?.name ?? 'a room');
  }
  return {
    item: (id: string): string => items.get(id)?.name ?? 'an item',
    unit: (id: string): string => items.get(id)?.unit ?? '',
    room: (id: string): string => rooms.get(id) ?? 'a room',
  };
}

/**
 * T-388 (for the page, S2): per unposted line of each UNSTAMPED section, its hold sentence NOW, or none. Read-only, no
 * locks, from the stored plan. Each section is judged on its own (as one finalize press is); it does NOT subtract
 * another open section's unposted need, so with two open sections on one item it can under-warn. Documented, not fixed:
 * finalize re-decides under R3's locks, so the worst case is a hold the page did not predict.
 */
export async function pullHolds(tx: Tx, orgId: string, pullId: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const pull = await posMappingRepo.getPull(tx, pullId);
  if (!pull || pull.orgId !== orgId || pull.status === 'void') return out;
  const stored = await posMappingRepo.listPullLines(tx, pullId);

  for (const section of ['direct', 'recipe'] as const) {
    if (section === 'direct' ? pull.directFinalizedAt : pull.recipeFinalizedAt) continue;
    const inputs: HoldInputLine[] = [];
    for (const l of stored) {
      if (l.section !== section || l.usageRecordId !== null || l.blocked !== null) continue;
      if (!l.itemId || !l.locationId || !l.quantity) continue;
      if (compareQuantity(quantity(l.quantity), ZERO_QUANTITY) <= 0) continue;
      inputs.push({ key: l.lineKey, section, itemId: l.itemId, locationId: l.locationId, quantity: l.quantity });
    }
    if (inputs.length === 0) continue;

    const facts = await readHoldFacts(tx, pull.storeId, inputs, false);
    const { held } = decideHolds(inputs, facts.onHand, facts.layerRemaining, facts.frozen, facts.unusable);
    if (held.length === 0) continue;
    const names = await namesFor(tx, orgId, held);
    for (const h of held) {
      // The sentence of this line's own group: the same (item, room), or the whole frozen room.
      const group = held.filter((o) => o.cause === h.cause && o.locationId === h.locationId && (h.cause === 'frozen' || o.itemId === h.itemId));
      const sentence = heldSentences(section, group, names)[0];
      if (sentence !== undefined) out.set(h.key, sentence);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------------------
// finalizeSections
// -----------------------------------------------------------------------------------------
export interface FinalizeSectionsInput {
  readonly pullId: string;
  readonly sections: readonly PlanSection[];
  readonly confirmedKeys: readonly string[];
}

export interface SectionOutcome {
  readonly section: PlanSection;
  readonly ok: boolean;
  readonly reason?: string;
  readonly postedLineCount: number;
  /** T-388: the confirmed lines left unposted by this call (short stock, a room under count, a room that can't take usage). */
  readonly held: readonly HeldLine[];
  /** T-388 R11: one sentence per held (item, room), then the closing untick sentence; [] when nothing is held. */
  readonly heldSentences: readonly string[];
  /** T-388 R7: true only when THIS call stamped the section (nothing confirmed left unposted). */
  readonly finalized: boolean;
}

export type FinalizeResult =
  | { readonly ok: true; readonly sections: readonly SectionOutcome[]; readonly pullFinalized: boolean }
  | { readonly ok: false; readonly reason: string };

export async function finalizeSections(tx: Tx, actor: Actor, input: FinalizeSectionsInput): Promise<FinalizeResult> {
  const pull = await posMappingRepo.getPull(tx, input.pullId);
  if (!pull) return { ok: false, reason: `pull ${input.pullId} does not exist` };
  await authorize(tx, actor, 'finalize_pos_usage_pull', { storeId: pull.storeId });

  if (pull.status === 'void') return { ok: false, reason: 'this pull has been voided' };

  // Invariant 3, checked first — a stale snapshot is refused outright, exactly
  // as v1's own comment states: "the post path refuses anything this old."
  const ageMs = Date.now() - pull.snapshotTakenAt.getTime();
  if (ageMs > SNAPSHOT_MAX_AGE_MS) {
    return { ok: false, reason: 'SNAPSHOT_STALE: this plan is more than an hour old — rebuild it before finalizing' };
  }

  const salesDay = await salesDaysRepo.getById(tx, pull.orgId, pull.salesDayId);
  if (!salesDay) throw new Error(`finalizeSections: sales day ${pull.salesDayId} no longer exists`);

  // T-375 S5-lite: the day lock, then the pull lock, THEN the feed reads (nothing is fetched, so no HTTP to wait out).
  // T-373 S1 (DEF-552): a voided day posts nothing. Before the section loop so a refused day marks no section finalized.
  const lockedDay = await lockDayOutcome(tx, pull.orgId, pull.salesDayId, pull.storeId);
  if (!lockedDay.ok) return lockedDay;

  // T-374 S7 (R9): the pull's own lock. A void that got here first has committed by the time this returns, so
  // re-read `void`, each section's finalized stamp and the PIN from the LOCKED row, not from the unlocked read above.
  const locked = await posMappingRepo.getPullForUpdate(tx, pull.id);
  if (!locked) throw internalFault(`finalizeSections: pull ${pull.id} no longer exists`);
  if (locked.status === 'void') return { ok: false, reason: 'this pull has been voided' };

  const d = when(salesDay.businessDate);
  if (!locked.posV1DayFeedId) return fail(SENTENCES.preS5);
  const pinned = await loadPinnedFeed(tx, pull.orgId, pull.id, locked.posV1DayFeedId, pull.storeId, salesDay.businessDate);
  const pinRead = readFeed(pinned, salesDay.businessDate);
  if (!pinRead.ok) return pinRead;
  // T-388 R8/R9: the stored lines, read after the pull lock. A line that carries a usage record is final.
  const storedLines = await posMappingRepo.listPullLines(tx, pull.id);
  const postedStored = storedLines.filter((l) => l.usageRecordId !== null);
  const latest = await posV1Repo.latestForDay(tx, pull.orgId, pull.storeId, salesDay.businessDate, 'sold_items');
  if (latest && latest.id !== pinned.id) {
    const latestRead = readFeed(latest, salesDay.businessDate);
    if (!latestRead.ok) return latestRead;
    if (!sameItemsProjection(latestRead.items, pinRead.items)) {
      return fail(finalizedSectionsOf(locked).length > 0 || postedStored.length > 0 ? SENTENCES.partlyChanged(d) : SENTENCES.changed(d));
    }
  }
  const freshLines = await rebuildLines(tx, pull.orgId, pull.storeId, locked.locationId, pinRead.items);

  const freshKeys = new Set(freshLines.map((l) => l.key));
  const confirmedSet = new Set(input.confirmedKeys);

  // Invariant 2, direction 1 — a confirmed key the rebuild no longer produces refuses the WHOLE
  // call: the client's view of the world no longer matches reality.
  for (const key of confirmedSet) {
    if (!freshKeys.has(key)) {
      return { ok: false, reason: `PLAN_CHANGED: "${key}" is no longer part of today's plan — refresh the plan and try again` };
    }
  }

  const alreadyFinalized: Record<PlanSection, Date | null> = {
    direct: locked.directFinalizedAt,
    recipe: locked.recipeFinalizedAt,
    orphan: locked.orphanFinalizedAt,
  };

  const results: SectionOutcome[] = [];
  // ⚠️ De-duplicated — a caller passing the same section twice in one call must not double-post it.
  // `alreadyFinalized` is also updated as sections are processed BELOW (not only read once from the
  // DB up front), for the same reason.
  const requestedSections = [...new Set(input.sections)];
  const postedKeys = new Set(postedStored.map((l) => l.lineKey));
  const freshByKey = new Map(freshLines.map((l) => [l.key, l]));

  // T-388 R8: a posted key's fresh rebuild must still be the same item, room and quantity, for every UNSTAMPED
  // section being finalized (a stamped section is never re-checked). Recipe line keys are by ingredient index, so a
  // recipe edit could otherwise point a posted key at a different item. Refused before any write.
  for (const section of requestedSections) {
    if (section === 'orphan' || alreadyFinalized[section]) continue;
    for (const stored of postedStored) {
      if (stored.section !== section) continue;
      const fresh = freshByKey.get(stored.lineKey);
      const same =
        fresh !== undefined &&
        !fresh.blocked &&
        fresh.itemId === stored.itemId &&
        fresh.locationId === stored.locationId &&
        fresh.quantity !== null &&
        stored.quantity !== null &&
        compareQuantity(quantity(fresh.quantity), quantity(stored.quantity)) === 0;
      if (!same) return fail(SENTENCES.postedChanged(stored.posItemName));
    }
  }

  // T-388 R6: a closed stock month refuses only when there is something to post. Checked before the section loop,
  // so the refusal writes nothing. (A held section whose month closed can still be stamped by unticking its held lines.)
  const somethingToPost = requestedSections.some(
    (section) => section !== 'orphan' && !alreadyFinalized[section] && candidateLines(freshLines, section, confirmedSet, postedKeys).length > 0,
  );
  if (somethingToPost) {
    const closed = await closedStockPeriodSentence(tx, pull.orgId, salesDay.businessDate, 'used');
    if (closed) return fail(closed);
  }

  // From here on, a refusal after a write THROWS (never `return { ok: false }`): the caller commits on `ok: false`.
  for (const section of requestedSections) {
    if (alreadyFinalized[section]) {
      results.push({ section, ok: false, reason: `the ${section} section was already finalized`, postedLineCount: 0, held: [], heldSentences: [], finalized: false });
      continue;
    }

    if (section === 'orphan') {
      // No stock effect — an orphan is informational (invariant 7). Finalizing it is bookkeeping:
      // this section's review is done for today, so it stops being offered as "open."
      await posMappingRepo.markSectionFinalized(tx, pull.id, 'orphan');
      alreadyFinalized.orphan = new Date();
      results.push({ section, ok: true, postedLineCount: 0, held: [], heldSentences: [], finalized: true });
      continue;
    }

    // Invariant 2, direction 2 — a rebuilt line the caller never confirmed is simply excluded here,
    // never written, even though the rebuild produced it. Lines that already carry a usage record are skipped (R8).
    const inputs = candidateLines(freshLines, section, confirmedSet, postedKeys);

    // R3/R4/R4a: read under the locks the writers take, per section (after earlier sections wrote), then decide.
    const facts = await readHoldFacts(tx, pull.storeId, inputs, true);
    const decision = decideHolds(inputs, facts.onHand, facts.layerRemaining, facts.frozen, facts.unusable);
    const held: HeldLine[] = [...decision.held];

    const byLocation = new Map<string, HoldInputLine[]>();
    for (const line of decision.post) {
      const group = byLocation.get(line.locationId) ?? [];
      group.push(line);
      byLocation.set(line.locationId, group);
    }

    let postedLineCount = 0;
    for (const [locationId, group] of byLocation) {
      let recordId: string;
      try {
        recordId = await tx.transaction(async (inner) => {
          const draft = await saveUsageDraft(inner as Tx, actor, {
            orgId: pull.orgId,
            storeId: pull.storeId,
            locationId,
            kind: 'usage',
            usedOn: salesDay.businessDate,
            lines: group.map((l) => ({ itemId: l.itemId, quantity: quantity(l.quantity) })),
          });
          if (!draft.ok) throw refuse(`usage-pull: draft refused: ${draft.reason}`, draft.reason);
          const posted = await postUsage(inner as Tx, actor, { recordId: draft.recordId });
          if (!posted.ok) throw refuse(`usage-pull: post refused: ${posted.reason}`, posted.reason);
          return draft.recordId;
        });
      } catch (err) {
        // R5: the savepoint already unwound this room's partial write. A count started in the gap since the read is the
        // one failure that waits; anything else is re-thrown so the whole call unwinds and nothing is stamped.
        const sessions = await countSessionsRepo.freezingSessionsFor(tx, [locationId]);
        if (!isFrozenBySessions(sessions, locationId)) throw err;
        held.push(...decideHolds(group, facts.onHand, facts.layerRemaining, new Set([locationId]), new Set()).held);
        continue;
      }
      // R10: the link is written OUTSIDE the catch above, so a failure here can never be mistaken for a freeze.
      const linked = await posMappingRepo.setLineUsageRecord(
        tx,
        pull.id,
        group.map((l) => ({ lineKey: l.key, itemId: l.itemId, locationId: l.locationId, quantity: quantity(l.quantity), usageRecordId: recordId })),
      );
      const unlinked = group.filter((_, i) => linked[i] !== 1);
      if (unlinked.length > 0) {
        throw internalFault(`finalizeSections: pull ${pull.id}: ${unlinked.length} posted line(s) matched other than one stored row (${unlinked.map((l) => l.key).join(', ')})`);
      }
      postedLineCount += group.length;
    }

    // R7: stamped only when nothing confirmed is left unposted.
    const finalized = held.length === 0;
    if (finalized) {
      await posMappingRepo.markSectionFinalized(tx, pull.id, section);
      alreadyFinalized[section] = new Date();
    }
    const names = await namesFor(tx, pull.orgId, held);
    results.push({ section, ok: true, postedLineCount, held, heldSentences: heldSentences(section, held, names), finalized });
  }

  // T-377 S2 (DEF-597, R2/R3): ALL OR NONE. When EVERY unstamped section is empty in BOTH the stored plan (read after
  // the pull lock) and the fresh rebuild, there is nothing left for a person to review, so stamp them all. Any line in
  // any unstamped section (blocked or not) stamps nothing. Runs only after every refusal above; adds no `results` row.
  const open = (['direct', 'recipe', 'orphan'] as const).filter((s) => !alreadyFinalized[s]);
  if (open.length > 0) {
    const storedLines = await posMappingRepo.listPullLines(tx, pull.id);
    const hasLine = (section: PlanSection): boolean =>
      storedLines.some((l) => l.section === section) || freshLines.some((l) => l.section === section);
    if (!open.some(hasLine)) {
      for (const section of open) {
        await posMappingRepo.markSectionFinalized(tx, pull.id, section);
        alreadyFinalized[section] = new Date();
      }
    }
  }

  const refreshed = await posMappingRepo.getPull(tx, pull.id);
  let pullFinalized = false;
  if (refreshed?.directFinalizedAt && refreshed.recipeFinalizedAt && refreshed.orphanFinalizedAt) {
    await posMappingRepo.markPullFinalized(tx, pull.id, actor.personId);
    pullFinalized = true;
  }

  return { ok: true, sections: results, pullFinalized };
}

// -----------------------------------------------------------------------------------------
// voidPosUsagePull - T-374 S7 (DEF-578)
// -----------------------------------------------------------------------------------------
/**
 * Void a POS usage pull AS A DOCUMENT: every usage record it made is reversed and the pull goes `void` with
 * who, when and why, all in the caller's transaction, or none of it. Nothing outside the pull is touched.
 *
 * - R7  All or none. Every refusal THROWS (a `RefusalError` with a plain sentence), so the caller's transaction
 *       unwinds any record already reversed. Planned, partly finalized and finalized pulls are all voidable; a
 *       planned pull reverses nothing. Returns `{ ok: true, reversedRecordCount }` or throws.
 * - R8  Capability `void_usage_record`, authorized ONCE on the pull's store (a pull's records are its store's).
 *       Each record then reverses through the actor-less `voidPullUsageRecord`, which is what lets R10 stop a
 *       record being voided on its own.
 * - R9  Lock order: `authorize` -> pull `FOR UPDATE` -> status checks -> record voids. `finalizeSections` takes
 *       the same lock, so a void and a finalize serialize.
 * - R10 (see `voidUsage`) a pull-made record cannot be voided alone.
 * - R11 A void pull frees its date: the unique index and `findLivePullOnVoidedDayForDate` count only non-void pulls.
 * - R12 The reversal is dated on the pull's sales day when that stock month is open, else today. The CHOSEN date
 *       is tested once, before any write, so a closed month refuses the whole void and never half of it.
 * - R13 `voided_at / voided_by / void_reason` and `pos_usage_pulls_void_shape_check` (migration 0181).
 */
export async function voidPosUsagePull(
  tx: Tx,
  actor: Actor,
  input: { readonly pullId: string; readonly reason: string },
): Promise<{ readonly ok: true; readonly reversedRecordCount: number }> {
  const raw = `voidPosUsagePull: pull ${input.pullId}`;
  const found = await posMappingRepo.getPull(tx, input.pullId);
  // No existence oracle: a missing pull is judged by the same capability gate first, so someone who may not void
  // gets the same AuthorizationError whether or not the pull exists.
  if (!found) {
    await authorize(tx, actor, 'void_usage_record');
    throw gone(`${raw} does not exist`, 'POS usage pull');
  }
  await authorize(tx, actor, 'void_usage_record', { storeId: found.storeId });

  const pull = await posMappingRepo.getPullForUpdate(tx, input.pullId);
  if (!pull) throw gone(`${raw} does not exist`, 'POS usage pull');
  if (pull.status === 'void') throw refuse(`${raw} is already void`, 'This POS usage pull was already voided.');

  const reason = input.reason.trim();
  if (!reason) throw refuse(`${raw}: blank reason`, 'Say why this pull is being voided.');

  const salesDay = await salesDaysRepo.getById(tx, pull.orgId, pull.salesDayId);
  if (!salesDay) throw internalFault(`${raw}: sales day ${pull.salesDayId} no longer exists`);

  // R12: the sales day's date when its stock month is open, else today.
  const dayDate = salesDay.businessDate as BusinessDate;
  // R7 (review): the CHOSEN date is tested once, before any write.
  const dayClosed = await closedStockPeriodSentence(tx, pull.orgId, dayDate, 'voided');
  const voidedOn = dayClosed === null ? dayDate : toBusinessDate();
  const closed = dayClosed === null ? null : await closedStockPeriodSentence(tx, pull.orgId, voidedOn, 'voided');
  if (closed) throw refuse(`${raw}: stock month closed for ${voidedOn}`, closed);

  const recordIds = await posMappingRepo.postedUsageRecordIdsForPull(tx, pull.id);
  for (const recordId of recordIds) {
    const result = await voidPullUsageRecord(tx, { recordId, reason, voidedOn, voidedBy: actor.personId });
    // After the checks above a refusal here is not a person's mistake (its text carries record ids): fail
    // the whole void so the records already reversed unwind.
    if (!result.ok) throw internalFault(`${raw}: record ${recordId} could not be voided: ${result.reason}`);
  }

  await posMappingRepo.markPullVoid(tx, pull.id, actor.personId, reason);
  return { ok: true, reversedRecordCount: recordIds.length };
}
