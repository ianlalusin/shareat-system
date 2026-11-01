'use server';

/**
 * Server actions for `/admin/pos-tablets`. T-505, docs/tasks/505-erp-pos-tablet-links.md.
 *
 * ⛔ No rule is re-implemented here. `provisionPosTerminalLink`, `revokePosTerminalLink` and `resetApprovalPinCap` call `authorize()` as
 * their own first decision and own every refusal sentence and audit row; these actions read the form, call them, and show the sentence.
 * Each action redirects AFTER its `try` (redirect() throws to signal), as the other admin actions do.
 */
import { revalidatePath } from 'next/cache';
import { posTerminalLinksRepo, refuse } from '@shareat/db';
import { authorize, resetApprovalPinCap } from '@shareat/auth';
import { assertFieldRules, provisionPosTerminalLink, revokePosTerminalLink } from '@shareat/domain';
import { POS_TABLET_REGISTER_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';
import { withOrgPrincipal } from '../../expenses/lib';
import { deviceTail, normaliseDeviceId, revokeConfirmName } from './lib';

const RETURN_TO = '/admin/pos-tablets';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function registerTabletAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RETURN_TO);
  const storeId = str(fd, 'storeId');
  const terminalNo = Number(str(fd, 'terminalNo'));
  const deviceId = normaliseDeviceId(str(fd, 'deviceId'));
  const terminalPersonId = str(fd, 'terminalPersonId');
  let ok: string;
  try {
    // Authorize first (the rules are checked after the gate, T-440 S9), then the form's own rules; the domain call decides again.
    if (!UUID.test(storeId)) throw refuse(`registerTabletAction: store ${storeId} is not an id`, 'Pick a store.');
    await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, 'provision_clock_terminal', { storeId }));
    assertFieldRules(POS_TABLET_REGISTER_RULES, fd);
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      // Name the link this one replaces, read in the same transaction as the write (only its last four characters reach the screen).
      const before = UUID.test(storeId) ? await posTerminalLinksRepo.listForStore(tx, actor.orgId, storeId, { revokedLimit: 0 }) : null;
      const made = await provisionPosTerminalLink(tx, actor, { storeId, terminalNo, deviceId, terminalPersonId });
      return { made, replaced: made.revokedLinkId && before?.active ? before.active : null };
    });
    ok = `Registered the tablet ending ${deviceTail(deviceId)} as terminal ${terminalNo}.` +
      (result.replaced ? ` It replaces the tablet ending ${deviceTail(result.replaced.deviceId)}, which no longer works.` : '');
  } catch (err) {
    return await redirectWithFlash(RETURN_TO, { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath(RETURN_TO);
  return await redirectWithFlash(RETURN_TO, { store: storeId }, { ok });
}

/** Tier R confirm: the person retypes "Terminal N", compared with the number of the link the SERVER loads, never one from the form. */
export async function revokeTabletAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RETURN_TO);
  const storeId = str(fd, 'storeId');
  const linkId = str(fd, 'linkId');
  try {
    const link = UUID.test(linkId)
      ? await withOrgPrincipal(actor.orgId, (tx) => posTerminalLinksRepo.getLinkByIdForUpdate(tx, actor.orgId, linkId))
      : undefined;
    if (!link) throw refuse(`revokeTabletAction: link ${linkId} not in org`, 'That tablet link does not exist any more.');
    // Authorize at the RECORD's store before the confirm is looked at: someone who may not revoke learns nothing about the link.
    await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, 'provision_clock_terminal', { storeId: link.storeId }));
    if (!retypeMatches(str(fd, 'confirmName'), revokeConfirmName(link.terminalNo))) throw retypeRefusalError(revokeConfirmName(link.terminalNo));
    await withOrgPrincipal(actor.orgId, (tx) => revokePosTerminalLink(tx, actor, { linkId }));
  } catch (err) {
    return await redirectWithFlash(RETURN_TO, { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath(RETURN_TO);
  return await redirectWithFlash(RETURN_TO, { store: storeId }, { ok: 'Tablet link revoked. Refund approvals on that tablet stop until a tablet is registered again.' });
}

export async function clearLockAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RETURN_TO);
  const storeId = str(fd, 'storeId');
  const personId = str(fd, 'personId');
  let ok: string;
  try {
    const { cleared } = await withOrgPrincipal(actor.orgId, (tx) => resetApprovalPinCap(tx, actor, personId));
    ok = cleared ? 'Lock cleared. Approvals on this tablet work again.' : 'That tablet was not locked.';
  } catch (err) {
    return await redirectWithFlash(RETURN_TO, { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath(RETURN_TO);
  return await redirectWithFlash(RETURN_TO, { store: storeId }, { ok });
}
