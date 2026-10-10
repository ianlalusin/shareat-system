'use server';

/**
 * Server actions for the stock-locations screen — T-160 / DEF-135, 2026-09-03.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. ⭐ The actor comes
 * from the session, never the form (T-138) — authorization is `createLocation` /
 * `updateLocation` / `setDefaultLocation` / `deactivateLocation` / `reactivateLocation` /
 * `ensureLocationTypes` / `seedStoreLocations`'s own FIRST statement, not repeated here. Every
 * mutation runs under the org's RLS principal (`withOrgPrincipal`), the same shape
 * `commissary/catalogue/actions.ts` established.
 */
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { LOCATION_EDIT } from './typed-forms';
import { revalidatePath } from 'next/cache';
import {
  createLocation,
  deactivateLocation,
  ensureLocationTypes,
  reactivateLocation,
  seedStoreLocations,
  setDefaultLocation,
  updateLocation,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../../lib/error-shape';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Turns a thrown domain/DB message into one sentence a manager can act on. Kept LOCAL to this
 * file — `apps/erp/src/lib/constraint-messages.ts` is shared and not this task's to edit.
 *
 * T-343 S5.1d — DEF-450. Every `AuthorizationError` `authorize` throws already carries the S2/S2b
 * `userMessage`; presentable wins first. The old two branches — the `manage_locations` capability
 * check and the store-scope-refusal shape — answered a generic sentence for every refusal on that
 * capability regardless of the real reason — deleted, not bypassed.
 */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);

  if (/is single_room and already has an active non-Receiving room/.test(raw)) {
    return 'This store keeps stock in ONE room. Deactivate or repurpose the existing room before adding another.';
  }
  if (/stock_locations_one_receiving_per_store/.test(raw)) {
    return 'This store already has a Receiving room — there can be only one.';
  }
  if (/stock_locations_one_default_per_store/.test(raw)) {
    return 'This store already has a default room.';
  }
  if (/stock_locations_store_code_key/.test(raw)) {
    return 'That room code is already used in this store — pick another.';
  }
  if (/stock_locations_receiving_is_storage_check/.test(raw) || /Receiving room is always a storage room/.test(raw)) {
    return 'The Receiving room must be a storage room, not operating.';
  }
  if (/not_blank_check/.test(raw)) {
    return 'A room needs both a code and a name.';
  }
  if (/role_check|purpose_check/.test(raw)) {
    return 'That role or purpose is not recognised.';
  }
  // ⚠️ The "holds stock and cannot be deactivated" refusal was listed here to strip its own
  // `deactivateLocation:` prefix by name. The shared fallback strips any such prefix, so it
  // falls through to it now — same sentence, one implementation (T-255).
  return sharedErrorMessage(err);
}

export async function setupRoomsAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/locations');
  const storeId = str(fd, 'storeId');

  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      await ensureLocationTypes(tx, actor, { storeId });
      return seedStoreLocations(tx, actor, { storeId });
    });
    message =
      result.created.length > 0
        ? `Rooms set up: ${result.created.map((c) => c.code).join(', ')}.`
        : 'This store already has its rooms — nothing to add.';
  } catch (err) {
    return await redirectWithFlash('/inventory/locations', { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath('/inventory/locations');
  return await redirectWithFlash('/inventory/locations', { store: storeId }, { ok: message });
}

export async function createLocationAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/locations');
  const storeId = str(fd, 'storeId');

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      createLocation(tx, actor, {
        storeId,
        code: str(fd, 'code'),
        name: str(fd, 'name'),
        typeId: str(fd, 'typeId'),
        role: str(fd, 'role'),
        purpose: fd.get('isReceiving') === 'on' ? 'receiving' : 'normal',
        isDefault: fd.get('isDefault') === 'on',
      }),
    );
    message = 'Room created.';
  } catch (err) {
    return await redirectWithFlash('/inventory/locations', { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath('/inventory/locations');
  return await redirectWithFlash('/inventory/locations', { store: storeId }, { ok: message });
}

export async function updateLocationAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/locations');
  const storeId = str(fd, 'storeId');
  const id = str(fd, 'id');
  const role = str(fd, 'role');

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      updateLocation(tx, actor, {
        id,
        name: str(fd, 'name'),
        typeId: str(fd, 'typeId'),
        // ⚠️ The Receiving room's edit form never renders a role select (page.tsx) — an absent
        // field here means "not changing it", never "clear it".
        role: role || undefined,
      }),
    );
    message = 'Room updated.';
  } catch (err) {
    return await redirectWithFlash('/inventory/locations', { store: storeId }, { error: errorMessage(err), typed: keepTyping(fd, LOCATION_EDIT, id, { actorId: actor.personId }) });
  }
  revalidatePath('/inventory/locations');
  return await redirectWithFlash('/inventory/locations', { store: storeId }, { ok: message });
}

export async function setDefaultAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/locations');
  const storeId = str(fd, 'storeId');
  const id = str(fd, 'id');

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setDefaultLocation(tx, actor, { id }));
    message = 'Default room updated.';
  } catch (err) {
    return await redirectWithFlash('/inventory/locations', { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath('/inventory/locations');
  return await redirectWithFlash('/inventory/locations', { store: storeId }, { ok: message });
}

export async function deactivateLocationAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/locations');
  const storeId = str(fd, 'storeId');
  const id = str(fd, 'id');

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => deactivateLocation(tx, actor, { id }));
    message = 'Room deactivated.';
  } catch (err) {
    return await redirectWithFlash('/inventory/locations', { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath('/inventory/locations');
  return await redirectWithFlash('/inventory/locations', { store: storeId }, { ok: message });
}

export async function reactivateLocationAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/locations');
  const storeId = str(fd, 'storeId');
  const id = str(fd, 'id');

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => reactivateLocation(tx, actor, { id }));
    message = 'Room reactivated.';
  } catch (err) {
    return await redirectWithFlash('/inventory/locations', { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath('/inventory/locations');
  return await redirectWithFlash('/inventory/locations', { store: storeId }, { ok: message });
}
