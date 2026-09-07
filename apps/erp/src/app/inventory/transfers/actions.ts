'use server';

/**
 * Server actions for the stock-transfers screen — T-167.
 *
 * Thin adapters: parse `FormData`, call the domain, revalidate. ⭐ **The actor comes from the
 * session, never the form** (T-138) — `tests/unit/no-client-supplied-actor.test.ts` fails the
 * build if that ever changes. Authorization itself is `transferNow`/`dispatch`/etc.'s own first
 * statement, not repeated here.
 */
import { revalidatePath } from 'next/cache';
import { transaction } from '@shareat/db';
import {
  dispatch,
  quantity,
  receiveTransfer,
  saveDraft,
  transferNow,
  voidTransfer,
} from '@shareat/domain';
import { requireActor } from '../../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createTransferAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/transfers');
  const storeId = str(fd, 'storeId');
  const fromLocationId = str(fd, 'fromLocationId');
  const toLocationId = str(fd, 'toLocationId');
  const itemId = str(fd, 'itemId');
  const qty = str(fd, 'quantity');
  const mode = str(fd, 'mode');
  const note = str(fd, 'note');

  const input = {
    storeId,
    fromLocationId,
    toLocationId,
    lines: [{ itemId, quantity: quantity(qty) }],
    note: note || null,
    actor,
  };

  const result = await transaction((tx) =>
    mode === 'two_step' ? saveDraft(tx, input) : transferNow(tx, input),
  );
  if (!result.ok) throw new Error(result.reason);

  revalidatePath('/inventory/transfers');
}

export async function dispatchTransferAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/transfers');
  const transferId = str(fd, 'transferId');
  const result = await transaction((tx) => dispatch(tx, actor, transferId));
  if (!result.ok) throw new Error(result.reason);
  revalidatePath('/inventory/transfers');
}

export async function receiveTransferAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/transfers');
  const transferId = str(fd, 'transferId');
  const result = await transaction((tx) => receiveTransfer(tx, actor, transferId));
  if (!result.ok) throw new Error(result.reason);
  revalidatePath('/inventory/transfers');
}

export async function voidTransferAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/transfers');
  const transferId = str(fd, 'transferId');
  const reason = str(fd, 'reason');
  const result = await transaction((tx) => voidTransfer(tx, actor, transferId, reason));
  if (!result.ok) throw new Error(result.reason);
  revalidatePath('/inventory/transfers');
}
