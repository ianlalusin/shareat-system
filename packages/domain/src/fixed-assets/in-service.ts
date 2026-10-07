/**
 * setAssetInService — correcting when an asset went into service. T-346 S2 (DEF-427).
 * docs/tasks/346-store-opening-and-in-service-date.md §3.4.
 *
 * ⭐ **Reverse, never rewrite.** Closed books are never touched (bible row 193); the correction
 * convention already exists (T-106, `POSTING-PATTERNS.md:1220-1241`): reverse the wrong months in
 * an open month, keep the right ones. There is nothing to RE-POST here — straight-line equal
 * instalments mean a month the new schedule still owes, at the SAME amount, needs no correction at
 * all, and a month it owes at a DIFFERENT amount is reversed too: it re-posts on the next run under its
 * revision key if its period is open, or is listed by T-345 if its period is closed (DEF-435, T-368 S2).
 *
 * ⚠️ **This file independently computes the same in-service value migration 0163's fill trigger
 * would derive**, so it can plan which posted months to reverse BEFORE writing anything — the
 * trigger only sees the final state, too late to reverse first. `repo/fixed-assets.ts`'s
 * `setInServiceSource` is what actually writes the columns, and the migration's guard trigger is
 * the backstop that enforces the result stays legal (RULES §6.3) if this ever disagreed with it.
 */
import { createHash } from 'node:crypto';
import { authorize, type Actor } from '@shareat/auth';
import { fixedAssetsRepo, journalRepo, manilaToday, storesRepo, type Tx } from '@shareat/db';
import { add, formatMoney, money } from '@shareat/core/money';
import { reverseEntry } from '../ledger/reverse-entry';
import { refuse } from '../shared/refusal';
import { buildSchedule, type ScheduleInput } from './schedule';

export interface SetAssetInServiceInput {
  mode: 'acquired' | 'store_opening' | 'set';
  /** Required for `mode: 'set'`; ignored otherwise (the other two modes derive their own date). */
  inServiceOn?: string;
  reason: string;
  /** Required once §3.4 step 4 finds anything to reverse: the token the first refusal carried (`planToken`),
   *  resubmitted. It pins the confirm to the EXACT entries that refusal listed - T-368 S2 (DEF-441). */
  confirmedPlan?: string;
}

export interface SetAssetInServiceResult {
  inServiceSource: 'acquired' | 'store_opening' | 'set';
  inServiceOn: string | null;
  /** Periods reversed by this call, oldest first. Empty when nothing needed reversing. */
  reversed: string[];
}

/** Resolves what `mode` means for THIS asset right now — mirrors migration 0163's fill trigger
 *  exactly (§3.3 step 4), duplicated here for the reason this file's own header names. */
async function resolveMode(
  tx: Tx,
  orgId: string,
  asset: fixedAssetsRepo.FixedAssetRow,
  input: SetAssetInServiceInput,
): Promise<{ source: 'acquired' | 'store_opening' | 'set'; inServiceOn: string | null }> {
  if (input.mode === 'acquired') {
    return { source: 'acquired', inServiceOn: asset.acquiredOn };
  }
  if (input.mode === 'store_opening') {
    const store = await storesRepo.getById(tx, orgId, asset.storeId);
    const openingDate = store?.openingDate ?? null;
    // ⭐ Safe: `setAssetInService` already refused a non-'active' asset before calling this, and an
    // active row is never a shell — its acquired_on/cost are always set (0163's shape CHECK).
    const inServiceOn =
      openingDate === null ? null : openingDate > asset.acquiredOn! ? openingDate : asset.acquiredOn!;
    return { source: 'store_opening', inServiceOn };
  }
  if (!input.inServiceOn) {
    throw new Error('setAssetInService: a date is required to set an explicit in-service date.');
  }
  return { source: 'set', inServiceOn: input.inServiceOn };
}

interface ReversalPlan {
  /** R — sorted oldest first. */
  toReverse: fixedAssetsRepo.PostedDepreciationEntry[];
}

/** §3.4 steps 2-3, shared by `setAssetInService` and `setStoreOpeningDate`'s own cascade (§3.2
 *  step 3) — one computation of "what would this in-service change reverse", never two.
 *
 *  T-368 S2 (DEF-435): a month the new schedule owes at a DIFFERENT amount is simply reversed - it re-posts
 *  on the next run if its period is open, or is listed by T-345 if its period is closed. There is no
 *  "cannot re-book" conflict any more: a reversed month can be booked again (`depreciationRevisionKey`). */
