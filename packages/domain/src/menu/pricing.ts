/**
 * T-401 S2 - depletion rules, offers (a store's price row) and option offers. docs/tasks/401-erp-menu-catalog-master.md R4-R6.
 *
 * All three are HISTORY: append-only, effective-dated, never UPDATEd, never back-dated. A change is a new row; the row in
 * force at time t is the newest one at or before t (`menuRepo.offersInForce`, written once in SQL). `effectiveFrom` omitted
 * means "from now" (the database's clock). A scheduled row may be cancelled until it takes effect; one in effect never goes.
 *
 * Gates: `set_menu_depletion` (org) for rules; `set_menu_price` (STORE-scoped, ctx.storeId = input.storeId) for offers and
 * option offers. Money is text, at most two decimals (I13b); an offer amount is never negative, an option delta may be.
 */
import { authorize, type Actor } from '@shareat/auth';
import { menuRepo, type Tx } from '@shareat/db';
import { MENU_CHANNELS, MENU_DEPLETION_MODES, MENU_PRICING_MODES, type MenuChannel, type MenuDepletionMode, type MenuPricingMode } from '@shareat/db/schema';
import type { Decimal } from '@shareat/core/money';
import { gone, refuse } from '../shared/refusal';
import { assertNoPlannedPullAtLinkedSwitchedStores } from '../pos/depletion-source';
import { audit, inTx, parseMarkupPercent, requireUsableRuleTarget, requireHistorySlot, parseMenuAmount, parseMenuQuantity, requireNotBackdated, requireScheduled } from './shared';

// -------------------------------------------------------------------------------------------------------------------
// Depletion rules (R6): the pos_item_maps shape, per variant, effective-dated
// -------------------------------------------------------------------------------------------------------------------
export interface SetDepletionRuleInput {
  variantId: string;
  mode: MenuDepletionMode;
  /** `direct`: the stock item consumed. */
  itemId?: string;
  /** `recipe`: the production recipe exploded. */
  recipeId?: string;
  /** Text, in the stock item's base unit, at most six decimals, above zero. Required for `direct`, optional for `recipe`, none for `no_stock`. */
  quantityPerSale?: string;
  effectiveFrom?: Date;
}

export async function setDepletionRule(actor: Actor, input: SetDepletionRuleInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'set_menu_depletion', {});
    if (!(MENU_DEPLETION_MODES as readonly unknown[]).includes(input.mode)) {
      throw refuse('setDepletionRule: mode must be direct, recipe or no_stock.', 'Choose what a sale uses: a stock item, a recipe, or nothing.');
    }
    const shapeError = (sentence: string) => refuse(`setDepletionRule: ${input.mode} - ${sentence}`, sentence);
    let itemId: string | null = null;
    let recipeId: string | null = null;
    let quantity: Decimal<'14,6'> | null = null;
    if (input.mode === 'direct') {
      if (!input.itemId || input.recipeId) throw shapeError('A stock-item rule names a stock item and no recipe.');
      if (input.quantityPerSale === undefined) throw shapeError('A stock-item rule needs the quantity used per sale.');
      itemId = input.itemId;
      quantity = parseMenuQuantity(input.quantityPerSale, 'setDepletionRule: the quantity', 'The quantity per sale');
    } else if (input.mode === 'recipe') {
      if (!input.recipeId || input.itemId) throw shapeError('A recipe rule names a recipe and no stock item.');
      recipeId = input.recipeId;
      if (input.quantityPerSale !== undefined) {
        quantity = parseMenuQuantity(input.quantityPerSale, 'setDepletionRule: the quantity', 'The quantity per sale');
      }
    } else if (input.itemId || input.recipeId || input.quantityPerSale !== undefined) {
      throw shapeError('A "uses no stock" rule names no stock item, recipe or quantity.');
    }
    await requireNotBackdated(trx, input.effectiveFrom, 'setDepletionRule', 'depletion rules');
    if (!(await menuRepo.getVariant(trx, actor.orgId, input.variantId))) {
      throw gone(`setDepletionRule: variant ${input.variantId} does not exist.`, 'variant');
    }
    await requireUsableRuleTarget(trx, actor.orgId, { itemId, recipeId }, 'setDepletionRule');
    // S5: a rule is org-wide; a store that reads the menu rules and links this variant must not have a pull in progress.
    await assertNoPlannedPullAtLinkedSwitchedStores(trx, actor.orgId, input.variantId);
    await requireHistorySlot(trx, input.variantId, { kind: 'rule', variantId: input.variantId }, input.effectiveFrom, 'setDepletionRule');
    const row = await menuRepo.insertRule(trx, {
      orgId: actor.orgId,
      variantId: input.variantId,
      effectiveFrom: input.effectiveFrom,
      mode: input.mode,
      itemId,
      recipeId,
      quantityPerSale: quantity,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_depletion_rule_set', null, row.id, null, row);
    return { id: row.id };
  });
}

