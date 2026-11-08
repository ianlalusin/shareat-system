/**
 * T-529 - which store a POS Server Action works at. Server only (not a 'use server' file: a helper may export a plain object).
 * On a PAIRED tablet the pairing's store wins and a different `storeId` is refused with the state route's own sentence; with no pairing (a phone or a kitchen
 * browser) the store the screen names is used and the domain's `authorize()` decides whether this person may act there.
 */
import type { Actor } from '@shareat/auth';
import { tabletPairing } from '@/lib/pos-api';
import { effectiveStore } from '../lib';

export const ONE_STORE_ONLY = 'This tablet works at one store only.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function actionStore(actor: Actor, storeId: unknown): Promise<{ storeId: string } | { error: string }> {
  const pairing = await tabletPairing();
  const chosen = effectiveStore(pairing && pairing.orgId === actor.orgId ? pairing : null, typeof storeId === 'string' ? storeId : undefined);
  if (chosen.refused) return { error: ONE_STORE_ONLY };
  if (!chosen.storeId || !UUID.test(chosen.storeId)) return { error: 'Say which store this is for.' };
  return { storeId: chosen.storeId.toLowerCase() };
}
