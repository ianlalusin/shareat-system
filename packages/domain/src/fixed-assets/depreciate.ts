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
// ⭐ No `transaction` import, and that is the point of DEF-287: nothing in this file may open a
// transaction without saying who it is acting as.
import { fixedAssetsRepo, withOrgPrincipal, withSystemOrgPrincipal, type Tx } from '@shareat/db';
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

/**
 * The schedule inputs for an asset, or `null` if it cannot have one — a `pending_valuation` shell
 * (no cost yet), or a HELD asset (T-346 S2, DEF-427): `in_service_on IS NULL` while its store has
 * not opened, and PAS 16 says an asset depreciates from when it is available for use, not from
 * when it was bought. ⭐ **Exported (R4.1)** — T-345's `missed-months/index.ts` used to duplicate
 * this as a private `assetScheduleInput`, built from `acquired_on`; that duplicate is now this
 * function, so a held asset's catch-up correctly owes nothing too.
 */
export function scheduleInputFor(asset: fixedAssetsRepo.FixedAssetRow): ScheduleInput | null {
  if (!asset.inServiceOn || !asset.cost) return null;
  return {
    startsOn: asset.inServiceOn,
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
  // DEF-287: the no-tx fallback opens its own transaction, so it carries its own principal.
  // No caller passes null today — this is the shape being correct rather than a live fix.
  return withOrgPrincipal(actor.orgId, (trx) => runForAsset(trx, actor, input));
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
  // ⭐ THE GATE IS HERE, AT THE BOUNDARY — and it is the only difference between this and the
  // scheduled run (T-140 §2). `runDepreciationAsSystem` calls the same body below without it,
  // because a scheduler is not a person and `authorize()` answers "may this PERSON do this?".
  //
  // ⛔ One body, two entry points. Copying the loop so the scheduler could have its own is how
  // v1's two amortisation runners drifted apart until one of them grew a per-month void and the
  // other never did.
  if (tx) {
    await authorize(tx, actor, 'run_depreciation', {});
  } else {
    // ⛔ `withOrgPrincipal`, NOT a bare `transaction` — DEF-287. `authorize()` READS `persons` and
    // the grant tables, which are org-scoped and FORCE RLS. With no principal it sees nobody and
    // refuses a capability the actor genuinely holds.
    await withOrgPrincipal(actor.orgId, (trx) => authorize(trx, actor, 'run_depreciation', {}));
  }
  return runDepreciationCore(tx, 'staff', actor.orgId, actor.personId, input);
}

/**
 * ⭐ The scheduled run (T-140). Same body, no capability check, and **no invented person**.
 *
 * ⛔ Never reachable from a request handler — the only caller is the month-end CLI. The control
 * that matters is not a role grant (which would let a compromised scheduler do everything an
 * admin can) but that this entry point can do exactly one thing.
 *
 * `postedBy` is `null`: `journal_entries.posted_by` is nullable, so the ledger records *"posted by
 * no person"* honestly rather than attributing a machine's work to a human who was asleep.
 *
 * ## ⛔ "AsSystem" means TWO things, and for months it only meant one — DEF-287
 *
 * It means **no capability check and no person** (the paragraphs above), and it means **the
 * transaction runs under the system principal** (`withSystemOrgPrincipal`, below). Until
 * 2026-09-11 it only meant the first: this function opened bare, principal-less transactions, so
 * the name promised a database identity it never set. Nobody caught it because the name read as
 * if they had.
 *
 * ⚠️ **It was inert only by accident** — production connects as a role with `rolbypassrls = t`
 * (measured, DEF-250/DEF-282), so RLS was contributing nothing to any of these paths. The day
 * that role is tightened, the unfixed version of this function would have loaded **zero**
 * depreciable assets, posted nothing, and exited 0 — a silent success indistinguishable from a
 * genuinely quiet month, which is exactly the signal DEF-240's work exists to make trustworthy.
 */
export async function runDepreciationAsSystem(
  orgId: string,
  input: RunDepreciationInput,
): Promise<RunDepreciationResult> {
  return runDepreciationCore(null, 'system', orgId, null, input);
}

/**
 * ⛔ **`kind` is not decoration — it chooses the principal every transaction below opens under,
 * and getting it wrong is DEF-287.** When `tx` is null this function opens its OWN transactions
 * from the pool, so a principal applied by some caller further up does not reach them; each one
 * has to carry its own. `'staff'` for the request path, `'system'` for the scheduled run.
 *
 * ⚠️ **One transaction PER ASSET is deliberate** (T-124 §12) — one bad asset must not roll back
 * the assets that posted cleanly — which is precisely why the principal cannot be applied once
 * around the loop and forgotten.
 */
async function runDepreciationCore(
  tx: Tx | null,
  kind: 'staff' | 'system',
  orgId: string,
  postedBy: string | null,
  input: RunDepreciationInput,
): Promise<RunDepreciationResult> {
  const actor = { orgId, personId: postedBy } as Actor;
  const openTx = <R,>(fn: (trx: Tx) => Promise<R>): Promise<R> =>
    kind === 'system' ? withSystemOrgPrincipal(orgId, fn) : withOrgPrincipal(orgId, fn);

  const assets = tx
    ? await loadDepreciable(tx, actor, input)
    : await openTx((trx) => loadDepreciable(trx, actor, input));

  const posted: DepreciationPosting[] = [];
  const failed: RunDepreciationResult['failed'] = [];
  let skipped = 0;

  for (const asset of assets) {
    try {
      const results = tx
        ? await postPeriodsFor(tx, actor, asset, input.through)
        : await openTx((trx) => postPeriodsFor(trx, actor, asset, input.through));
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
  // ⚠️ No authorize() here any more — it moved to `runDepreciation`, the human boundary, so the
  // system path can share this body without a capability check it has no person to satisfy.
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
  // DEF-287, as above.
  return withOrgPrincipal(actor.orgId, (trx) => runDrift(trx, actor, input));
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
