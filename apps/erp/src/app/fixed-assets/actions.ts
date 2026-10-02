'use server';

/**
 * Server actions for the fixed-asset screens.
 * docs/tasks/124-fixed-assets-and-depreciation.md §6.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. **No business rule is
 * re-implemented here** — `createAsset` / `depreciateAsset` / `runDepreciation` / `disposeAsset`
 * own every invariant, including the policy refusal and the salvage-below-cost check.
 *
 * ⭐ **The actor comes from `requireActor()`, never from the form** (T-138, bible §7.1). Nothing
 * here reads a person id out of client input, and `tests/unit/no-client-supplied-actor.test.ts`
 * fails the build if it ever does.
 */
import { redirect } from 'next/navigation';
import {
  createAsset,
  disposeAsset,
  runDepreciation,
  setAssetInService,
  updateAssetTerms,
  type DepreciationInterval,
} from '@shareat/domain';
import { fixedAssetsRepo, type AssetCategory } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { recordingRefusalsFor } from '../expenses/lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function carryQs(fd: FormData): string {
  const params = new URLSearchParams();
  const store = str(fd, 'filterStore');
  if (store) params.set('store', store);
  return params.toString();
}

export async function createAssetAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const qs = carryQs(formData);
  let newId: string;

  try {
    const storeId = str(formData, 'storeId');
    if (!storeId) throw new Error('Choose a store.');

    const lifeRaw = str(formData, 'usefulLifeMonths');
    const salvageRaw = str(formData, 'salvageValue');
    // T-346 S2 (DEF-427), §3.6 / Amendment R4.6 — the default radio sends NO source at all, so
    // migration 0163's own fill trigger infers 'store_opening' vs 'acquired' at insert time; only
    // an explicit 'acquired' or 'set' choice overrides that (never a fallback to 'acquired' here).
    const inServiceModeRaw = str(formData, 'inServiceMode');
    const inServiceSource: fixedAssetsRepo.InServiceSource | undefined =
      inServiceModeRaw === 'acquired' || inServiceModeRaw === 'set' ? inServiceModeRaw : undefined;

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createAsset(tx, actor, {
        storeId,
        name: str(formData, 'name'),
        category: str(formData, 'category') as AssetCategory,
        acquiredOn: str(formData, 'acquiredOn'),
        cost: str(formData, 'cost'),
        // Blank means "use the default" — the domain resolves category default, then 24 months.
        // Sending 0 instead would be a different thing entirely, and it would be refused.
        usefulLifeMonths: lifeRaw === '' ? null : Number(lifeRaw),
        salvageValue: salvageRaw === '' ? null : salvageRaw,
        interval: (str(formData, 'interval') || 'monthly') as DepreciationInterval,
        notes: str(formData, 'notes') || null,
        inServiceSource,
        inServiceOn: inServiceSource === 'set' ? str(formData, 'inServiceOn') : undefined,
      }),
    );
    newId = result.id;
  } catch (err) {
    redirect(`/fixed-assets/new?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect(`/fixed-assets/${newId}?${qs}`);
}

/**
 * Edit an asset's depreciation terms.
 *
 * ⭐ This also CLEARS `needsReview` — that is the flag's whole definition. It means "these are
 * defaults nobody has confirmed", so a human deliberately editing the terms is exactly the event
 * that makes it untrue (spec invariant 5).
 */
export async function updateTermsAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const assetId = str(formData, 'assetId');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      updateAssetTerms(tx, actor, assetId, {
        name: str(formData, 'name'),
        category: str(formData, 'category'),
        usefulLifeMonths: str(formData, 'usefulLifeMonths'),
        interval: str(formData, 'interval'),
        salvageValue: str(formData, 'salvageValue') || null,
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    redirect(`/fixed-assets/${assetId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect(`/fixed-assets/${assetId}?${qs}&ok=terms`);
}

/**
 * Correct WHEN an asset went into service. T-346 S2 (DEF-427), §3.4/§3.6.
 *
 * ⭐ The confirm step is a second submit, not a client-side dialog — the plan token (`planToken` on the
 * refusal) round-trips through the URL's `plan` param and is resubmitted as the hidden `confirmedPlan`, the same shape
 * `disposeAssetAction`'s sibling screens use nowhere else in this app because nothing else needed
 * a "this reverses N entries" checkpoint before this task. `setAssetInService`'s OWN error message
 * (the one thing that names which entries and how much) is what the confirm banner shows verbatim.
 */
export async function setAssetInServiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const assetId = str(formData, 'assetId');
  const qs = carryQs(formData);
  const mode = str(formData, 'mode') as 'acquired' | 'store_opening' | 'set';
  // The token of the plan the person confirmed (T-368 S2 / DEF-441), resubmitted from the confirm step.
  const confirmedPlan = str(formData, 'confirmedPlan') || undefined;

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setAssetInService(tx, actor, assetId, {
        mode,
        inServiceOn: mode === 'set' ? str(formData, 'inServiceOn') : undefined,
        reason: str(formData, 'reason'),
        confirmedPlan,
      }),
    );
  } catch (err) {
    const message = errorMessage(err);
    // "confirm to proceed" is `setAssetInService`'s own refusal shape (in-service.ts) — the ONE
    // string this action recognises to show a confirm checkpoint instead of a plain error.
    if (message.endsWith('confirm to proceed')) {
      const plan = (err as { planToken?: string }).planToken ?? '';
      redirect(
        `/fixed-assets/${assetId}?${qs}&confirm=${encodeURIComponent(message)}&plan=${encodeURIComponent(plan)}&mode=${mode}` +
          `&inServiceOn=${encodeURIComponent(str(formData, 'inServiceOn'))}` +
          `&reason=${encodeURIComponent(str(formData, 'reason'))}`,
      );
    }
    redirect(`/fixed-assets/${assetId}?${qs}&error=${encodeURIComponent(message)}`);
  }

  redirect(`/fixed-assets/${assetId}?${qs}&ok=inservice`);
}

