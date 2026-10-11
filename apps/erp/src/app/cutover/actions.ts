'use server';

/**
 * Server actions for the cutover screens. T-134.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ **No rule is enforced here** —
 * `attestStep` refuses a verified step and `authorize()` gates the capability, both in the domain.
 * A gate in a server action protects one caller; a gate in the domain protects every caller there
 * will ever be.
 */
import { type Tx } from '@shareat/db';
import {
  addOpeningFigure,
  attestStep,
  postOpeningBalances,
  recordOpeningCount,
  removeOpeningFigure,
  valueOpeningAsset,
  valueOpeningStock,
} from '@shareat/domain';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { CUTOVER_COUNT } from './count/typed-forms';
import { recordingRefusalsFor, withOrgPrincipal } from '../expenses/lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function attestStepAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const stepCode = str(formData, 'stepCode');
  const storeId = str(formData, 'storeId');
  // The page that holds the form says where to come back to; only a /cutover screen is honoured.
  const back = str(formData, 'returnTo');
  const home = /^\/cutover(\/[a-z-]+)*$/.test(back) ? back : '/cutover';
  try {
    await recordingRefusalsFor(actor.orgId, () =>
      withOrgPrincipal(actor.orgId, (tx: Tx) =>
        attestStep(tx, actor, {
          stepCode,
          storeId: storeId || null,
          note: str(formData, 'note') || null,
        }),
      ),
    );
  } catch (err) {
    return await redirectWithFlash(home, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(home, {});
}

export async function recordCountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const quantity = str(formData, 'quantity');
  const unitCost = str(formData, 'unitCost');
  const itemId = str(formData, 'itemId');
  // T-390 R1 / DEF-630: the count belongs to a ROOM. Blank = the store's default room (the domain's rule).
  const locationId = str(formData, 'locationId');
  const nav = locationId ? { store: storeId, room: locationId } : { store: storeId };
  try {
    await recordingRefusalsFor(actor.orgId, () =>
      withOrgPrincipal(actor.orgId, (tx: Tx) =>
        recordOpeningCount(tx, actor, {
          storeId,
          locationId: locationId || null,
          itemId,
          // ⭐ An empty box is NOT a zero. The form only submits a row someone actually typed in, so
          // an item nobody counted stays uncounted and keeps showing as missing.
          quantity,
          unitCost: unitCost || null,
          costSource: unitCost ? 'typed' : null,
        }),
      ),
    );
  } catch (err) {
    return await redirectWithFlash('/cutover/count', nav, { error: errorMessage(err), typed: keepTyping(formData, CUTOVER_COUNT, `${itemId}:${locationId}`, { actorId: actor.personId }) });
  }
  return await redirectWithFlash('/cutover/count', nav);
}

export async function addOpeningFigureAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await recordingRefusalsFor(actor.orgId, () =>
      withOrgPrincipal(actor.orgId, (tx: Tx) =>
        addOpeningFigure(tx, actor, {
          accountCode: str(formData, 'accountCode'),
          storeId: str(formData, 'storeId'),
          direction: str(formData, 'direction') === 'credit' ? 'credit' : 'debit',
          amount: str(formData, 'amount'),
          entryDate: str(formData, 'entryDate'),
          memo: str(formData, 'memo') || null,
          // R12: the control accounts (2110, 1210, ...) take the party; the domain says which ones require it.
          partyType: str(formData, 'partyType') || null,
          partyId: str(formData, 'partyId') || null,
        }),
      ),
    );
  } catch (err) {
    return await redirectWithFlash('/cutover/opening', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/cutover/opening', {});
}

export async function removeOpeningFigureAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await recordingRefusalsFor(actor.orgId, () =>
      withOrgPrincipal(actor.orgId, (tx: Tx) => removeOpeningFigure(tx, actor, { entryId: str(formData, 'entryId') })),
    );
  } catch (err) {
    return await redirectWithFlash('/cutover/opening', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/cutover/opening', {});
}

/**
 * ⛔ The one irreversible button in the application.
 *
 * It refuses on a residual, and the residual has been on screen the whole time the figures were
 * being entered — so this is never the moment anybody first learns the books do not balance.
 */
export async function postOpeningBalancesAction(): Promise<void> {
  const actor = await requireActor();
  try {
    await recordingRefusalsFor(actor.orgId, () => withOrgPrincipal(actor.orgId, (tx: Tx) => postOpeningBalances(tx, actor)));
  } catch (err) {
    return await redirectWithFlash('/cutover/opening', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/cutover/opening', {}, { posted: '1' });
}

/** T-390 R5: write (or rewrite) the store's generated 1310/1320/1330 draft from the count. A refusal reaches the flash in words. */
export async function valueOpeningStockAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  try {
    await recordingRefusalsFor(actor.orgId, () =>
      withOrgPrincipal(actor.orgId, (tx: Tx) => valueOpeningStock(tx, actor, { storeId })),
    );
  } catch (err) {
    return await redirectWithFlash('/cutover/opening', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/cutover/opening', {});
}

/** T-390 R10: value one pending shell at book value. The life arrives as TEXT and goes to the domain as a Number, never parseInt (a fraction must be refused, not truncated). */
export async function valueOpeningAssetAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const life = str(formData, 'remainingLifeMonths');
  try {
    await recordingRefusalsFor(actor.orgId, () =>
      withOrgPrincipal(actor.orgId, (tx: Tx) =>
        valueOpeningAsset(tx, actor, {
          assetId: str(formData, 'assetId'),
          bookValue: str(formData, 'bookValue'),
          // Plain digits only: Number() would accept '1e2' and '0x10'. Anything else goes to the domain as NaN and is refused in words.
          remainingLifeMonths: /^\d+$/.test(life) ? Number(life) : Number.NaN,
          salvageValue: str(formData, 'salvageValue') || '0',
        }),
      ),
    );
  } catch (err) {
    return await redirectWithFlash('/cutover/opening', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/cutover/opening', {});
}
