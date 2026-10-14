'use server';

/**
 * Server actions for /menu/requests (T-401 S4). docs/tasks/401-erp-menu-catalog-master.md section 5, R14.
 *
 * A manager ASKS for an item (`request_menu_item`, scoped to the store); ONLY a super admin resolves it (`add_menu_item`). The gate
 * lives INSIDE the domain function. Submitting is TWO steps: the first time, if the name looks like an item already on the menu,
 * NOTHING is written and the banner names the matches; "Send request anyway" posts the same form with `confirmed=1`.
 */
import { authorize } from '@shareat/auth';
import { menuRepo } from '@shareat/db';
import type { MenuItemType } from '@shareat/db/schema';
import {
  approveMenuItemRequest,
  markMenuItemRequestDuplicate,
  rejectMenuItemRequest,
  requestMenuItem,
  withdrawMenuItemRequest,
} from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { confirmTokenFor, menuErrorMessage, opt, requireId, str, withOrgPrincipal } from '../lib';
import { ITEM_REQUEST } from './typed-forms';

const PATH = '/menu/requests';

export async function submitItemRequestAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  // "Send request anyway" counts only for the very name that was checked: `confirmed` must be that name's token (never a bare 1).
  const confirmed = str(fd, 'confirmed') === confirmTokenFor(str(fd, 'name'));
  let outcome: { kind: 'warn'; names: string[]; pending: string[] } | { kind: 'sent' };
  try {
    const storeId = requireId(fd, 'storeId', 'Choose the store the request is for.');
    const name = str(fd, 'name');
    const categoryId = opt(fd, 'categoryId');
    const note = opt(fd, 'note');
    outcome = await withOrgPrincipal(actor.orgId, async (tx) => {
      // The gate FIRST: someone who may not ask learns no item names from the look-alike list.
      await authorize(tx, actor, 'request_menu_item', { storeId });
      if (!confirmed && name !== '') {
        const similar = await menuRepo.similarMenuItems(tx, actor.orgId, name);
        const pending = await menuRepo.similarOpenRequests(tx, actor.orgId, name);
        if (similar.length > 0 || pending.length > 0) return { kind: 'warn' as const, names: similar.map((m) => m.name), pending: pending.map((m) => m.name) };
      }
      await requestMenuItem(
        actor,
        { storeId, name, itemType: str(fd, 'itemType') as MenuItemType, ...(categoryId !== undefined ? { categoryId } : {}), ...(note !== undefined ? { note } : {}) },
        tx,
      );
      return { kind: 'sent' as const };
    });
  } catch (err) {
    const typed = keepTyping(fd, ITEM_REQUEST, '', { actorId: actor.personId });
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err), ...(typed ? { typed } : {}) });
  }
  if (outcome.kind === 'warn') {
    const typed = keepTyping(fd, ITEM_REQUEST, '', { actorId: actor.personId });
    const parts = [
      outcome.names.length > 0 ? `may already be on the menu: ${outcome.names.join(', ')}` : '',
      outcome.pending.length > 0 ? `has already been asked for and is waiting: ${outcome.pending.join(', ')}` : '',
    ].filter(Boolean);
    return await redirectWithFlash(
      PATH,
      {},
      {
        warning: `This ${parts.join('; and ')}. If it is the same thing, there is no need to ask. If it is a different item, send the request anyway.`,
        ...(typed ? { typed } : {}),
      },
    );
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Request sent.' });
}

/** The requester only, while the request is open. */
export async function withdrawItemRequestAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    const id = requireId(fd, 'id', 'Choose a request.');
    await withOrgPrincipal(actor.orgId, (tx) => withdrawMenuItemRequest(actor, { id }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Request withdrawn.' });
}

/** Super admin: creates the item (and its default variant) and closes the request, in one transaction. */
export async function approveItemRequestAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    const id = requireId(fd, 'id', 'Choose a request.');
    const categoryId = requireId(fd, 'categoryId', 'Choose the category the new item goes in.');
    await withOrgPrincipal(actor.orgId, (tx) => approveMenuItemRequest(actor, { id, categoryId }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Item added from the request.' });
}

export async function markItemRequestDuplicateAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    const id = requireId(fd, 'id', 'Choose a request.');
    const itemId = requireId(fd, 'itemId', 'Choose the item this is a duplicate of.');
    await withOrgPrincipal(actor.orgId, (tx) => markMenuItemRequestDuplicate(actor, { id, itemId }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Marked as a duplicate.' });
}

export async function rejectItemRequestAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    const id = requireId(fd, 'id', 'Choose a request.');
    await withOrgPrincipal(actor.orgId, (tx) => rejectMenuItemRequest(actor, { id, note: str(fd, 'note') }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Request rejected.' });
}
