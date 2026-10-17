'use server';

/**
 * Server actions for the POS item mapping screen — T-177.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. The actor comes from
 * the session (T-138), never the form — `upsertPosItemMap`/`decideMapRequest` own authorization.
 */
import { redirectWithFlash } from '@/lib/flash';
import { revalidatePath } from 'next/cache';
import { assertFieldRules, decideMapRequest, upsertPosItemMap } from '@shareat/domain';
import { INVENTORY_POS_MAP_RULES } from '@shareat/domain/field-rules';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function upsertPosItemMapAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/pos-map');
  const storeId = str(fd, 'storeId');
  const mode = str(fd, 'mode') as 'direct' | 'recipe' | 'no_stock';

  let result: Awaited<ReturnType<typeof upsertPosItemMap>> | undefined;
  try {
    assertFieldRules(INVENTORY_POS_MAP_RULES, fd);
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
    return await redirectWithFlash('/inventory/pos-map', { store: storeId }, { error: errorMessage(err) });
  }
  if (!result.ok) {
    return await redirectWithFlash('/inventory/pos-map', { store: storeId }, { error: result.reason, ...(result.needsConfirmation ? { needsConfirmation: '1' } : {}) });
  }

  revalidatePath('/inventory/pos-map');
  return await redirectWithFlash('/inventory/pos-map', { store: storeId }, { ok: 'Mapping saved.' });
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
    return await redirectWithFlash('/inventory/pos-map', { store: storeId }, { error: errorMessage(err) });
  }
  if (!result.ok) {
    return await redirectWithFlash('/inventory/pos-map', { store: storeId }, { error: result.reason });
  }

  revalidatePath('/inventory/pos-map');
  return await redirectWithFlash('/inventory/pos-map', { store: storeId }, {
    ok: decision === 'approved' ? 'Request approved — recorded as "sells, consumes no stock."' : 'Request rejected — item returns to unmapped.',
  });
}
