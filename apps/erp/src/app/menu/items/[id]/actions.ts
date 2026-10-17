'use server';

/**
 * Server actions for /menu/items/[id] (T-401 S4): the item, its variants, depletion rules, option groups and package refills.
 * docs/tasks/401-erp-menu-catalog-master.md section 5.
 *
 * Every form carries a hidden `menuItemId` (the page's item) so the person lands back on it. The gate lives INSIDE each domain
 * function (`manage_menu`, `add_menu_item`, `set_menu_depletion`); nothing here decides who may. A blank text box means "not
 * sent". Quantities stay TEXT all the way to the domain. Each action redirects for itself (guard G1b: no wrapper redirects).
 */
import { MENU_DEPLETION_RULES, MENU_ITEM_EDIT_RULES, MENU_OPTION_GROUP_RULES, MENU_OPTION_VALUE_RULES, MENU_VARIANT_RULES } from '@shareat/domain/field-rules';
import {
  assertFieldRules,
  addMenuVariant,
  addOptionValue,
  createOptionGroup,
  editMenuItem,
  editOptionGroup,
  editOptionValue,
  linkOptionGroup,
  setDepletionRule,
  setPackageRefills,
  unlinkOptionGroup,
} from '@shareat/domain';
import type { MenuDepletionMode, MenuSelectionMode, MenuStatus } from '@shareat/db/schema';
import { requireActor } from '../../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { isUuid, manilaInstant, menuErrorMessage, opt, requireId, str, wholeNumber, withOrgPrincipal } from '../../lib';
import { MENU_ITEM, MENU_OPTION_GROUP, MENU_OPTION_VALUE } from './typed-forms';

const OPEN_FIRST = 'Open the item from the menu first.';

/** The page this form came from: the item's own page, or the menu when the hidden field is not an id. */
function where(fd: FormData): { menuItemId: string; path: string; valid: boolean } {
  const menuItemId = str(fd, 'menuItemId');
  return isUuid(menuItemId) ? { menuItemId, path: `/menu/items/${menuItemId}`, valid: true } : { menuItemId, path: '/menu', valid: false };
}