/** Cancels a rule that has not taken effect. The database also refuses it if a live offer would be left with no rule in force. */
export async function cancelScheduledDepletionRule(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'set_menu_depletion', {});
    const row = await menuRepo.getRule(trx, actor.orgId, input.id);
    if (!row) throw gone(`cancelScheduledDepletionRule: rule ${input.id} does not exist.`, 'depletion rule');
    await assertNoPlannedPullAtLinkedSwitchedStores(trx, actor.orgId, row.variantId);
    await requireScheduled(trx, row.effectiveFrom, 'cancelScheduledDepletionRule', 'rule');
    await menuRepo.deleteRule(trx, row.id);
    await audit(trx, actor, 'menu_depletion_rule_cancel', null, row.id, row, null);
    return { id: row.id };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Offers (R5)
// -------------------------------------------------------------------------------------------------------------------
function requireChannel(raw: unknown, rawLabel: string): MenuChannel {
  if (!(MENU_CHANNELS as readonly unknown[]).includes(raw)) {
    throw refuse(`${rawLabel}: channel must be store or online.`, 'Choose the store (counter and tables) or online.');
  }
  return raw as MenuChannel;
}

export interface SetMenuOfferInput {
  storeId: string;
  variantId: string;
  channel: MenuChannel;
  /**
   * Text, at most two decimals, never negative. The unit price, the per-guest price of a per-head package, or the bundle
   * price when `bundleHeads` is set. Omit (or null) only for a refill, which carries no price (the database refuses a
   * missing amount on anything else).
   */
  amount?: string | null;
  /**
   * R15 (Ian, Q4), ONLINE channel only. `fixed` (default) = `amount` as typed. `percent_markup` = the store price in force at the
   * same instant x (100 + `markupPercent`) / 100; `fixed_markup` = that store price + `fixedMarkupAmount`. A rule row carries its
   * figure and no amount; the price is resolved on read (`resolveOfferPrice`), never stored.
   */
  pricingMode?: MenuPricingMode;
  /** Text, signed, at most FOUR decimals, above -100 (-10 = ten percent lower). */
  markupPercent?: string;
  /** Text, signed, at most two decimals. */
  fixedMarkupAmount?: string;
  /** A package sold as a bundle: the guests the bundle price covers. Needs `extraHeadAmount`. */
  bundleHeads?: number;
  /** Text, at most two decimals: the price per guest beyond `bundleHeads`. */
  extraHeadAmount?: string;
  effectiveFrom?: Date;
}

