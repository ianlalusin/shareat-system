'use server';

/**
 * Server actions for /menu/usage-source (T-401 S5, Ian's Q3). docs/tasks/401-erp-menu-catalog-master.md section 5, R7.
 *
 * Thin adapters over the seam in packages/domain/src/pos/depletion-source.ts: read the form, call the domain, redirect with a banner.
 * The gate lives INSIDE the domain function (`manage_pos_map` for links, `switch_usage_source` for the switch). Nothing typed (the
 * reason in particular) rides in the address: the store is the only nav value. Each action redirects for itself (guard G1b).
 */
import { linkPosV1Item, seedLinkFromMap, switchUsageSource, unlinkPosV1Item } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { isUuid, menuErrorMessage, opt, requireId, str, withOrgPrincipal } from '../lib';

const PATH = '/menu/usage-source';
const CHOOSE_STORE = 'Choose a store.';

export async function linkItemAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  try {
    const variantId = requireId(fd, 'variantId', 'Choose a menu item.');
    const locationId = opt(fd, 'locationId');
    await withOrgPrincipal(actor.orgId, (tx) =>
      linkPosV1Item(actor, { storeId, posItemKey: str(fd, 'posItemKey'), variantId, ...(locationId !== undefined ? { locationId } : {}) }, tx),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: 'Link saved.' });
}

export async function seedLinkAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  try {
    const variantId = requireId(fd, 'variantId', 'Choose a menu item.');
    await withOrgPrincipal(actor.orgId, (tx) => seedLinkFromMap(actor, { storeId, posItemKey: str(fd, 'posItemKey'), variantId }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: 'Linked from the POS map.' });
}

export async function unlinkItemAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  try {
    await withOrgPrincipal(actor.orgId, (tx) => unlinkPosV1Item(actor, { storeId, posItemKey: str(fd, 'posItemKey') }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: 'Link removed.' });
}

/** To the menu rules: the domain runs the comparison itself and refuses a difference unless `acceptDifferences=1` comes with a reason. Back: always. */
export async function switchSourceAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const storeId = str(fd, 'storeId');
  if (!isUuid(storeId)) return await redirectWithFlash(PATH, {}, { error: CHOOSE_STORE });
  const source = str(fd, 'source') === 'menu_rules' ? 'menu_rules' : 'v1_pos_map';
  try {
    const reason = opt(fd, 'reason');
    await withOrgPrincipal(actor.orgId, (tx) =>
      switchUsageSource(actor, { storeId, source, acceptDifferences: str(fd, 'acceptDifferences') === '1', ...(reason !== undefined ? { reason } : {}) }, tx),
    );
  } catch (err) {
    return await redirectWithFlash(PATH, { store: storeId }, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, { store: storeId }, { ok: source === 'menu_rules' ? 'Switched to menu rules.' : 'Switched back to POS item maps.' });
}