export async function disposeAssetAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const assetId = str(formData, 'assetId');
  const qs = carryQs(formData);

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      disposeAsset(tx, actor, {
        assetId,
        disposedOn: str(formData, 'disposedOn'),
        reason: str(formData, 'reason'),
      }),
    );
  } catch (err) {
    redirect(`/fixed-assets/${assetId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect(`/fixed-assets/${assetId}?${qs}&ok=disposed`);
}

/**
 * Run depreciation for the whole org, through a chosen period.
 *
 * ⚠️ `null` transaction, deliberately — each asset gets its own, so one asset failing (a missed
 * month in a closed period) does not roll back every asset that succeeded. Re-running is always
 * safe: already-posted periods no-op on their idempotency key.
 */
export async function runDepreciationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const qs = carryQs(formData);
  const through = str(formData, 'through');

  let summary: string;
  let failedCount = 0;
  try {
    if (!/^\d{4}-\d{2}$/.test(through)) {
      throw new Error('Choose a month to run depreciation through.');
    }
    const result = await recordingRefusalsFor(actor.orgId, () => runDepreciation(null, actor, { through }));
    const created = result.posted.filter((p) => p.created).length;
    summary = `${created} posted, ${result.posted.length - created} already done, ${result.skipped} not due`;
    if (result.skippedClosed > 0) {
      // Owed, not "not due": the month is closed, so it is booked from the missed-months list instead.
      summary += ` — ${result.skippedClosed} month(s) fall in a closed month — book them from Findings (missed months).`;
    }
    if (result.failed.length > 0) {
      // Surfaced, never swallowed — "a missed period surfaces as a finding, not silence".
      failedCount = result.failed.length;
      summary += ` — ${result.failed.length} failed: ${result.failed
        .map((f) => `${f.assetName} (${f.error})`)
        .join('; ')}`;
    }
  } catch (err) {
    redirect(`/fixed-assets?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect(`/fixed-assets?${qs}&ran=${encodeURIComponent(summary)}&failed=${failedCount}`);
}