/** Appends a LIVE offer (the price from `effectiveFrom`). Needs a depletion rule in force for the variant (database rule R6). */
export async function setMenuOffer(actor: Actor, input: SetMenuOfferInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    const channel = requireChannel(input.channel, 'setMenuOffer');
    const pricingMode = input.pricingMode ?? 'fixed';
    if (!(MENU_PRICING_MODES as readonly unknown[]).includes(pricingMode)) {
      throw refuse('setMenuOffer: pricing mode must be fixed, fixed_markup or percent_markup.', 'Choose a fixed price, a peso markup or a percent markup.');
    }
    const isRule = pricingMode !== 'fixed';
    if (isRule && channel !== 'online') {
      throw refuse('setMenuOffer: a price rule is for the online channel only.', 'A price rule can only be set for online ordering. The store price is typed.');
    }
    if (isRule && (input.amount != null || input.bundleHeads !== undefined || input.extraHeadAmount !== undefined)) {
      throw refuse(
        'setMenuOffer: a rule row carries its figure and no amount or bundle fields.',
        'An online price rule follows the store price, so it has no price of its own. Remove the amount.',
      );
    }
    if (!isRule && (input.markupPercent !== undefined || input.fixedMarkupAmount !== undefined)) {
      throw refuse('setMenuOffer: markup figures need a markup pricing mode.', 'A markup figure only applies to an online price rule.');
    }
    let markupPercent: Decimal<'8,4'> | null = null;
    let fixedMarkupAmount: Decimal<'14,2'> | null = null;
    if (pricingMode === 'percent_markup') {
      if (input.fixedMarkupAmount !== undefined || input.markupPercent === undefined) {
        throw refuse('setMenuOffer: percent_markup needs markupPercent and no fixedMarkupAmount.', 'Enter the percent to add to (or, negative, take off) the store price.');
      }
      markupPercent = parseMarkupPercent(input.markupPercent, 'setMenuOffer: the markup percent', 'The markup percent');
    } else if (pricingMode === 'fixed_markup') {
      if (input.markupPercent !== undefined || input.fixedMarkupAmount === undefined) {
        throw refuse('setMenuOffer: fixed_markup needs fixedMarkupAmount and no markupPercent.', 'Enter the peso amount to add to (or, negative, take off) the store price.');
      }
      fixedMarkupAmount = parseMenuAmount(input.fixedMarkupAmount, 'setMenuOffer: the markup amount', 'The markup amount', true);
    }
    const amount = isRule || input.amount == null ? null : parseMenuAmount(input.amount, 'setMenuOffer: the price', 'The price', false);
    const hasHeads = input.bundleHeads !== undefined;
    const hasExtra = input.extraHeadAmount !== undefined;
    if (hasHeads !== hasExtra) {
      throw refuse(
        'setMenuOffer: bundleHeads and extraHeadAmount go together.',
        'A bundle needs both the number of guests it covers and the price per extra guest.',
      );
    }
    if (hasHeads && (!Number.isInteger(input.bundleHeads) || (input.bundleHeads as number) < 1)) {
      throw refuse('setMenuOffer: bundleHeads must be a whole number from 1.', 'A bundle covers at least one guest, in whole numbers.');
    }
    const extra = hasExtra ? parseMenuAmount(input.extraHeadAmount, 'setMenuOffer: the extra-guest price', 'The extra-guest price', false) : null;
    await requireNotBackdated(trx, input.effectiveFrom, 'setMenuOffer', 'prices');
    const variant = await requireVariant(trx, actor, input.variantId, 'setMenuOffer');
    // R2: a refill is a zero-price serving. The database refuses an amount or a rule on one; say so first, in a sentence.
    const item = await menuRepo.getItem(trx, actor.orgId, variant.menuItemId);
    if (item?.itemType === 'refill' && (amount !== null || isRule || hasHeads)) {
      throw refuse('setMenuOffer: a refill carries no price or price rule.', 'A refill is a free serving a package entitles. It has no price, so it cannot take one.');
    }
    await requireHistorySlot(trx, input.variantId, { kind: 'offer', storeId: input.storeId, variantId: input.variantId, channel }, input.effectiveFrom, 'setMenuOffer');
    const row = await menuRepo.insertOffer(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      variantId: input.variantId,
      channel,
      effectiveFrom: input.effectiveFrom,
      amount,
      bundleHeads: hasHeads ? (input.bundleHeads as number) : null,
      extraHeadAmount: extra,
      withdrawn: false,
      pricingMode,
      markupPercent,
      fixedMarkupAmount,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_offer_set', input.storeId, row.id, null, row);
    return { id: row.id };
  });
}

/** Appends a withdrawal: from `effectiveFrom` the variant is not sold at that store on that channel. */
export async function withdrawMenuOffer(
  actor: Actor,
  input: { storeId: string; variantId: string; channel: MenuChannel; effectiveFrom?: Date },
  tx?: Tx,
): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    const channel = requireChannel(input.channel, 'withdrawMenuOffer');
    await requireNotBackdated(trx, input.effectiveFrom, 'withdrawMenuOffer', 'withdrawals');
    await requireVariant(trx, actor, input.variantId, 'withdrawMenuOffer');
    await requireHistorySlot(trx, input.variantId, { kind: 'offer', storeId: input.storeId, variantId: input.variantId, channel }, input.effectiveFrom, 'withdrawMenuOffer');
    const row = await menuRepo.insertOffer(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      variantId: input.variantId,
      channel,
      effectiveFrom: input.effectiveFrom,
      amount: null,
      bundleHeads: null,
      extraHeadAmount: null,
      withdrawn: true,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_offer_withdraw', input.storeId, row.id, null, row);
    return { id: row.id };
  });
}

