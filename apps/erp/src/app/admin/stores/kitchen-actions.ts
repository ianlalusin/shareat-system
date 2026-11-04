'use server';

/**
 * T-508 S2b: server actions for the Kitchen stations and Kitchen routing panels on /kitchen.
 * Thin adapters: parse the form, call the gated domain function, redirect with a message. The gate
 * (`manage_store_settings` at the row's store) lives in `packages/domain/src/kitchen`, not here.
 */
import {
  clearKitchenRoute,
  createKitchenStation,
  listKitchenSetup,
  renameKitchenStation,
  retireKitchenStation,
  setKitchenRoute,
  setKitchenRoutesForCategory,
  updateKitchenStation,
} from '@shareat/domain';
import { withOrgPrincipal } from '../../expenses/lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';
import { refuse } from '@shareat/db';
import { keepTyping } from '@/lib/keep-typing';
import { KITCHEN_ROUTING, KITCHEN_STATION_EDIT } from './typed-forms';

const str = (fd: FormData, key: string): string => {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
};
const num = (fd: FormData, key: string): number | undefined => {
  const s = str(fd, key);
  return s === '' ? undefined : Number(s);
};
const PAGE = '/kitchen';
/** The kitchen page for a store: path plus the `?store=` nav param. */
const back = (storeId: string, flash: Parameters<typeof redirectWithFlash>[2]) => redirectWithFlash(PAGE, { store: storeId }, flash);

export async function createKitchenStationAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  const storeId = str(fd, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      createKitchenStation(tx, actor, { storeId, name: str(fd, 'name'), slaMinutes: num(fd, 'slaMinutes') }),
    );
  } catch (err) {
    return await back(storeId, { error: errorMessage(err) });
  }
  return await back(storeId, { ok: 'Kitchen station added. Now choose which items cook there.' });
}

export async function updateKitchenStationAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  const storeId = str(fd, 'storeId');
  const stationId = str(fd, 'stationId');
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await renameKitchenStation(tx, actor, { stationId, name: str(fd, 'name') });
      await updateKitchenStation(tx, actor, {
        stationId,
        slaMinutes: num(fd, 'slaMinutes'),
        sortOrder: num(fd, 'sortOrder'),
        printOnOutage: str(fd, 'printOnOutage') === 'yes',
      });
    });
  } catch (err) {
    return await back(storeId, { error: errorMessage(err), typed: keepTyping(fd, KITCHEN_STATION_EDIT, stationId, { actorId: actor.personId }) });
  }
  return await back(storeId, { ok: 'Kitchen station saved.' });
}

export async function retireKitchenStationAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  const storeId = str(fd, 'storeId');
  try {
    const stationId = str(fd, 'stationId');
    await withOrgPrincipal(actor.orgId, async (tx) => {
      // The name to retype is the one the SERVER loads (this read also authorizes the actor at the store), never one from the form.
      const station = (await listKitchenSetup(tx, actor, { storeId })).stations.find((s) => s.id === stationId);
      if (!station) throw refuse(`retireKitchenStationAction: station ${stationId} not at store ${storeId}`, 'That kitchen station does not exist any more.');
      if (!retypeMatches(str(fd, 'confirmName'), station.name)) throw retypeRefusalError(station.name);
      await retireKitchenStation(tx, actor, { stationId });
    });
  } catch (err) {
    return await back(storeId, { error: errorMessage(err) });
  }
  return await back(storeId, { ok: 'Kitchen station retired.' });
}

/** One save for every picker: only the items whose station actually changed are written ("" = no station). */
export async function saveKitchenRoutingAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  const storeId = str(fd, 'storeId');
  let changed = 0;
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      const current = new Map((await listKitchenSetup(tx, actor, { storeId })).offeredItems.map((i) => [i.itemId, i.stationId ?? '']));
      for (const [key, value] of fd.entries()) {
        const menuItemId = /^route_(.+)$/.exec(key)?.[1];
        if (!menuItemId || typeof value !== 'string') continue;
        if (!current.has(menuItemId) || current.get(menuItemId) === value) continue;
        const { wrote } =
          value === ''
            ? await clearKitchenRoute(tx, actor, { storeId, menuItemId })
            : await setKitchenRoute(tx, actor, { storeId, menuItemId, stationId: value });
        if (wrote) changed++;
      }
    });
  } catch (err) {
    return await back(storeId, { error: errorMessage(err), typed: keepTyping(fd, KITCHEN_ROUTING, storeId, { actorId: actor.personId }) });
  }
  return await back(storeId, { ok: changed === 0 ? 'Nothing changed.' : `Kitchen routing saved for ${changed} item${changed === 1 ? '' : 's'}.` });
}

export async function setKitchenCategoryAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  const storeId = str(fd, 'storeId');
  const categoryId = str(fd, 'categoryId');
  const stationId = str(fd, 'stationId');
  if (!categoryId || !stationId) return await back(storeId, { error: 'Choose a category and a station.' });
  let changed = 0;
  try {
    changed = (
      await withOrgPrincipal(actor.orgId, (tx) =>
        setKitchenRoutesForCategory(tx, actor, { storeId, categoryId, stationId }),
      )
    ).changed;
  } catch (err) {
    return await back(storeId, { error: errorMessage(err) });
  }
  return await back(storeId, { ok: changed === 0 ? 'Every item in that category already cooks there.' : `${changed} item${changed === 1 ? '' : 's'} now cook there.` });
}
