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
 * re-fetches POS live and re-runs `plan.ts`'s pure explosion against CURRENT mappings/recipes, then
 * writes only the intersection of that fresh result and what the caller says it confirmed. A
 * confirmed key the rebuild no longer produces refuses the whole call (`PLAN_CHANGED`); a rebuilt
 * key the caller never confirmed is silently excluded, never written.
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
 */
import { authorize, type Actor } from '@shareat/auth';
import { env } from '@shareat/core/env';
import { posMappingRepo, salesDaysRepo, type Tx } from '@shareat/db';
import { postUsage, saveUsageDraft } from '../stock/usage-records';
import { voidPullUsageRecord } from '../stock/void-pull-usage-record';
import { closedStockPeriodSentence } from '../stock/period-guard';
import { lockLiveSalesDay } from '../sales-days/live-day';
import { RefusalError, gone, humanDate, internalFault, refuse } from '../shared/refusal';
import { toBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { compareQuantity, quantity, ZERO_QUANTITY } from '../stock/quantity';
import { explodePosSales, type PlanLine, type PlanSection } from './plan';

// -----------------------------------------------------------------------------------------
// The live POS fetch
// -----------------------------------------------------------------------------------------
export interface PosSoldItemSnapshot {
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly physicalQty: string;
}

export type FetchPosSnapshot = (input: { storeId: string; businessDate: string }) => Promise<readonly PosSoldItemSnapshot[]>;

/**
 * `GET {POS_API_URL}/api/external/sold-items?storeId=&date=` — the exact route and shape v1's
 * `fetchPosSoldItems` (`ERP-rebuild/src/lib/server/pos-api.ts`) already calls, verified at source
 * against `POS/src/app/api/external/sold-items/route.ts`: `x-api-key` auth, and a `physicalQty`
 * field POS already nets to sold + comped − voided (invariant 1) — never recomputed here.
 *
 * ⚠️ `POS_API_URL`/`POS_API_KEY` were added to `@shareat/core/env`'s validated contract for this
 * task — a reasoned, narrow scope extension (bible §3.3) reported in the task's own completion
 * report, since a live HTTP dependency reading raw `process.env` would be exactly the ad hoc
 * fallback bible §7 rule 9 forbids.
 */
export async function fetchPosSoldItemsLive(input: { storeId: string; businessDate: string }): Promise<readonly PosSoldItemSnapshot[]> {
  const { POS_API_URL, POS_API_KEY } = env();
  const url = POS_API_URL;
  const key = POS_API_KEY;
  if (!url || !key) {
    throw new Error('fetchPosSoldItemsLive: POS_API_URL or POS_API_KEY is not configured — see .env.example');
  }
  const res = await fetch(
    `${url}/api/external/sold-items?storeId=${encodeURIComponent(input.storeId)}&date=${encodeURIComponent(input.businessDate)}`,
    { headers: { 'x-api-key': key }, cache: 'no-store' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new Error(typeof body.error === 'string' ? body.error : `POS API returned ${res.status}`);
  }
  const data = (await res.json()) as { found: boolean; items?: readonly Record<string, unknown>[] };
  if (!data.found) return [];
  return (data.items ?? []).map((it) => ({
    posItemKey: String(it.posItemId ?? ''),
    posItemName: String(it.name ?? it.posItemId ?? ''),
    physicalQty: String(it.physicalQty ?? '0'),
  }));
}

/** Invariant 3 — named with its reason, never inlined. */
export const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

async function rebuildLines(
  tx: Tx,
  orgId: string,
  storeId: string,
  businessDate: string,
  defaultLocationId: string,
  fetchSnapshot: FetchPosSnapshot,
): Promise<PlanLine[]> {
  const [posItems, maps] = await Promise.all([
    fetchSnapshot({ storeId, businessDate }),
    posMappingRepo.listActiveMaps(tx, storeId),
  ]);
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
 * T-373 S1 (R2): lock the day and re-check it AFTER the POS fetch, never across it. The date cannot
 * change in between (an edit never changes the date), so the fetched lines stay valid; only status and
 * store are re-checked. This module returns Outcomes, so the refusal becomes its sentence.
 */
async function lockDayOutcome(tx: Tx, orgId: string, salesDayId: string, storeId: string): Promise<{ ok: false; reason: string } | null> {
  try {
    await lockLiveSalesDay(tx, orgId, { salesDayId, storeId, doing: 'usage' });
    return null;
  } catch (err) {
    if (err instanceof RefusalError) return { ok: false, reason: err.userMessage };
    throw err;
  }
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
  | { readonly ok: true; readonly pullId: string; readonly lines: readonly PlanLine[]; readonly snapshotTakenAt: Date }
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

export async function buildPlan(
  tx: Tx,
  actor: Actor,
  input: BuildPlanInput,
  fetchSnapshot: FetchPosSnapshot = fetchPosSoldItemsLive,
): Promise<BuildPlanOutcome> {
  await authorize(tx, actor, 'record_stock_movement', { storeId: input.storeId });

  const salesDay = await salesDaysRepo.getById(tx, input.orgId, input.salesDayId);
  if (!salesDay) return { ok: false, reason: `sales day ${input.salesDayId} does not exist` };
  if (salesDay.storeId !== input.storeId) return { ok: false, reason: 'that sales day does not belong to this store' };

  // T-373 S1: refuse a voided day from the plain read, before the POS fetch (re-checked under the lock after it).
  if (salesDay.status === 'voided') {
    return { ok: false, reason: `The sales day for ${humanDate(salesDay.businessDate as BusinessDate)} has been voided, so usage can't be recorded against it.` };
  }

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

  const lines = await rebuildLines(tx, input.orgId, input.storeId, salesDay.businessDate, input.locationId, fetchSnapshot);

  // T-373 S1 R1/R2: lock the live day after the fetch, before the first write.
  const refused = await lockDayOutcome(tx, input.orgId, input.salesDayId, input.storeId);
  if (refused) return refused;
  let finalizedSections: PlanSection[] = [];
  // T-374 S7 (audit 2): the pull's own lock (same FOR UPDATE as void / finalize), then re-check under it. A void
  // that committed first leaves the pull `void`; a finalize that committed first leaves a section stamped.
  if (existing) {
    const locked = await posMappingRepo.getPullForUpdate(tx, existing.id);
    if (!locked || locked.status === 'void') {
      return { ok: false, reason: "This POS usage pull was voided, so its plan can't be rebuilt. Build the day again." };
    }
    if (locked.status !== 'planned') return { ok: false, reason: `this day's pull is already ${locked.status} — invariant 12: only one live pull per (store, sales day)` };
    finalizedSections = finalizedSectionsOf(locked);
  }
  const now = new Date();

  const pullId = existing
    ? await (async () => {
        await posMappingRepo.refreshPlannedPull(tx, existing.id, { locationId: input.locationId, snapshotTakenAt: now });
        return existing.id;
      })()
    : (await posMappingRepo.insertPull(tx, { orgId: input.orgId, storeId: input.storeId, salesDayId: input.salesDayId, locationId: input.locationId, snapshotTakenAt: now })).id;

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

  return { ok: true, pullId, lines, snapshotTakenAt: now };
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
  readonly blockedLineCount: number;
}

export type FinalizeResult = { readonly ok: true; readonly sections: readonly SectionOutcome[] } | { readonly ok: false; readonly reason: string };

export async function finalizeSections(
  tx: Tx,
  actor: Actor,
  input: FinalizeSectionsInput,
  fetchSnapshot: FetchPosSnapshot = fetchPosSoldItemsLive,
): Promise<FinalizeResult> {
  const pull = await posMappingRepo.getPull(tx, input.pullId);
  if (!pull) return { ok: false, reason: `pull ${input.pullId} does not exist` };
  await authorize(tx, actor, 'finalize_pos_usage_pull', { storeId: pull.storeId });

  if (pull.status === 'void') return { ok: false, reason: 'this pull has been voided' };

  // Invariant 3, checked BEFORE any live re-fetch — a stale snapshot is refused outright, exactly
  // as v1's own comment states: "the post path refuses anything this old."
  const ageMs = Date.now() - pull.snapshotTakenAt.getTime();
  if (ageMs > SNAPSHOT_MAX_AGE_MS) {
    return { ok: false, reason: 'SNAPSHOT_STALE: this plan is more than an hour old — rebuild it before finalizing' };
  }

  const salesDay = await salesDaysRepo.getById(tx, pull.orgId, pull.salesDayId);
  if (!salesDay) throw new Error(`finalizeSections: sales day ${pull.salesDayId} no longer exists`);

  const freshLines = await rebuildLines(tx, pull.orgId, pull.storeId, salesDay.businessDate, pull.locationId, fetchSnapshot);
  // T-373 S1 (DEF-552): a voided day posts nothing. Before the section loop so a refused day marks no section finalized.
  const refused = await lockDayOutcome(tx, pull.orgId, pull.salesDayId, pull.storeId);
  if (refused) return refused;

  // T-374 S7 (R9): the pull's own lock, taken AFTER the POS fetch (never held across HTTP). A void that got
  // here first has committed by the time this returns, so re-read `void` and each section's finalized stamp
  // from the LOCKED row, not from the unlocked read above.
  const locked = await posMappingRepo.getPullForUpdate(tx, pull.id);
  if (!locked) throw internalFault(`finalizeSections: pull ${pull.id} no longer exists`);
  if (locked.status === 'void') return { ok: false, reason: 'this pull has been voided' };

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

  for (const section of requestedSections) {
    if (alreadyFinalized[section]) {
      results.push({ section, ok: false, reason: `the ${section} section was already finalized`, postedLineCount: 0, blockedLineCount: 0 });
      continue;
    }

    // Invariant 2, direction 2 — a rebuilt line the caller never confirmed is simply excluded here,
    // never written, even though the rebuild produced it.
    const sectionLines = freshLines.filter((l) => l.section === section && !l.blocked && confirmedSet.has(l.key));

    if (section === 'orphan') {
      // No stock effect — an orphan is informational (invariant 7). Finalizing it is bookkeeping:
      // this section's review is done for today, so it stops being offered as "open."
      await posMappingRepo.markSectionFinalized(tx, pull.id, 'orphan');
      alreadyFinalized.orphan = new Date();
      results.push({ section, ok: true, postedLineCount: 0, blockedLineCount: 0 });
      continue;
    }

    const byLocation = new Map<string, PlanLine[]>();
    for (const line of sectionLines) {
      if (!line.itemId || !line.quantity || !line.locationId) continue;
      if (compareQuantity(quantity(line.quantity), ZERO_QUANTITY) <= 0) continue;
      const group = byLocation.get(line.locationId) ?? [];
      group.push(line);
      byLocation.set(line.locationId, group);
    }

    let postedLineCount = 0;
    let blockedLineCount = 0;

    for (const [locationId, group] of byLocation) {
      try {
        const recordId = await tx.transaction(async (inner) => {
          const draft = await saveUsageDraft(inner as Tx, actor, {
            orgId: pull.orgId,
            storeId: pull.storeId,
            locationId,
            kind: 'usage',
            usedOn: salesDay.businessDate,
            lines: group.map((l) => ({ itemId: l.itemId!, quantity: l.quantity! })),
          });
          if (!draft.ok) throw new Error(draft.reason);
          const posted = await postUsage(inner as Tx, actor, { recordId: draft.recordId });
          if (!posted.ok) throw new Error(posted.reason);
          return draft.recordId;
        });

        await posMappingRepo.setLineUsageRecord(
          tx,
          pull.id,
          group.map((l) => ({ lineKey: l.key, quantity: l.quantity!, usageRecordId: recordId })),
        );
        postedLineCount += group.length;
      } catch {
        // A frozen location (or any other real DB-level refusal) — this group's lines stay
        // unfinalized. The savepoint above already unwound any partial write within it.
        blockedLineCount += group.length;
      }
    }

    await posMappingRepo.markSectionFinalized(tx, pull.id, section);
    alreadyFinalized[section] = new Date();
    results.push({ section, ok: true, postedLineCount, blockedLineCount });
  }

  const refreshed = await posMappingRepo.getPull(tx, pull.id);
  if (refreshed?.directFinalizedAt && refreshed.recipeFinalizedAt && refreshed.orphanFinalizedAt) {
    await posMappingRepo.markPullFinalized(tx, pull.id, actor.personId);
  }

  return { ok: true, sections: results };
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
 *       the same lock after its POS fetch, so a void and a finalize serialize.
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
