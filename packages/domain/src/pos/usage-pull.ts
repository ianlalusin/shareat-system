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

  const existing = await posMappingRepo.findLivePullForDay(tx, input.storeId, input.salesDayId);
  if (existing && existing.status !== 'planned') {
    return { ok: false, reason: `this day's pull is already ${existing.status} — invariant 12: only one live pull per (store, sales day)` };
  }

  const lines = await rebuildLines(tx, input.orgId, input.storeId, salesDay.businessDate, input.locationId, fetchSnapshot);
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
    direct: pull.directFinalizedAt,
    recipe: pull.recipeFinalizedAt,
    orphan: pull.orphanFinalizedAt,
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
