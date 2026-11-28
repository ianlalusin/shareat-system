/**
 * T-651 - arrange the menu once; every screen shows that order. One function per list: the categories, the items of a category,
 * the sizes (variants) of an item, the option values of a group. Each: `authorize()` first (`manage_menu`), the whole list in ONE
 * transaction, `sort_order` written as 10, 20, 30... in the order given, one audit row for the list (the id order before and after).
 *
 * The caller sends the ids in the order it wants; they must be EXACTLY the list's current active rows, or nothing is written
 * (someone changed the list while the screen was open). The rows are locked first, so two saves of one list take turns.
 *
 * Nothing is bumped for the POS: its snapshot carries the projected menu, whose order comes from `sort_order`, and the tablet fetches a snapshot
 * by content hash (`etag`) every few minutes. A new order is a new hash, so it arrives on the next refresh by itself.
 */
import { authorize, type Actor } from '@shareat/auth';
import { menuRepo, type Tx } from '@shareat/db';
import { gone, refuse } from '../shared/refusal';
import { MENU_ORDER_STEP } from './order';
import { audit, inTx } from './shared';

const STALE = 'The list changed since you opened it. Reload and try again.';

async function reorder(
  trx: Tx,
  actor: Actor,
  list: menuRepo.OrderList,
  ids: readonly string[],
  action: string,
  entityId: string,
): Promise<{ changed: boolean }> {
  const rows = await menuRepo.orderedRows(trx, list, true);
  const wanted = new Set(ids);
  if (!Array.isArray(ids) || wanted.size !== ids.length || ids.length !== rows.length || !rows.every((r) => wanted.has(r.id))) {
    throw refuse(`${action}: the ids are not exactly the ${rows.length} active rows of this list.`, STALE);
  }
  const written = await menuRepo.setSortOrders(trx, list, ids, MENU_ORDER_STEP);
  if (written === 0) return { changed: false };
  await audit(trx, actor, action, null, entityId, { order: rows.map((r) => r.id) }, { order: [...ids] });
  return { changed: true };
}

export async function reorderMenuCategories(actor: Actor, input: { ids: string[] }, tx?: Tx): Promise<{ changed: boolean }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    return reorder(trx, actor, { kind: 'categories', orgId: actor.orgId }, input.ids, 'menu.categories_reordered', actor.orgId);
  });
}

export async function reorderMenuItems(actor: Actor, input: { categoryId: string; ids: string[] }, tx?: Tx): Promise<{ changed: boolean }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    if (!(await menuRepo.getCategory(trx, actor.orgId, input.categoryId))) throw gone(`reorderMenuItems: category ${input.categoryId} does not exist.`, 'category');
    return reorder(trx, actor, { kind: 'items', orgId: actor.orgId, categoryId: input.categoryId }, input.ids, 'menu.items_reordered', input.categoryId);
  });
}

/** The default size is always shown first whatever its number, so it is part of the set (send it, anywhere) and its place is not the cashier's choice. */
export async function reorderMenuVariants(actor: Actor, input: { menuItemId: string; ids: string[] }, tx?: Tx): Promise<{ changed: boolean }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    if (!(await menuRepo.getItem(trx, actor.orgId, input.menuItemId))) throw gone(`reorderMenuVariants: item ${input.menuItemId} does not exist.`, 'menu item');
    return reorder(trx, actor, { kind: 'variants', orgId: actor.orgId, menuItemId: input.menuItemId }, input.ids, 'menu.variants_reordered', input.menuItemId);
  });
}

export async function reorderMenuOptionValues(actor: Actor, input: { optionGroupId: string; ids: string[] }, tx?: Tx): Promise<{ changed: boolean }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    if (!(await menuRepo.getOptionGroup(trx, actor.orgId, input.optionGroupId))) {
      throw gone(`reorderMenuOptionValues: option group ${input.optionGroupId} does not exist.`, 'option group');
    }
    return reorder(trx, actor, { kind: 'optionValues', orgId: actor.orgId, optionGroupId: input.optionGroupId }, input.ids, 'menu.option_values_reordered', input.optionGroupId);
  });
}
