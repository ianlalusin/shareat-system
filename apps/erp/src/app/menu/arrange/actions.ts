'use server';

/**
 * Server actions for /menu/arrange (T-651). Thin adapters: read the order the screen sent (a JSON list of ids), call the domain's reorder function (its first
 * line is `authorize(manage_menu)`), and come back to the same lists with a banner. Each action redirects AFTER its work, outside the `try`.
 */
import { reorderMenuCategories, reorderMenuItems, reorderMenuOptionValues, reorderMenuVariants } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { menuErrorMessage, str, withOrgPrincipal } from '../lib';

const PATH = '/menu/arrange';
const SAME = 'The order is the same, so nothing was changed.';

/** The lists the screen was showing, so a Save comes back to them. A blank one is left out (the address keeps only a well-formed id). */
const navOf = (o: { category: string; menuItem?: string }) => ({ ...(o.category ? { category: o.category } : {}), ...(o.menuItem ? { menuItem: o.menuItem } : {}) });

/** The screen sends the whole list as JSON; anything else becomes an empty list, which the domain refuses as "the list changed". */
function idsOf(fd: FormData): string[] {
  try {
    const parsed: unknown = JSON.parse(String(fd.get('ids') ?? ''));
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export async function reorderCategoriesAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const nav = navOf({ category: str(fd, 'category') });
  let changed: boolean;
  try {
    ({ changed } = await withOrgPrincipal(actor.orgId, (tx) => reorderMenuCategories(actor, { ids: idsOf(fd) }, tx)));
  } catch (err) {
    return await redirectWithFlash(PATH, nav, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, nav, { ok: changed ? 'Category order saved.' : SAME });
}

export async function reorderItemsAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const categoryId = str(fd, 'categoryId');
  const nav = navOf({ category: categoryId, menuItem: str(fd, 'menuItem') });
  let changed: boolean;
  try {
    ({ changed } = await withOrgPrincipal(actor.orgId, (tx) => reorderMenuItems(actor, { categoryId, ids: idsOf(fd) }, tx)));
  } catch (err) {
    return await redirectWithFlash(PATH, nav, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, nav, { ok: changed ? 'Item order saved.' : SAME });
}

export async function reorderVariantsAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const menuItemId = str(fd, 'menuItemId');
  const nav = navOf({ category: str(fd, 'category'), menuItem: menuItemId });
  let changed: boolean;
  try {
    ({ changed } = await withOrgPrincipal(actor.orgId, (tx) => reorderMenuVariants(actor, { menuItemId, ids: idsOf(fd) }, tx)));
  } catch (err) {
    return await redirectWithFlash(PATH, nav, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, nav, { ok: changed ? 'Size order saved.' : SAME });
}

export async function reorderOptionValuesAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const optionGroupId = str(fd, 'optionGroupId');
  const nav = navOf({ category: str(fd, 'category'), menuItem: str(fd, 'menuItem') });
  let changed: boolean;
  try {
    ({ changed } = await withOrgPrincipal(actor.orgId, (tx) => reorderMenuOptionValues(actor, { optionGroupId, ids: idsOf(fd) }, tx)));
  } catch (err) {
    return await redirectWithFlash(PATH, nav, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, nav, { ok: changed ? 'Option order saved.' : SAME });
}