export async function editItemAction(fd: FormData): Promise<void> {
  const { menuItemId, path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    // An edit that sends no name leaves the name alone ("a blank box is not sent"); one that sends it must send a real one.
    if (fd.has('name')) assertFieldRules(MENU_ITEM_EDIT_RULES, fd);
    const name = opt(fd, 'name');
    const description = opt(fd, 'description');
    const categoryId = opt(fd, 'categoryId');
    const status = opt(fd, 'status');
    const sortOrder = wholeNumber(fd, 'sortOrder', 'The sort order');
    await withOrgPrincipal(actor.orgId, (tx) =>
      editMenuItem(
        actor,
        {
          id: menuItemId,
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(categoryId !== undefined ? { categoryId } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(status !== undefined ? { status: status as MenuStatus } : {}),
        },
        tx,
      ),
    );
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err), typed: keepTyping(fd, MENU_ITEM, menuItemId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Item saved.' });
}

export async function addVariantAction(fd: FormData): Promise<void> {
  const { menuItemId, path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    assertFieldRules(MENU_VARIANT_RULES, fd);
    await withOrgPrincipal(actor.orgId, (tx) => addMenuVariant(actor, { menuItemId, label: str(fd, 'label') }, tx));
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Variant added.' });
}

/** `stockItemId` is the stock item a sale uses up (mode direct); `effectiveFrom` blank = from now, otherwise Manila time. */
export async function setDepletionRuleAction(fd: FormData): Promise<void> {
  const { path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    assertFieldRules(MENU_DEPLETION_RULES, fd);
    const variantId = requireId(fd, 'variantId', 'Choose a variant.');
    const stockItemId = opt(fd, 'stockItemId');
    const recipeId = opt(fd, 'recipeId');
    const quantityPerSale = opt(fd, 'quantityPerSale');
    const effectiveFrom = manilaInstant(opt(fd, 'effectiveFrom'));
    await withOrgPrincipal(actor.orgId, (tx) =>
      setDepletionRule(
        actor,
        {
          variantId,
          mode: str(fd, 'mode') as MenuDepletionMode,
          ...(stockItemId !== undefined ? { itemId: stockItemId } : {}),
          ...(recipeId !== undefined ? { recipeId } : {}),
          ...(quantityPerSale !== undefined ? { quantityPerSale } : {}),
          ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
        },
        tx,
      ),
    );
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Depletion rule saved.' });
}

/** Makes the group, its values (one per line, blanks skipped) AND attaches it to this item, in one transaction. */
export async function createOptionGroupAction(fd: FormData): Promise<void> {
  const { menuItemId, path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    assertFieldRules(MENU_OPTION_GROUP_RULES, fd);
    const names = str(fd, 'values')
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter((n) => n !== '');
    const minSelections = wholeNumber(fd, 'minSelections', 'The minimum');
    const maxSelections = wholeNumber(fd, 'maxSelections', 'The maximum');
    await withOrgPrincipal(actor.orgId, async (tx) => {
      const group = await createOptionGroup(
        actor,
        {
          name: str(fd, 'name'),
          selectionMode: str(fd, 'selectionMode') as MenuSelectionMode,
          minSelections: minSelections as number,
          maxSelections: maxSelections as number,
        },
        tx,
      );
      for (const [i, name] of names.entries()) await addOptionValue(actor, { optionGroupId: group.id, name, sortOrder: i }, tx);
      await linkOptionGroup(actor, { optionGroupId: group.id, menuItemId }, tx);
    });
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Option group added.' });
}

export async function editOptionGroupAction(fd: FormData): Promise<void> {
  const { path, valid } = where(fd);
  const actor = await requireActor(path);
  const groupId = str(fd, 'id');
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    // An edit that sends no name leaves the name alone; one that sends it must send a real one.
    if (fd.has('name')) assertFieldRules(MENU_OPTION_GROUP_RULES, fd);
    const id = requireId(fd, 'id', 'Choose an option group.');
    const name = opt(fd, 'name');
    const selectionMode = opt(fd, 'selectionMode');
    const status = opt(fd, 'status');
    const minSelections = wholeNumber(fd, 'minSelections', 'The minimum');
    const maxSelections = wholeNumber(fd, 'maxSelections', 'The maximum');
    await withOrgPrincipal(actor.orgId, (tx) =>
      editOptionGroup(
        actor,
        {
          id,
          ...(name !== undefined ? { name } : {}),
          ...(selectionMode !== undefined ? { selectionMode: selectionMode as MenuSelectionMode } : {}),
          ...(minSelections !== undefined ? { minSelections } : {}),
          ...(maxSelections !== undefined ? { maxSelections } : {}),
          ...(status !== undefined ? { status: status as MenuStatus } : {}),
        },
        tx,
      ),
    );
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err), typed: keepTyping(fd, MENU_OPTION_GROUP, groupId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Option group saved.' });
}

export async function addOptionValueAction(fd: FormData): Promise<void> {
  const { path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    assertFieldRules(MENU_OPTION_VALUE_RULES, fd);
    const optionGroupId = requireId(fd, 'optionGroupId', 'Choose an option group.');
    await withOrgPrincipal(actor.orgId, (tx) => addOptionValue(actor, { optionGroupId, name: str(fd, 'name') }, tx));
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Option added.' });
}

export async function editOptionValueAction(fd: FormData): Promise<void> {
  const { path, valid } = where(fd);
  const actor = await requireActor(path);
  const valueId = str(fd, 'id');
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    // The Retire / Restore button posts this action with no name; a rename must send a real one.
    if (fd.has('name')) assertFieldRules(MENU_OPTION_VALUE_RULES, fd);
    const id = requireId(fd, 'id', 'Choose an option.');
    const name = opt(fd, 'name');
    const status = opt(fd, 'status');
    const sortOrder = wholeNumber(fd, 'sortOrder', 'The sort order');
    await withOrgPrincipal(actor.orgId, (tx) =>
      editOptionValue(
        actor,
        { id, ...(name !== undefined ? { name } : {}), ...(sortOrder !== undefined ? { sortOrder } : {}), ...(status !== undefined ? { status: status as MenuStatus } : {}) },
        tx,
      ),
    );
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err), typed: keepTyping(fd, MENU_OPTION_VALUE, valueId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Option saved.' });
}

/** `variantId` blank attaches the group to the item; otherwise to that one variant. */
export async function linkOptionGroupAction(fd: FormData): Promise<void> {
  const { menuItemId, path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    const optionGroupId = requireId(fd, 'optionGroupId', 'Choose an option group to attach.');
    const variantId = opt(fd, 'variantId');
    await withOrgPrincipal(actor.orgId, (tx) =>
      linkOptionGroup(actor, variantId ? { optionGroupId, variantId } : { optionGroupId, menuItemId }, tx),
    );
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Option group attached.' });
}

export async function unlinkOptionGroupAction(fd: FormData): Promise<void> {
  const { path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    const id = requireId(fd, 'linkId', 'Choose which attachment to remove.');
    await withOrgPrincipal(actor.orgId, (tx) => unlinkOptionGroup(actor, { id }, tx));
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Option group removed.' });
}

/** REPLACES the package's refills with the ticked ones. None ticked means no refills, never "all". */
export async function setPackageRefillsAction(fd: FormData): Promise<void> {
  const { path, valid } = where(fd);
  const actor = await requireActor(path);
  if (!valid) return await redirectWithFlash(path, {}, { error: OPEN_FIRST });
  try {
    const packageVariantId = requireId(fd, 'packageVariantId', 'Choose a package variant.');
    const refillItemIds = fd.getAll('refillItemIds').filter((v): v is string => typeof v === 'string' && v !== '');
    await withOrgPrincipal(actor.orgId, (tx) => setPackageRefills(actor, { packageVariantId, refillItemIds }, tx));
  } catch (err) {
    return await redirectWithFlash(path, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Refills saved.' });
}
