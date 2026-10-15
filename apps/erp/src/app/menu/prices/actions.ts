'use server';

/**
 * Server actions for /menu/prices (T-401 S4). docs/tasks/401-erp-menu-catalog-master.md section 5, R5, R15.
 *
 * A price is never typed into a URL (T-380): the store rides as the nav value, nothing else. The gate (`set_menu_price`, scoped
 * to the store) lives INSIDE the domain function. Money, percent and quantity stay TEXT all the way to the domain.
 *
 * "From now" never sends the client clock: an empty `effectiveFrom` box sends nothing and the database's `now()` decides.
 * A typed time is read as Asia/Manila wall-clock (`manilaInstant`) and stored as an instant. Each action redirects for itself
 * (guard G1b: no wrapper redirects).
 */
import {
  cancelScheduledOffer,
  cancelScheduledOptionOffer,
  setMenuOffer,
  setOptionOffer,
  withdrawMenuOffer,
} from '@shareat/domain';
import type { MenuChannel, MenuPricingMode } from '@shareat/db/schema';
import { refuse } from '@shareat/db';
import { requireActor } from '../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { isUuid, manilaInstant, menuErrorMessage, opt, requireId, str, wholeNumber, withOrgPrincipal } from '../lib';

const PATH = '/menu/prices';
const CHOOSE_STORE = 'Choose a store.';

export async function setPriceAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  const scheduled = opt(fd, 'effectiveFrom') !== undefined;
  try {
    const variantId = requireId(fd, 'variantId', 'Choose a variant.');
    const pricingMode = opt(fd, 'pricingMode');
    const amount = opt(fd, 'amount');
    const markupPercent = opt(fd, 'markupPercent');
    const fixedMarkupAmount = opt(fd, 'fixedMarkupAmount');
    const bundleHeads = wholeNumber(fd, 'bundleHeads', 'The number of guests in a bundle');
    const extraHeadAmount = opt(fd, 'extraHeadAmount');
    const effectiveFrom = manilaInstant(opt(fd, 'effectiveFrom'));
    await withOrgPrincipal(actor.orgId, (tx) =>
      setMenuOffer(
        actor,
        {
          storeId,
          variantId,
          channel: str(fd, 'channel') as MenuChannel,
          ...(pricingMode !== undefined ? { pricingMode: pricingMode as MenuPricingMode } : {}),
          ...(amount !== undefined ? { amount } : {}),
          ...(markupPercent !== undefined ? { markupPercent } : {}),
          ...(fixedMarkupAmount !== undefined ? { fixedMarkupAmount } : {}),
          ...(bundleHeads !== undefined ? { bundleHeads } : {}),
          ...(extraHeadAmount !== undefined ? { extraHeadAmount } : {}),
          ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
        },
        tx,
      ),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: scheduled ? 'Price scheduled.' : 'Price saved.' });
}

export async function withdrawPriceAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  try {
    const variantId = requireId(fd, 'variantId', 'Choose a variant.');
    const effectiveFrom = manilaInstant(opt(fd, 'effectiveFrom'));
    await withOrgPrincipal(actor.orgId, (tx) =>
      withdrawMenuOffer(actor, { storeId, variantId, channel: str(fd, 'channel') as MenuChannel, ...(effectiveFrom !== undefined ? { effectiveFrom } : {}) }, tx),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: 'Price withdrawn.' });
}

export async function cancelScheduledPriceAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  try {
    const id = requireId(fd, 'offerId', 'Choose which scheduled price to cancel.');
    await withOrgPrincipal(actor.orgId, (tx) => cancelScheduledOffer(actor, { id, storeId }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: 'Scheduled price cancelled.' });
}

/** `priceDelta` is signed text. Blank WITHOUT `withdraw=1` is an error, never a silent withdrawal. */
export async function setOptionPriceAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  const withdrawing = str(fd, 'withdraw') === '1';
  try {
    const optionValueId = requireId(fd, 'optionValueId', 'Choose an option.');
    const priceDelta = withdrawing ? null : opt(fd, 'priceDelta');
    if (priceDelta === undefined) {
      throw refuse('setOptionPriceAction: priceDelta is blank and withdraw is not set.', 'Enter the price change (0.00 for none), or choose Withdraw to stop offering the option.');
    }
    const effectiveFrom = manilaInstant(opt(fd, 'effectiveFrom'));
    await withOrgPrincipal(actor.orgId, (tx) =>
      setOptionOffer(actor, { storeId, optionValueId, channel: str(fd, 'channel') as MenuChannel, priceDelta, ...(effectiveFrom !== undefined ? { effectiveFrom } : {}) }, tx),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: withdrawing ? 'Option price withdrawn.' : 'Option price saved.' });
}

export async function cancelScheduledOptionPriceAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  try {
    const id = requireId(fd, 'optionOfferId', 'Choose which scheduled price to cancel.');
    await withOrgPrincipal(actor.orgId, (tx) => cancelScheduledOptionOffer(actor, { id, storeId }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: 'Scheduled price cancelled.' });
}