export async function planInServiceReversal(
  tx: Tx,
  orgId: string,
  asset: fixedAssetsRepo.FixedAssetRow,
  newInServiceOn: string | null,
): Promise<ReversalPlan> {
  const posted = await fixedAssetsRepo.postedDepreciationEntries(tx, orgId, asset.id);

  const owedByPeriod = new Map<string, string>();
  if (newInServiceOn !== null) {
    // ⭐ Safe: both callers (`applyInServiceChange`, gated on `asset.status === 'active'` earlier
    // in `setAssetInService`; `setStoreOpeningDate`'s cascade, filtered to `status: 'active'` AND
    // `inServiceSource === 'store_opening'`) only ever hand this an active, non-shell asset — a
    // shell's cost is NULL only alongside `in_service_source` also NULL (0163's shape CHECK), which
    // an active/store_opening row can never be.
    const scheduleInput: ScheduleInput = {
      startsOn: newInServiceOn,
      cost: money(asset.cost!),
      salvageValue: money(asset.salvageValue ?? '0'),
      usefulLifeMonths: asset.usefulLifeMonths,
      interval: asset.interval,
    };
    for (const p of buildSchedule(scheduleInput)) {
      owedByPeriod.set(p.period, String(p.amount));
    }
  }

  const toReverse = posted
    .filter((e) => owedByPeriod.get(e.period) !== e.amount)
    .sort((a, b) => a.period.localeCompare(b.period));

  return { toReverse };
}

/**
 * The token that pins a confirm to the entries it showed: the first 16 hex characters of sha-256 over the
 * entry ids, sorted and joined by `,`. T-368 S2 (DEF-441). The store cascade passes the ids of EVERY
 * affected asset, so one token covers the whole plan.
 */
export function planToken(entries: { entryId: string }[]): string {
  const ids = entries.map((e) => e.entryId).sort();
  return createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
}

/**
 * Refuses unless `confirmedPlan` is the token of exactly these entries. Nothing is written by a refusal.
 *  - no token: the refusal as always (ends "confirm to proceed") plus the `planToken` to resubmit;
 *  - a token that does not match what is planned NOW: "What this would reverse has changed since you
 *    confirmed." and the NEW list, with the new token - so a confirm can never reverse entries the person
 *    did not see.
 * An empty plan needs no confirmation.
 */
export function requireConfirmedPlan(
  entries: { entryId: string }[],
  confirmedPlan: string | undefined,
  raw: string,
  userMessage: string,
): void {
  if (entries.length === 0) return;
  const token = planToken(entries);
  if (confirmedPlan === token) return;
  const stale = confirmedPlan !== undefined && confirmedPlan !== '';
  const refusal = refuse(raw, stale ? `What this would reverse has changed since you confirmed. ${userMessage}` : userMessage);
  throw Object.assign(refusal, { planToken: token });
}

/** Is the entry's own fiscal period still open right now? Decides whether `reverseEntry` gets an
 *  explicit `reversalDate` (R1.4: pass Manila today ONLY for a non-open period; otherwise let
 *  `reverseEntry` default to the original's own date, un-prefixed). */
async function isPeriodOpen(tx: Tx, entryId: string): Promise<boolean> {
  const entry = await journalRepo.findEntryById(tx, entryId);
  if (!entry) throw new Error(`setAssetInService: journal entry ${entryId} does not exist`);
  const period = await journalRepo.findPeriodById(tx, entry.periodId);
  return period?.status === 'open';
}

/** `${n} entries (first–last), ₱total` — the one phrasing both the single-asset confirm
 *  (`applyInServiceChange`) and the store-wide cascade (`stores/service.ts` §3.2 step 3) use, so
 *  the two confirm messages never drift apart in shape. */
export function describeReversal(toReverse: fixedAssetsRepo.PostedDepreciationEntry[]): string {
  const first = toReverse[0]!.period;
  const last = toReverse[toReverse.length - 1]!.period;
  const total = toReverse.reduce((sum, e) => add(sum, money(e.amount)), money('0'));
  return `${toReverse.length} depreciation entries (${first}–${last}), ${formatMoney(total)}`;
}

/** How many assets a store-wide confirm names one by one before it summarises the rest (T-380 S2-R1). */
export const CONFIRM_NAMED_ASSETS = 10;

/**
 * The per-asset part of the store-wide confirm sentence. Up to `CONFIRM_NAMED_ASSETS` assets are named in a stable
 * order (name, then the first entry id), each as `describeReversal` words it. Beyond that: `and N more asset(s). In
 * all: <every entry being reversed> entries, ₱<total>`, counted over the SAME entries the plan hash covers, so the
 * figures shown are exactly what a confirm will reverse. Nothing is cut mid-sentence. T-380 S2-R1 (the consent text
 * rides a size-limited cookie).
 */
