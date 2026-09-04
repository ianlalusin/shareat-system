'use server';

/**
 * Server actions for the POS item mapping screen — T-177.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. The actor comes from
 * the session (T-138), never the form — `upsertPosItemMap`/`decideMapRequest` own authorization.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { decideMapRequest, upsertPosItemMap } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/may not 'manage_pos_map'/.test(raw)) return 'Mapping a POS item needs manager access to this store.';
  if (/may not 'request_pos_map'/.test(raw)) return 'Flagging an unmappable item needs at least staff access to this store.';
  if (/may not 'decide_pos_map_request'/.test(raw)) return 'Deciding a mapping request needs manager access to this store.';
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
}

function back(storeId: string, params: Record<string, string>): never {
  redirect(`/inventory/pos-map?${new URLSearchParams({ store: storeId, ...params }).toString()}`);
}

export async function upsertPosItemMapAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/pos-map');
  const storeId = str(fd, 'storeId');
  const mode = str(fd, 'mode') as 'direct' | 'recipe' | 'no_stock';

  let result: Awaited<ReturnType<typeof upsertPosItemMap>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      upsertPosItemMap(tx, actor, {
        orgId: actor.orgId,
        storeId,
        posItemKey: str(fd, 'posItemKey'),
        posItemName: str(fd, 'posItemName'),
        mode,
        itemId: mode === 'direct' ? str(fd, 'itemId') || null : null,
        recipeId: mode === 'recipe' ? str(fd, 'recipeId') || null : null,
        quantityPerSale: mode === 'direct' ? str(fd, 'quantityPerSale') || null : null,
        locationId: str(fd, 'locationId') || null,
        confirmShared: str(fd, 'confirmShared') === 'true',
        editMapId: str(fd, 'editMapId') || null,
      }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(storeId, { error: result!.reason, ...(result!.needsConfirmation ? { needsConfirmation: '1' } : {}) });
  }

  revalidatePath('/inventory/pos-map');
  back(storeId, { ok: 'Mapping saved.' });
}

export async function decideMapRequestAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/pos-map');
  const storeId = str(fd, 'storeId');
  const requestId = str(fd, 'requestId');
  const decision = str(fd, 'decision') as 'approved' | 'rejected';

  let result: Awaited<ReturnType<typeof decideMapRequest>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      decideMapRequest(tx, actor, { requestId, decision, note: str(fd, 'note') || null }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(storeId, { error: result!.reason });
  }

  revalidatePath('/inventory/pos-map');
  back(storeId, {
    ok: decision === 'approved' ? 'Request approved — recorded as "sells, consumes no stock."' : 'Request rejected — item returns to unmapped.',
  });
}
