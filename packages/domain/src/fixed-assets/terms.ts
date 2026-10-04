/**
 * updateAssetTerms - edit an asset's name, category, notes and (until a month is posted) its depreciation
 * terms. T-368 S3 (DEF-436).
 *
 * The WHOLE rule lives here; `updateTermsAction` only calls this. Until now the action authorised and wrote
 * through the repo itself, so the "terms are fixed once depreciation is posted" rule was held by the
 * database trigger alone and surfaced as a raw trigger error. The trigger (0174) is still the backstop.
 *
 * Order matters: `authorize` first, THEN the parse and the allowed-value checks (interval, category) - a person
 * who may not change terms must get the same refusal whatever they typed - then the asset row is read `FOR UPDATE`, the first read of the asset, which
 * is the same lock the depreciation run takes first (`postPeriodsFor`), so a terms change and a run on one
 * asset serialise: whichever commits second sees the other's result.
 */
import { authorize, type Actor } from '@shareat/auth';
import { ASSET_CATEGORIES, fixedAssetsRepo, type AssetCategory } from '@shareat/db';
import { compare, equals, money, ZERO, type Money } from '@shareat/core/money';
import type { Tx } from '@shareat/db';
import { gone, refuse } from '../shared/refusal';
import { parseDecimalInput } from '../shared/money-input';
import { DEPRECIATION_INTERVALS, type DepreciationInterval } from './schedule';

export interface UpdateAssetTermsInput {
  name: string;
  category: string;
  /** The raw text of the form field - the parse lives here, not in the action. */
  usefulLifeMonths: string;
  interval: string;
  salvageValue: string | null;
  notes: string | null;
}

export async function updateAssetTerms(
  tx: Tx,
  actor: Actor,
  assetId: string,
  input: UpdateAssetTermsInput,
): Promise<void> {
  await authorize(tx, actor, 'manage_fixed_assets', {});

  const lifeRaw = input.usefulLifeMonths.trim();
  const life = Number(lifeRaw);
  if (lifeRaw === '' || !Number.isInteger(life) || life < 1) {
    throw refuse(
      `updateAssetTerms: useful life must be a whole number of months greater than zero, got ${JSON.stringify(lifeRaw)}.`,
      'The useful life must be a whole number of months, 1 or more.',
    );
  }
  // The interval and the category arrive as raw form text: refused by NAME, never printing what was typed, and
  // before the first read, so nothing is written (the cast at the repo call below is only safe after this).
  if (!(DEPRECIATION_INTERVALS as readonly string[]).includes(input.interval)) {
    throw refuse(
      'updateAssetTerms: the depreciation interval is not one of monthly, quarterly, semiannual or annually.',
      'Choose a depreciation interval from the list: monthly, quarterly, semi-annual or annually.',
    );
  }
  if (!(ASSET_CATEGORIES as readonly string[]).includes(input.category)) {
    throw refuse('updateAssetTerms: the asset category is not one of the allowed categories.', 'Choose an asset category from the list.');
  }
  // T-371 R6: `salvage_value` is nullable, so a blank box stores null - never a guessed '0'. The brand flows to the
  // writer unconverted (no `String(...)`), so the repo receives the parsed `Money`, not a bare string.
  const salvage: Money | null = parseDecimalInput(
    input.salvageValue,
    '14,2',
    'updateAssetTerms: the salvage value',
    'The salvage value',
    { blank: 'null' },
  );

  // Refused before any read: a negative salvage is a typo, not a term (and no read can change the answer).
  if (salvage !== null && compare(salvage, ZERO) < 0) {
    throw refuse(`updateAssetTerms: salvage value ${salvage} is negative`, 'The salvage value cannot be negative.');
  }

  const asset = await fixedAssetsRepo.getByIdForUpdate(tx, actor.orgId, assetId);
  if (!asset) throw gone(`updateAssetTerms: asset ${assetId} does not exist in org ${actor.orgId}`, 'asset');

  // The same rule `createAsset` holds (and the CHECK constraint backs): salvage at or above cost means the asset
  // never depreciates. A shell row has no cost yet, so there is nothing to compare.
  if (salvage !== null && asset.cost !== null && compare(salvage, money(asset.cost)) >= 0) {
    throw refuse(
      `updateAssetTerms: salvage value ${salvage} must be below cost ${asset.cost}, or the asset never depreciates.`,
      "The salvage value must be below the asset's cost, or it never depreciates.",
    );
  }

  const posted = (await fixedAssetsRepo.postedDepreciationPeriods(tx, actor.orgId, assetId)).sort();
  if (posted.length > 0) {
    const changed =
      life !== asset.usefulLifeMonths ||
      input.interval !== asset.interval ||
      !equals(salvage ?? ZERO, money(asset.salvageValue ?? '0'));
    if (changed) {
      const first = posted[0]!;
      const last = posted[posted.length - 1]!;
      throw refuse(
        `updateAssetTerms: ${asset.name} has depreciation posted for ${first}\u2013${last}; its useful life, interval and salvage value can no longer change`,
        `${asset.name} has already been depreciated (${first} to ${last}), so its useful life, interval and salvage value can no longer be changed. Name, category and notes can still be edited.`,
      );
    }
  }

  await fixedAssetsRepo.updateTerms(tx, actor.orgId, assetId, {
    name: input.name,
    category: input.category as AssetCategory,
    usefulLifeMonths: life,
    interval: input.interval as DepreciationInterval,
    salvageValue: salvage,
    notes: input.notes,
  });
}
