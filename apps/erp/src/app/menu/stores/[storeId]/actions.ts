'use server';

/**
 * Server actions for /menu/stores/[storeId] (T-632). docs/tasks/632-store-menu-screen.md.
 *
 * Thin adapters: the store rides in the path and a hidden field, money stays TEXT, and the gate (`set_menu_price` at the store) lives INSIDE
 * the domain switches, which run each switch in one transaction. A switch never sends the client clock: it takes effect now.
 */
import { assertFieldRules, switchOptionValue, switchVariantOff, switchVariantOn, type SwitchPrice } from '@shareat/domain';
import { authorize, can } from '@shareat/auth';
import { MENU_OPTION_PRICE_RULES, MENU_PRICE_RULES } from '@shareat/domain/field-rules';
import { refuse } from '@shareat/db';
import { requireActor } from '../../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { isUuid, menuErrorMessage, opt, requireId, str, withOrgPrincipal } from '../../lib';

const CHOOSE_STORE = 'Choose a store.';
const pathOf = (storeId: string): string => `/menu/stores/${storeId}`;

/**
 * The price rows of the dialog: `slot` (a daypart id, or `all`), `amount`, `bundle` and `extra` repeat once per row, in the same order,
 * so the Nth of each belongs to the Nth row. A blank is a blank (`amount` blank = not sold at that time).
 */
function pricesOf(fd: FormData): SwitchPrice[] {
  const text = (key: string): string[] => fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
  const [slots, amounts, bundles, extras] = [text('slot'), text('amount'), text('bundle'), text('extra')];
  return slots.map((slot, i) => {
    if (slot !== 'all' && !isUuid(slot)) throw refuse('storeMenu: slot is not an id.', 'Reload the page and try again.');
    const amount = amounts[i] || undefined;
    const heads = bundles[i] || undefined;
    const extra = extras[i] || undefined;
    return {
      daypartId: slot === 'all' ? null : slot,
      ...(amount !== undefined ? { amount } : {}),
      ...(heads !== undefined ? { bundleHeads: Number(heads) } : {}),
      ...(extra !== undefined ? { extraHeadAmount: extra } : {}),
    };
  });
}

export async function switchOnAction(fd: FormData): Promise<void> {
  const storeId = str(fd, 'storeId');
  const actor = await requireActor(isUuid(storeId) ? pathOf(storeId) : '/menu');
  if (!isUuid(storeId)) return await redirectWithFlash('/menu', {}, { error: CHOOSE_STORE });
  const path = pathOf(storeId);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, 'set_menu_price', { storeId }));
    const variantId = requireId(fd, 'variantId', 'Choose a variant.');
    const prices = pricesOf(fd);
    await withOrgPrincipal(actor.orgId, async (tx) => {
      // The field check runs only for a caller the domain's own gate lets in (T-440 S9 iii); anyone else is refused by that gate first.
      if (await can(tx, actor, 'set_menu_price', { storeId })) {
        for (const p of prices) assertFieldRules(MENU_PRICE_RULES, { amount: p.amount ?? '', bundleHeads: p.bundleHeads === undefined ? '' : String(p.bundleHeads), extraHeadAmount: p.extraHeadAmount ?? '' });
      }
      return switchVariantOn(actor, { storeId, variantId, prices }, tx);
    });
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: opt(fd, 'changing') === '1' ? 'Prices saved.' : 'Switched on.' });
}

export async function switchOffAction(fd: FormData): Promise<void> {
  const storeId = str(fd, 'storeId');
  const actor = await requireActor(isUuid(storeId) ? pathOf(storeId) : '/menu');
  if (!isUuid(storeId)) return await redirectWithFlash('/menu', {}, { error: CHOOSE_STORE });
  const path = pathOf(storeId);
  try {
    const variantId = requireId(fd, 'variantId', 'Choose a variant.');
    await withOrgPrincipal(actor.orgId, (tx) => switchVariantOff(actor, { storeId, variantId }, tx));
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Switched off. Past sales are kept.' });
}

/** A flavour row posts this with `mode` = on (needs the price change) or off. */
export async function flavourAction(fd: FormData): Promise<void> {
  const storeId = str(fd, 'storeId');
  const actor = await requireActor(isUuid(storeId) ? pathOf(storeId) : '/menu');
  if (!isUuid(storeId)) return await redirectWithFlash('/menu', {}, { error: CHOOSE_STORE });
  const path = pathOf(storeId);
  const on = str(fd, 'mode') === 'on';
  try {
    const optionValueId = requireId(fd, 'optionValueId', 'Choose a flavour.');
    const priceDelta = opt(fd, 'priceDelta');
    await withOrgPrincipal(actor.orgId, async (tx) => {
      if (on && (await can(tx, actor, 'set_menu_price', { storeId }))) assertFieldRules(MENU_OPTION_PRICE_RULES, fd);
      return switchOptionValue(actor, { storeId, optionValueId, on, ...(priceDelta !== undefined ? { priceDelta } : {}) }, tx);
    });
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: on ? 'Flavour saved.' : 'Flavour switched off.' });
}
