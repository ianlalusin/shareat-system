/**
 * Posting depreciation. docs/tasks/124-fixed-assets-and-depreciation.md §4, §5.
 *
 * ## ⭐ This is the DEF-044 answer, and it is a shape rather than a repair script
 *
 * v1's depreciation stopped for two months and nobody noticed. Two things made that possible, and
 * both are designed out here rather than monitored:
 *
 *   1. **Nothing was idempotent**, so "catching up" meant a careful one-off script that had to
 *      know exactly which months were missing. Here every posting is idempotent on
 *      `asset:{id}:depreciation:{period}`, so **catching up is running the same thing again** —
 *      already-posted periods no-op and missing ones post. There is no catch-up code path,
 *      because there is no difference between catching up and running.
 *   2. **The register was maintained rather than derived**, so it looked correct while the
 *      scheduler was dead. Nothing here writes an accumulated-depreciation column, because there
 *      isn't one — `fixedAssetsRepo.accumulatedFromLedger` reads it back out of the journal.
 *
 * ⚠️ Re-running an old month after its fiscal period has CLOSED is safe, and deliberately so:
 * `postEntry` checks the idempotency key **before** it resolves the period, so an already-posted
 * period is a cheap no-op rather than a "period is closed" error. A genuinely missed month in a
 * closed period still refuses, which is correct — that one needs a human and a decision.
 *
 * ## What v1 got wrong here that is fixed by construction
 *
 * v1 iterated `status == 'active'` with **no check that the asset existed yet** in the month being
 * processed, so backdating a run charged assets bought later. `periodDue` cannot do that: the
 * schedule starts at `acquiredOn`, so a period before acquisition simply is not in it.
 */
import { authorize, type Actor } from '@shareat/auth';
import { fixedAssetsRepo, transaction, type Tx } from '@shareat/db';
import { money } from '@shareat/core/money';
import { postEntry } from '../ledger/post-entry';
import { periodsThrough, type ScheduleInput } from './schedule';

/** DR — the P&L charge. */
const DEPRECIATION_EXPENSE_CODE = '6700';
/** CR — the contra-asset. ⚠️ NOT a credit to 1510: cost stays visible at cost for the asset's
 *  whole life, and netting them would destroy the one figure an auditor asks for first (spec §5). */
const ACCUMULATED_DEPRECIATION_CODE = '1590';

export interface DepreciationPosting {
  assetId: string;
  period: string;
  entryDate: string;
  amount: string;
  journalEntryId: string;
  /** False when this period was already posted — the idempotent no-op, not a failure. */
  created: boolean;
}

export interface RunDepreciationInput {
  /** `YYYY-MM`. Every owed period up to AND INCLUDING this one is posted. */
  through: string;
  storeId?: string;
}

export interface RunDepreciationResult {
  posted: DepreciationPosting[];
  /** Assets the run could not complete, with the reason. ⭐ Collected rather than thrown so one
   *  asset in a closed period cannot stop every other asset from being charged — *"a missed
   *  period surfaces as a finding, not silence"* (spec invariant 6). */
  failed: { assetId: string; assetName: string; error: string }[];
  /** Assets considered but owing nothing for any period through `through`. */
  skipped: number;
}

/** The schedule inputs for an asset, or `null` if it cannot have one (a `pending_valuation`
 *  shell has neither cost nor acquisition date). */
function scheduleInputFor(asset: fixedAssetsRepo.FixedAssetRow): ScheduleInput | null {
  if (!asset.acquiredOn || !asset.cost) return null;
  return {
    acquiredOn: asset.acquiredOn,
    cost: money(asset.cost),
    salvageValue: money(asset.salvageValue ?? '0'),
    usefulLifeMonths: asset.usefulLifeMonths,
    interval: asset.interval,
  };
}

/**
 * Post every period one asset owes, through `through`.
 *
 * Returns one entry per period — including the ones that were already posted, marked
 * `created: false`, so a caller can tell "nothing was owed" from "three months were caught up".
 */
export async function depreciateAsset(
  tx: Tx | null,
  actor: Actor,
  input: { assetId: string; through: string },
): Promise<DepreciationPosting[]> {
  if (tx) return runForAsset(tx, actor, input);
  return transaction((trx) => runForAsset(trx, actor, input));
}

async function runForAsset(
  tx: Tx,
  actor: Actor,
  input: { assetId: string; through: string },
): Promise<DepreciationPosting[]> {
  await authorize(tx, actor, 'run_depreciation', {});

  const asset = await fixedAssetsRepo.getById(tx, actor.orgId, input.assetId);
  if (!asset) {
    throw new Error(
      `depreciateAsset: asset ${input.assetId} does not exist in org ${actor.orgId}`,
    );
  }
  if (asset.status !== 'active') {
    // Not an error. A disposed asset stops depreciating (spec invariant 4) and a shell has no
    // terms to depreciate on — both are "owes nothing", not "something went wrong".
    return [];
  }

  return postPeriodsFor(tx, actor, asset, input.through);
}

