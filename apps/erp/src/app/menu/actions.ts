'use server';

/**
 * Server actions for /menu (T-401 S4): categories, inline, and adding an item. docs/tasks/401-erp-menu-catalog-master.md section 5.
 *
 * Thin adapters: read the form, call the domain (packages/domain/src/menu), redirect with a banner. The gate lives INSIDE the
 * domain function (`manage_menu`, `add_menu_item`), not here. A blank text box means "not sent".
 */
import { assertFieldRules, createMenuCategory, createMenuItem, editMenuCategory, retireMenuCategory } from '@shareat/domain';
import { MENU_CATEGORY_RULES, MENU_ITEM_ADD_RULES } from '@shareat/domain/field-rules';
import type { MenuItemType } from '@shareat/db/schema';
import { requireActor } from '../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { menuErrorMessage, opt, requireId, str, wholeNumber, withOrgPrincipal } from './lib';
import { MENU_CATEGORY } from './typed-forms';
import { loadDestructiveTarget, retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';

const PATH = '/menu';

export async function createCategoryAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    assertFieldRules(MENU_CATEGORY_RULES, fd);
    const sortOrder = wholeNumber(fd, 'sortOrder', 'The sort order');
    const parentId = opt(fd, 'parentId');
    await withOrgPrincipal(actor.orgId, (tx) =>
      createMenuCategory(actor, { name: str(fd, 'name'), ...(parentId ? { parentId } : {}), ...(sortOrder !== undefined ? { sortOrder } : {}) }, tx),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Category added.' });
}

export async function editCategoryAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const categoryId = str(fd, 'id');
  try {
    // An edit that sends no name leaves the name alone ("a blank box is not sent"); one that sends it must send a real one.
    if (fd.has('name')) assertFieldRules(MENU_CATEGORY_RULES, fd);
    const id = requireId(fd, 'id', 'Choose a category.');
    const name = opt(fd, 'name');
    const sortOrder = wholeNumber(fd, 'sortOrder', 'The sort order');
    await withOrgPrincipal(actor.orgId, (tx) =>
      editMenuCategory(actor, { id, ...(name !== undefined ? { name } : {}), ...(sortOrder !== undefined ? { sortOrder } : {}) }, tx),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err), typed: keepTyping(fd, MENU_CATEGORY, categoryId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Category saved.' });
}

/** Refused (in a sentence) while the category still holds an active item: the database trigger is the last word. */
export async function retireCategoryAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    const id = requireId(fd, 'id', 'Choose a category.');
    // T-412 Tier R: the person retypes the category's name; the server compares it with the name IT loads.
    const target = await loadDestructiveTarget(actor, 'menu_category', id, ['manage_menu']);
    if (!retypeMatches(str(fd, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
    await withOrgPrincipal(actor.orgId, (tx) => retireMenuCategory(actor, { id }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Category retired.' });
}

/** Super admin only (`add_menu_item`). Lands on the new item's own page. */
export async function createItemAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  let created: { id: string };
  try {
    assertFieldRules(MENU_ITEM_ADD_RULES, fd);
    const categoryId = requireId(fd, 'categoryId', 'Choose a category for the item.');
    const description = opt(fd, 'description');
    created = await withOrgPrincipal(actor.orgId, (tx) =>
      createMenuItem(
        actor,
        { categoryId, name: str(fd, 'name'), itemType: str(fd, 'itemType') as MenuItemType, ...(description !== undefined ? { description } : {}) },
        tx,
      ),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(`/menu/items/${created.id}`, {}, { ok: 'Item added.' });
}
