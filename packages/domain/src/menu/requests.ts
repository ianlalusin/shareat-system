/**
 * T-401 S2 - item requests. docs/tasks/401-erp-menu-catalog-master.md R14(c), I21.
 *
 * A manager (or admin) ASKS for an item at a store: `request_menu_item` (store-scoped). The domain runs the deterministic
 * duplicate check (`menuRepo.similarMenuItems`) and returns the likely matches; the request is still allowed after the
 * requester has seen them. ONLY a super admin resolves a request (`add_menu_item`): approve (creates the item through
 * `createMenuItem` in the SAME transaction), mark duplicate (points at an existing item) or reject (a note is required).
 * A requester withdraws only their own open request. A resolved request never changes again (database trigger).
 * One `audit_log` row per call, entity `menu_item_requests`.
 */
import { authorize, heldCapabilities, type Actor } from '@shareat/auth';
import { MENU_ITEM_TYPES, type MenuItemType } from '@shareat/db/schema';
import { menuRepo, type Tx } from '@shareat/db';
import { gone, refuse } from '../shared/refusal';
import { createMenuItem } from './catalog';
import { audit, inTx, requireName } from './shared';

export interface PossibleDuplicate {
  readonly id: string;
  readonly name: string;
  readonly itemType: MenuItemType;
}

export async function requestMenuItem(
  actor: Actor,
  input: { storeId: string; name: string; itemType: MenuItemType; categoryId?: string; note?: string },
  tx?: Tx,
): Promise<{ id: string; possibleDuplicates: PossibleDuplicate[] }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'request_menu_item', { storeId: input.storeId });
    const name = requireName(input.name, 'requestMenuItem', 'The item');
    if (!(MENU_ITEM_TYPES as readonly unknown[]).includes(input.itemType)) {
      throw refuse('requestMenuItem: item type must be a_la_carte, package or refill.', 'Choose a type: a la carte, package or refill.');
    }
    if (input.categoryId && !(await menuRepo.getCategory(trx, actor.orgId, input.categoryId))) {
      throw gone(`requestMenuItem: category ${input.categoryId} does not exist.`, 'category');
    }
    const row = await menuRepo.insertRequest(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      requestedBy: actor.personId,
      name,
      itemType: input.itemType,
      categoryId: input.categoryId ?? null,
      note: input.note?.trim() || null,
    });
    await audit(trx, actor, 'menu_item_request', row.storeId, row.id, null, row);
    const similar = await menuRepo.similarMenuItems(trx, actor.orgId, name);
    return { id: row.id, possibleDuplicates: similar.map((m) => ({ id: m.id, name: m.name, itemType: m.itemType })) };
  });
}

/** The request, locked, and required to be open. Reading it first is the only way to learn its store; the gate follows at once. */
async function openRequest(trx: Tx, actor: Actor, id: string, rawLabel: string) {
  const row = await menuRepo.getRequest(trx, actor.orgId, id, true);
  if (!row) throw gone(`${rawLabel}: request ${id} does not exist.`, 'item request');
  if (row.status !== 'open') {
    throw refuse(`${rawLabel}: the request is already ${row.status}.`, `This request is already ${row.status}, so it can't change.`);
  }
  return row;
}

/** Only the requester, only while open. The store gate is the request's own store. */
export async function withdrawMenuItemRequest(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    // Authorize BEFORE reading: a caller without the capability learns nothing about which ids exist.
    // A store-scoped capability needs a store, which is read from the row: so first ask only whether the role holds it at all.
    if (!(await heldCapabilities(trx, actor)).has('request_menu_item')) await authorize(trx, actor, 'request_menu_item', {});
    const row = await menuRepo.getRequest(trx, actor.orgId, input.id, true);
    if (!row) throw gone(`withdrawMenuItemRequest: request ${input.id} does not exist.`, 'item request');
    await authorize(trx, actor, 'request_menu_item', { storeId: row.storeId });
    if (row.requestedBy !== actor.personId) {
      throw refuse('withdrawMenuItemRequest: only the requester can withdraw a request.', 'Only the person who asked for this item can withdraw the request.');
    }
    await openRequest(trx, actor, input.id, 'withdrawMenuItemRequest');
    const after = await menuRepo.resolveRequest(trx, row.id, { status: 'withdrawn', resolvedBy: actor.personId });
    await audit(trx, actor, 'menu_item_request_withdraw', row.storeId, row.id, row, after);
    return { id: row.id };
  });
}

/** Creates the item (with its default variant) via `createMenuItem` and resolves the request, in one transaction. */
export async function approveMenuItemRequest(
  actor: Actor,
  input: { id: string; categoryId: string },
  tx?: Tx,
): Promise<{ itemId: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'add_menu_item', {});
    const row = await openRequest(trx, actor, input.id, 'approveMenuItemRequest');
    const item = await createMenuItem(actor, { categoryId: input.categoryId, name: row.name, itemType: row.itemType }, trx);
    const after = await menuRepo.resolveRequest(trx, row.id, { status: 'approved', resolvedBy: actor.personId, resolvedItemId: item.id });
    await audit(trx, actor, 'menu_item_request_approve', row.storeId, row.id, row, after);
    return { itemId: item.id };
  });
}

/** The ask is already on the menu: point at that item. */
export async function markMenuItemRequestDuplicate(actor: Actor, input: { id: string; itemId: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'add_menu_item', {});
    const row = await openRequest(trx, actor, input.id, 'markMenuItemRequestDuplicate');
    if (!(await menuRepo.getItem(trx, actor.orgId, input.itemId))) {
      throw gone(`markMenuItemRequestDuplicate: item ${input.itemId} does not exist.`, 'menu item');
    }
    const after = await menuRepo.resolveRequest(trx, row.id, { status: 'duplicate', resolvedBy: actor.personId, resolvedItemId: input.itemId });
    await audit(trx, actor, 'menu_item_request_duplicate', row.storeId, row.id, row, after);
    return { id: row.id };
  });
}

/** A reason is required: the requester is told why. */
export async function rejectMenuItemRequest(actor: Actor, input: { id: string; note: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'add_menu_item', {});
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (!note) throw refuse('rejectMenuItemRequest: a reason is required.', 'Say why the request is rejected, so the requester knows.');
    const row = await openRequest(trx, actor, input.id, 'rejectMenuItemRequest');
    const after = await menuRepo.resolveRequest(trx, row.id, { status: 'rejected', resolvedBy: actor.personId, resolutionNote: note });
    await audit(trx, actor, 'menu_item_request_reject', row.storeId, row.id, row, after);
    return { id: row.id };
  });
}
