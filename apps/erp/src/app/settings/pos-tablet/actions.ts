'use server';

/**
 * Server actions for `/settings/pos-tablet`. T-464, docs/tasks/464-pos-tablet-sign-in.md s2.
 *
 * ⛔ No rule is re-implemented here. `pairPosTablet` / `unpairPosTablet` call `authorize(tx, actor, 'pair_pos_tablet', { storeId })`
 * as their own first statement and own every refusal sentence; these actions read the form, call them, and show the sentence.
 * The store, label and pairing id are the ONLY things read from the form; the capability is checked at the store the server resolves.
 */
import { redirect } from 'next/navigation';
import { authorize, signOut, pairPosTablet, unpairPosTablet } from '@shareat/auth';
import { posTabletPairingsRepo, refuse } from '@shareat/db';
import { requireActor, readSessionToken, clearSessionCookie, setPosTabletCookie, readPosTabletToken } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';
import { withOrgPrincipal } from '../../expenses/lib';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Pair THIS browser as the store's POS tablet. On success: the cookie holding the new secret is set, the manager's own session is
 * ended (the tablet must land on the Employee ID screen, not stay signed in as them) and the browser is sent to `/sign-in`.
 * Pairing a store that already has a tablet replaces it: the old one is revoked and its sessions end, in the same transaction.
 *
 * ⚠️ `redirect()` is called after the `try` (it throws to signal), as the sign-in actions do.
 */
export async function pairPosTabletAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-tablet');
  const storeId = str(fd, 'storeId');
  const label = str(fd, 'label');
  const previousToken = await readPosTabletToken();
  let token: string;
  try {
    ({ token } = await withOrgPrincipal(actor.orgId, (tx) => pairPosTablet(tx, actor, { storeId, label, previousToken })));
  } catch (err) {
    return await redirectWithFlash('/settings/pos-tablet', {}, { error: errorMessage(err) });
  }
  await setPosTabletCookie(token);
  const session = await readSessionToken();
  if (session) await signOut(null, session);
  await clearSessionCookie();
  redirect('/sign-in');
}

/**
 * Un-pair a tablet (works from any device: it is how a lost tablet is cut off). Tier R confirm (bible row 329): the manager retypes
 * the tablet's label, compared with the label the SERVER loads for that pairing - never one from the form.
 */
export async function unpairPosTabletAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-tablet');
  const pairingId = str(fd, 'pairingId');
  try {
    // A forged non-uuid id is "not paired", never a database syntax error.
    const row = UUID.test(pairingId)
      ? await withOrgPrincipal(actor.orgId, (tx) => posTabletPairingsRepo.getById(tx, actor.orgId, pairingId))
      : undefined;
    if (!row) throw refuse(`unpairPosTabletAction: pairing ${pairingId} not in org`, 'That tablet is not paired any more.');
    // Authorize at the RECORD's store before the confirm is looked at: someone who may not un-pair learns nothing about the label.
    await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, 'pair_pos_tablet', { storeId: row.storeId }));
    if (!retypeMatches(str(fd, 'confirmName'), row.label)) throw retypeRefusalError(row.label);
    await withOrgPrincipal(actor.orgId, (tx) => unpairPosTablet(tx, actor, { pairingId, confirmLabel: str(fd, 'confirmName') }));
  } catch (err) {
    return await redirectWithFlash('/settings/pos-tablet', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/settings/pos-tablet', {}, { ok: 'Tablet un-paired. It is signed out and will show the email sign-in again.' });
}