export function describeStoreReversal(
  affected: { name: string; toReverse: fixedAssetsRepo.PostedDepreciationEntry[] }[],
): string {
  const ordered = [...affected].sort(
    (a, b) => a.name.localeCompare(b.name) || a.toReverse[0]!.entryId.localeCompare(b.toReverse[0]!.entryId),
  );
  const named = ordered
    .slice(0, CONFIRM_NAMED_ASSETS)
    .map(({ name, toReverse }) => `${name} — ${describeReversal(toReverse)}`)
    .join('; ');
  if (ordered.length <= CONFIRM_NAMED_ASSETS) return named;
  const all = ordered.flatMap((a) => a.toReverse);
  const total = all.reduce((sum, e) => add(sum, money(e.amount)), money('0'));
  return `${named}; and ${ordered.length - CONFIRM_NAMED_ASSETS} more asset(s). In all: ${all.length} depreciation entries, ${formatMoney(total)}`;
}

/**
 * Reverses every planned entry, dating each one per R1.4 (`reverseEntry`'s own open/closed-period
 * branching — this only decides whether to override it). `memo` is the caller's full reversal
 * reason text, used verbatim for every entry reversed by this call.
 *
 * ⭐ Takes `reversedBy` (a bare id), not the caller's `Actor` — this is a shared internal helper,
 * never a user-facing entry point on its own (`setAssetInService` and `setStoreOpeningDate` are
 * the two that authorize), and the only thing of the actor it ever needed was `.personId`.
 */
export async function executeReversals(
  tx: Tx,
  reversedBy: string | null,
  today: string,
  memo: string,
  toReverse: fixedAssetsRepo.PostedDepreciationEntry[],
): Promise<string[]> {
  for (const e of toReverse) {
    const open = await isPeriodOpen(tx, e.entryId);
    await reverseEntry(tx, {
      entryId: e.entryId,
      reason: memo,
      reversedBy,
      ...(open ? {} : { reversalDate: today }),
    });
  }
  return toReverse.map((e) => e.period);
}

/**
 * §3.4 steps 1, 4-6 — authorize, blank-reason, confirm-then-reverse, write the columns. Runs on the
 * caller's transaction (never opens its own — always called from inside `withOrgPrincipal`, same as
 * every other fixed-assets writer). Any refusal writes nothing.
 */
async function applyInServiceChange(
  tx: Tx,
  actor: Actor,
  asset: fixedAssetsRepo.FixedAssetRow,
  target: { source: 'acquired' | 'store_opening' | 'set'; inServiceOn: string | null },
  reason: string,
  confirmedPlan: string | undefined,
): Promise<SetAssetInServiceResult> {
  const plan = await planInServiceReversal(tx, actor.orgId, asset, target.inServiceOn);

  if (plan.toReverse.length > 0) {
    const sentence = `${asset.name} — moving the in-service date reverses ${describeReversal(plan.toReverse)}; confirm to proceed`;
    requireConfirmedPlan(plan.toReverse, confirmedPlan, `setAssetInService: ${sentence}`, sentence);
  }

  const dateLabel = target.inServiceOn ?? 'held (no opening date yet)';
  const today = await manilaToday(tx);
  await executeReversals(
    tx,
    actor.personId,
    today,
    `in-service date corrected to ${dateLabel} — ${reason}`,
    plan.toReverse,
  );

  if (target.source === 'set') {
    await fixedAssetsRepo.setInServiceSource(tx, actor.orgId, asset.id, {
      source: 'set',
      inServiceOn: target.inServiceOn!,
    });
  } else {
    await fixedAssetsRepo.setInServiceSource(tx, actor.orgId, asset.id, { source: target.source });
  }

  return {
    inServiceSource: target.source,
    inServiceOn: target.inServiceOn,
    reversed: plan.toReverse.map((e) => e.period),
  };
}

/**
 * The asset-initiated entry point (§3.6's `/fixed-assets/[id]` change form). `setStoreOpeningDate`
 * (`stores/service.ts` §3.2 step 3) is the STORE-initiated one, applying the same
 * `applyInServiceChange` to every `'store_opening'` follower instead.
 */
export async function setAssetInService(
  tx: Tx,
  actor: Actor,
  assetId: string,
  input: SetAssetInServiceInput,
): Promise<SetAssetInServiceResult> {
  await authorize(tx, actor, 'manage_fixed_assets', {});

  const reason = input.reason.trim();
  if (!reason) {
    throw new Error('setAssetInService: a reason is required.');
  }

  const asset = await fixedAssetsRepo.getById(tx, actor.orgId, assetId);
  if (!asset) {
    throw new Error(`setAssetInService: asset ${assetId} does not exist in this organisation.`);
  }
  if (asset.status !== 'active') {
    throw new Error(`setAssetInService: ${asset.name} is ${asset.status}; only an active asset's in-service date can be changed.`);
  }

  const target = await resolveMode(tx, actor.orgId, asset, input);
  return applyInServiceChange(tx, actor, asset, target, reason, input.confirmedPlan);
}
