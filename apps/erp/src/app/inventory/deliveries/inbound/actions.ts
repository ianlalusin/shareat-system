'use server';

/**
 * Server action for the inbound-shipment receipt form - T-398 S5d.
 *
 * Thin adapter: parse FormData, call the domain, redirect with a message. The actor comes from the session, never the form (T-138); authorisation is
 * `receiveInterEntityShipment`'s first statement. The shipment id is bound on the server (`.bind`), not posted as a hidden field.
 */
import { redirectWithFlash } from '@/lib/flash';
import { revalidatePath } from 'next/cache';
import { receiveInterEntityShipment } from '@shareat/domain';
import { errorMessage } from '@/lib/constraint-messages';
import { withActorPrincipal } from './lib';
import { requireActor } from '../../../../lib/session';
import { peso } from '../../../../lib/format';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

export async function receiveInterEntityShipmentAction(shipmentId: string, fd: FormData): Promise<void> {
  const here = `/inventory/deliveries/inbound/${shipmentId}`;
  const actor = await requireActor(here);
  const storeId = str(fd, 'store');
  const lineKeys = strs(fd, 'line');
  const itemIds = strs(fd, 'item');
  const counts = strs(fd, 'receivedQuantity');
  const lines = lineKeys.map((shipmentLineId, i) => ({
    shipmentLineId,
    itemId: itemIds[i] || null,
    receivedQuantity: counts[i] || '0',
  }));

  let message = '';
  try {
    const result = await withActorPrincipal(actor, (tx) => receiveInterEntityShipment(tx, actor, { shipmentId, storeId, lines }));
    message = `Received. Your books now show ${peso(result.receivedTotal)} owed to the commissary.`;
  } catch (err) {
    return await redirectWithFlash(here, {}, { error: errorMessage(err) });
  }

  revalidatePath('/inventory/deliveries/inbound');
  revalidatePath(here);
  return await redirectWithFlash(here, {}, { stamp: 'RECEIVED', ok: message });
}
