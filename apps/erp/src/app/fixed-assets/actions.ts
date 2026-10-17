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
import {
  assertFieldRules,
  createAsset,
  disposeAsset,
  runDepreciation,
  setAssetInService,
  updateAssetTerms,
  type DepreciationInterval,
} from '@shareat/domain';
import { fixedAssetsRepo, type AssetCategory } from '@shareat/db';
import {
  ASSET_CREATE_RULES,
  ASSET_DISPOSE_RULES,
  ASSET_IN_SERVICE_CONFIRM_RULES,
  ASSET_IN_SERVICE_RULES,
  ASSET_TERMS_RULES,
} from '@shareat/domain/field-rules';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash, type Nav } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { ASSET_IN_SERVICE_EDIT, ASSET_TERMS_EDIT } from './typed-forms';
import { recordingRefusalsFor } from '../expenses/lib';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** The store filter the form came from, as a navigation key (the flash helper drops it if it is not a store id). */
function carryNav(fd: FormData): Nav {
  const store = str(fd, 'filterStore');
  return store ? { store } : {};
}

export async function createAssetAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const nav = carryNav(formData);
  let newId: string;

  try {
    // T-440: the same rule set the screen shows. In the action, not in createAsset: the domain has other callers (A6).
    assertFieldRules(ASSET_CREATE_RULES, formData);
    const storeId = str(formData, 'storeId');

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
        // T-374 S5 / DEF-584 — raw: the domain parses it after `authorize()` (`Number('0x10')` was 16).
        usefulLifeMonths: lifeRaw === '' ? null : lifeRaw,
        salvageValue: salvageRaw === '' ? null : salvageRaw,
        interval: (str(formData, 'interval') || 'monthly') as DepreciationInterval,
        notes: str(formData, 'notes') || null,
        inServiceSource,
        inServiceOn: inServiceSource === 'set' ? str(formData, 'inServiceOn') : undefined,
      }),
    );
    newId = result.id;
  } catch (err) {
    return await redirectWithFlash('/fixed-assets/new', nav, { error: errorMessage(err) });
  }

  return await redirectWithFlash(`/fixed-assets/${newId}`, nav);
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
  const nav = carryNav(formData);

  try {
    assertFieldRules(ASSET_TERMS_RULES, formData);
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
    return await redirectWithFlash(`/fixed-assets/${assetId}`, nav, { error: errorMessage(err), typed: keepTyping(formData, ASSET_TERMS_EDIT, assetId, { actorId: actor.personId }) });
  }

  return await redirectWithFlash(`/fixed-assets/${assetId}`, nav, { ok: 'terms' });
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
  const nav = carryNav(formData);
  const mode = str(formData, 'mode') as 'acquired' | 'store_opening' | 'set';
  // The token of the plan the person confirmed (T-368 S2 / DEF-441), resubmitted from the confirm step.
  const confirmedPlan = str(formData, 'confirmedPlan') || undefined;

  try {
    // The confirm step carries the plan token and only a reason; the edit form carries the date as well.
    if (confirmedPlan !== undefined) assertFieldRules(ASSET_IN_SERVICE_CONFIRM_RULES, formData);
    else assertFieldRules(ASSET_IN_SERVICE_RULES, formData);
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
      // The consent text names the entries and amounts it will reverse: it rides the flash cookie, never the
      // address. It cannot be rebuilt from `plan` (a hash of entry ids), so it is carried whole, never truncated.
      return await redirectWithFlash(`/fixed-assets/${assetId}`, nav, {
        confirm: message,
        plan,
        keep: {
          mode,
          inServiceOn: str(formData, 'inServiceOn'),
          reason: str(formData, 'reason'),
        },
      });
    }
    return await redirectWithFlash(`/fixed-assets/${assetId}`, nav, { error: message, typed: keepTyping(formData, ASSET_IN_SERVICE_EDIT, assetId, { actorId: actor.personId }) });
  }

  return await redirectWithFlash(`/fixed-assets/${assetId}`, nav, { ok: 'inservice' });
}

export async function disposeAssetAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const assetId = str(formData, 'assetId');
  const nav = carryNav(formData);

  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'fixed_asset', assetId, ['manage_fixed_assets']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'manage_fixed_assets' });
    assertFieldRules(ASSET_DISPOSE_RULES, formData);
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await disposeAsset(tx, actor, {
        assetId,
        disposedOn: str(formData, 'disposedOn'),
        reason: str(formData, 'reason'),
      });
      await recordApproval(tx, actor, approval, { capability: 'manage_fixed_assets', entityType: 'fixed_asset', entityId: assetId, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash(`/fixed-assets/${assetId}`, nav, { error: errorMessage(err) });
  }

  return await redirectWithFlash(`/fixed-assets/${assetId}`, nav, { ok: 'disposed' });
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
  const nav = carryNav(formData);
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
    return await redirectWithFlash('/fixed-assets', nav, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/fixed-assets', nav, { ran: summary, failed: String(failedCount) });
}