async function postPeriodsFor(
  tx: Tx,
  actor: Actor,
  asset: fixedAssetsRepo.FixedAssetRow,
  through: string,
): Promise<DepreciationPosting[]> {
  const scheduleInput = scheduleInputFor(asset);
  if (!scheduleInput) return [];

  const owed = periodsThrough(scheduleInput, through);
  const results: DepreciationPosting[] = [];

  for (const period of owed) {
    const result = await postEntry(tx, {
      orgId: actor.orgId,
      // The LAST day of the period, so a charge always lands inside the period it describes.
      entryDate: period.entryDate,
      sourceType: 'depreciation',
      // ⭐ The ASSET, not the category (bible row 140). This is what makes accumulated
      // depreciation derivable per asset, and with it the whole no-stored-column design.
      sourceId: asset.id,
      idempotencyKey: `asset:${asset.id}:depreciation:${period.period}`,
      memo: `Depreciation ${period.period} — ${asset.name}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: DEPRECIATION_EXPENSE_CODE,
          storeId: asset.storeId,
          debit: String(period.amount),
          credit: '0',
          lineMemo: asset.name,
        },
        {
          accountCode: ACCUMULATED_DEPRECIATION_CODE,
          storeId: asset.storeId,
          debit: '0',
          credit: String(period.amount),
          lineMemo: asset.name,
        },
      ],
    });

    results.push({
      assetId: asset.id,
      period: period.period,
      entryDate: period.entryDate,
      amount: String(period.amount),
      journalEntryId: result.entryId,
      created: result.created,
    });
  }

  return results;
}

/**
 * The org-wide run: every active asset, every period it owes through `through`.
 *
 * ⚠️ **Transaction semantics are the caller's choice, and they are not the same choice.**
 * Passing `null` gives each asset its OWN transaction, so one asset failing (a genuinely missed
 * month in a closed period, most likely) does not roll back the assets that succeeded — which is
 * what you want from a scheduled monthly run. Passing an open `tx` makes the whole run atomic,
 * which is what you want from a test or from a larger unit of work.
 *
 * v1 chose all-or-nothing for the whole month deliberately, to avoid *"a weird half-depreciated
 * state"*. That reasoning applied to v1 because its register was a maintained column that a
 * partial run left inconsistent. Here the register is derived from the ledger, so a partial run
 * is not inconsistent — it is simply incomplete, and the incompleteness is visible in the result
 * and re-runnable. The failure v1 was protecting against cannot occur.
 */
export async function runDepreciation(
  tx: Tx | null,
  actor: Actor,
  input: RunDepreciationInput,
): Promise<RunDepreciationResult> {
  const assets = tx
    ? await loadDepreciable(tx, actor, input)
    : await transaction((trx) => loadDepreciable(trx, actor, input));

  const posted: DepreciationPosting[] = [];
  const failed: RunDepreciationResult['failed'] = [];
  let skipped = 0;

  for (const asset of assets) {
    try {
      const results = tx
        ? await postPeriodsFor(tx, actor, asset, input.through)
        : await transaction((trx) => postPeriodsFor(trx, actor, asset, input.through));
      if (results.length === 0) skipped += 1;
      posted.push(...results);
    } catch (err) {
      if (tx) throw err; // Atomic mode: the caller asked for all-or-nothing, so give it.
      failed.push({
        assetId: asset.id,
        assetName: asset.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { posted, failed, skipped };
}

async function loadDepreciable(
  tx: Tx,
  actor: Actor,
  input: RunDepreciationInput,
): Promise<fixedAssetsRepo.FixedAssetRow[]> {
  await authorize(tx, actor, 'run_depreciation', {});
  const all = await fixedAssetsRepo.listDepreciable(tx, actor.orgId);
  return input.storeId ? all.filter((a) => a.storeId === input.storeId) : all;
}

/**
 * What the ledger SHOULD show against what it DOES — the reconciliation T-135's OIL findings read.
 *
 * ⭐ This comparison is only possible because accumulated depreciation is derived. In v1 the
 * "expected" and "actual" were the same maintained column, so comparing them proved only that a
 * number equals itself — which is exactly why a two-month outage was invisible.
 */
export async function depreciationDrift(
  tx: Tx | null,
  actor: Actor,
  input: { through: string },
): Promise<{ assetId: string; assetName: string; expected: string; actual: string }[]> {
  if (tx) return runDrift(tx, actor, input);
  return transaction((trx) => runDrift(trx, actor, input));
}

async function runDrift(
  tx: Tx,
  actor: Actor,
  input: { through: string },
): Promise<{ assetId: string; assetName: string; expected: string; actual: string }[]> {
  // ⚠️ `view_trial_balance`, NOT `view_financial_reports` — the latter is STORE-scoped
  // (capabilities.ts:189) and this report spans the whole org, so it has no storeId to offer.
  // Passing one store's id to satisfy the signature would have quietly narrowed an org-wide
  // reconciliation to a single store, which is the exact shape of a report that looks clean
  // because it is not looking everywhere.
  await authorize(tx, actor, 'view_trial_balance', {});

  const assets = await fixedAssetsRepo.listDepreciable(tx, actor.orgId);
  const actuals = await fixedAssetsRepo.accumulatedByAsset(tx, actor.orgId);
  const drift: { assetId: string; assetName: string; expected: string; actual: string }[] = [];

  for (const asset of assets) {
    const scheduleInput = scheduleInputFor(asset);
    if (!scheduleInput) continue;
    const owed = periodsThrough(scheduleInput, input.through);
    const expected = owed.length === 0 ? money('0') : owed[owed.length - 1]!.accumulatedAfter;
    const actual = money(actuals.get(asset.id) ?? '0');
    if (String(expected) !== String(actual)) {
      drift.push({
        assetId: asset.id,
        assetName: asset.name,
        expected: String(expected),
        actual: String(actual),
      });
    }
  }

  return drift;
}
