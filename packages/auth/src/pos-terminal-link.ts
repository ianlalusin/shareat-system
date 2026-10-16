/**
 * resolvePosTerminalLink - which ERP store and terminal person a POS v2 tablet is, from Postgres only (T-424 Ruling 5, B1 fix).
 *
 * `posStoreId` is the Firestore store id the caller is authorised for (staff/{uid}.assignedStoreIds); it must have a LIVE
 * `pos_v1_store_links` row. The tablet's `deviceId` must match the single ACTIVE `pos_terminal_links` row of THAT store. The store is
 * therefore decided by the live store link, never by the device's own row: a device id registered at another store, or a forged
 * one, resolves to "not registered". `deviceId` is validated as a uuid BEFORE any query (Postgres would answer a bad one with a
 * syntax error, which a request must never be able to provoke).
 */
import type { Tx } from '@shareat/db';
import { posTerminalLinksRepo } from '@shareat/db';
import { AuthenticationError } from './errors';
import { POS_TERMINAL_NOT_REGISTERED } from './pos-approval';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POS_DEVICE_ID_INVALID = 'The tablet device id is not valid.';

export function isPosDeviceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

export async function resolvePosTerminalLink(
  tx: Tx,
  input: { orgId: string; posStoreId: string; deviceId: string },
): Promise<{ erpStoreId: string; terminalPersonId: string; terminalNo: number; linkId: string }> {
  if (!isPosDeviceId(input.deviceId)) throw new AuthenticationError(POS_DEVICE_ID_INVALID);
  const link = await posTerminalLinksRepo.getActiveLinkForDevice(tx, input.orgId, input.posStoreId, input.deviceId.toLowerCase());
  if (!link) throw new AuthenticationError(POS_TERMINAL_NOT_REGISTERED);
  return { erpStoreId: link.storeId, terminalPersonId: link.terminalPersonId, terminalNo: link.terminalNo, linkId: link.id };
}