/** Cancels an offer row that has not taken effect. `storeId` is the store the caller is allowed to price, and must be the row's. */
export async function cancelScheduledOffer(actor: Actor, input: { id: string; storeId: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    const row = await menuRepo.getOffer(trx, actor.orgId, input.id);
    if (!row || row.storeId !== input.storeId) throw gone(`cancelScheduledOffer: offer ${input.id} does not exist at this store.`, 'scheduled price');
    await requireScheduled(trx, row.effectiveFrom, 'cancelScheduledOffer', 'price');
    await menuRepo.deleteOffer(trx, row.id);
    await audit(trx, actor, 'menu_offer_cancel', input.storeId, row.id, row, null);
    return { id: row.id };
  });
}

async function requireVariant(trx: Tx, actor: Actor, id: string, rawLabel: string) {
  const variant = await menuRepo.getVariant(trx, actor.orgId, id);
  if (!variant) throw gone(`${rawLabel}: variant ${id} does not exist.`, 'variant');
  return variant;
}

// -------------------------------------------------------------------------------------------------------------------
// Option offers (R5): an option value's signed delta per store and channel
// -------------------------------------------------------------------------------------------------------------------
/**
 * Appends an option offer. `priceDelta` is signed text ("-10.00": no rice, ten off), at most two decimals. `priceDelta: null`
 * appends a withdrawal: from then the option is not offered on that channel. No row in force also means not offered.
 */
export async function setOptionOffer(
  actor: Actor,
  input: { storeId: string; optionValueId: string; channel: MenuChannel; priceDelta: string | null; effectiveFrom?: Date },
  tx?: Tx,
): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    const channel = requireChannel(input.channel, 'setOptionOffer');
    const priceDelta = input.priceDelta === null ? null : parseMenuAmount(input.priceDelta, 'setOptionOffer: the price change', 'The price change', true);
    await requireNotBackdated(trx, input.effectiveFrom, 'setOptionOffer', 'prices');
    if (!(await menuRepo.getOptionValue(trx, actor.orgId, input.optionValueId))) {
      throw gone(`setOptionOffer: option value ${input.optionValueId} does not exist.`, 'option');
    }
    await requireHistorySlot(trx, input.optionValueId, { kind: 'option', storeId: input.storeId, optionValueId: input.optionValueId, channel }, input.effectiveFrom, 'setOptionOffer');
    const row = await menuRepo.insertOptionOffer(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      optionValueId: input.optionValueId,
      channel,
      effectiveFrom: input.effectiveFrom,
      priceDelta,
      withdrawn: priceDelta === null,
      createdBy: actor.personId,
    });
    // Two literal calls (not a ternary) so the T-402 build guard, which reads the action as a literal, sees both actions.
    if (priceDelta === null) await audit(trx, actor, 'menu.option_offer_withdraw', input.storeId, row.id, null, row);
    else await audit(trx, actor, 'menu.option_offer_set', input.storeId, row.id, null, row);
    return { id: row.id };
  });
}

export async function cancelScheduledOptionOffer(actor: Actor, input: { id: string; storeId: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'set_menu_price', { storeId: input.storeId });
    const row = await menuRepo.getOptionOffer(trx, actor.orgId, input.id);
    if (!row || row.storeId !== input.storeId) throw gone(`cancelScheduledOptionOffer: option offer ${input.id} does not exist at this store.`, 'scheduled option price');
    await requireScheduled(trx, row.effectiveFrom, 'cancelScheduledOptionOffer', 'price');
    await menuRepo.deleteOptionOffer(trx, row.id);
    await audit(trx, actor, 'menu_option_offer_cancel', input.storeId, row.id, row, null);
    return { id: row.id };
  });
}
