/**
 * Fixed assets open at NET BOOK VALUE (bible row 109). T-390 S3, R10, R8, R13.
 *
 * This is the missing domain caller of `fixedAssetsRepo.valuateShell` (T-347 named the gap): a `pending_valuation` shell gets its
 * book value as `cost`, the conversion date as `acquired_on` (so depreciation starts there, not at the original purchase), and its
 * REMAINING life. Accumulated depreciation therefore opens at zero.
 */
import { cutoverRepo, fixedAssetsRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { compare, ZERO } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import { gone, refuse, RefusalError } from '../shared/refusal';
import { CONVERSION_DATE } from './tie-out';
import { assertFieldRules } from '../shared/field-rules-assert';
import { CUTOVER_ASSET_RULES } from '../field-rules/cutover';

export interface ValueOpeningAssetInput {
  assetId: string;
  bookValue: string;
  remainingLifeMonths: number;
  salvageValue?: string;
}

export async function valueOpeningAsset(tx: Tx | null, actor: Actor, input: ValueOpeningAssetInput): Promise<void> {
  const run = async (trx: Tx) => {
    const asset = await cutoverRepo.assetOf(trx, actor.orgId, input.assetId);
    if (!asset) throw gone(`valueOpeningAsset: asset ${input.assetId} does not exist.`, 'asset');
    await authorize(trx, actor, 'run_cutover', { storeId: asset.storeId });
    // T-440 S9 (ii): the screen's own rules, only once the gate has passed.
    assertFieldRules(CUTOVER_ASSET_RULES, {
      bookValue: input.bookValue,
      remainingLifeMonths: String(input.remainingLifeMonths),
      salvageValue: input.salvageValue,
    });

    // R13: the shared lock BEFORE the R8 check, so C5 (exclusive) cannot post between the check and the write.
    await cutoverRepo.lockOpeningShared(trx, actor.orgId);
    if (!(await cutoverRepo.c2Performed(trx, actor.orgId))) {
      throw refuse(
        'valueOpeningAsset: the purge (C2) has not been recorded as performed.',
        'The purge (C2) has not run. It deletes every journal entry, so a figure entered now would be lost.',
      );
    }
    const opened = await cutoverRepo.openingPosted(trx, actor.orgId);
    if (opened.posted) {
      throw refuse(
        'valueOpeningAsset: a posted opening_balance entry exists.',
        `The books were opened on ${opened.entryDate}. A correction is now a reversal or an ordinary stock document.`,
      );
    }
    if (asset.status !== 'pending_valuation') {
      throw refuse(
        `valueOpeningAsset: asset ${input.assetId} is ${asset.status}, not pending_valuation.`,
        `${asset.name} is not waiting for a value. Only an asset still to be valued can be given its opening book value.`,
      );
    }

    const bookValue = parseMoneyInput(input.bookValue, 'valueOpeningAsset: the book value', 'The book value');
    if (compare(bookValue, ZERO) <= 0) {
      throw refuse('valueOpeningAsset: the book value must be greater than zero.', 'The book value has to be greater than zero.');
    }
    const life = input.remainingLifeMonths;
    if (!Number.isInteger(life) || life < 1 || life > 600) {
      throw refuse(
        `valueOpeningAsset: the remaining life ${life} is not a whole number of months from 1 to 600.`,
        'The remaining life has to be a whole number of months, from 1 to 600.',
      );
    }
    const salvageValue = input.salvageValue?.trim()
      ? parseMoneyInput(input.salvageValue, 'valueOpeningAsset: the salvage value', 'The salvage value')
      : ZERO;

    if (compare(salvageValue, bookValue) >= 0) {
      throw refuse(
        'valueOpeningAsset: the salvage value is not below the book value.',
        'The salvage value has to be less than the book value.',
      );
    }

    try {
      await fixedAssetsRepo.valuateShell(trx, actor.orgId, input.assetId, {
        acquiredOn: CONVERSION_DATE,
        cost: bookValue,
        salvageValue,
        usefulLifeMonths: life,
      });
    } catch (e) {
      // Lost a race on the shell's status: somebody valued or disposed of it between the read above and this write.
      if (e instanceof RefusalError) {
        throw refuse(
          `valueOpeningAsset: asset ${input.assetId} changed state before it could be valued.`,
          `${asset.name} was valued or removed by someone else a moment ago. Reload the list and check it.`,
        );
      }
      throw e;
    }
  };
  if (tx) return run(tx);
  return transaction(run);
}
