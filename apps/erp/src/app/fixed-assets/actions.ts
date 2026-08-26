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
  type DepreciationInterval,
} from '@shareat/domain';
import { fixedAssetsRepo, type AssetCategory } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    await withOrgPrincipal(actor.orgId, async (tx) => {
      // The capability check lives in the domain for every OTHER verb; this one writes through
      // the repo directly, so it authorizes here. Same capability, same scope.
      const { authorize } = await import('@shareat/auth');
      await authorize(tx, actor, 'manage_fixed_assets', {});
      await fixedAssetsRepo.updateTerms(tx, actor.orgId, assetId, {
        name: str(formData, 'name'),
        category: str(formData, 'category') as AssetCategory,
        usefulLifeMonths: Number(str(formData, 'usefulLifeMonths')),
        interval: str(formData, 'interval') as fixedAssetsRepo.DepreciationIntervalValue,
        salvageValue: str(formData, 'salvageValue') || null,
        notes: str(formData, 'notes') || null,
      });
    });
  } catch (err) {
    redirect(`/fixed-assets/${assetId}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect(`/fixed-assets/${assetId}?${qs}&ok=terms`);
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
    const result = await runDepreciation(null, actor, { through });
    const created = result.posted.filter((p) => p.created).length;
    summary = `${created} posted, ${result.posted.length - created} already done, ${result.skipped} not due`;
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
