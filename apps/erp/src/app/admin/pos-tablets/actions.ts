'use server';

/**
 * Server actions for `/admin/pos-tablets`. T-505, docs/tasks/505-erp-pos-tablet-links.md.
 *
 * ⛔ No rule is re-implemented here. `provisionPosTerminalLink`, `revokePosTerminalLink` and `resetApprovalPinCap` call `authorize()` as
 * their own first decision and own every refusal sentence and audit row; these actions read the form, call them, and show the sentence.
 * Each action redirects AFTER its `try` (redirect() throws to signal), as the other admin actions do.
 *
 * T-546: `createTillAction`, `linkTillAction` and `setTillPrinterAction` (the Tills section) are the same: the form is read here as plain numbers and text,
 * `createTerminal` / `linkTerminal` / `setTerminalPrinter` authorize first and own every rule, refusal sentence and audit row.
 */
import { revalidatePath } from 'next/cache';
import { posTerminalLinksRepo, refuse } from '@shareat/db';
import { authorize, resetApprovalPinCap } from '@shareat/auth';
import { assertFieldRules, createTerminal, linkTerminal, provisionPosTerminalLink, revokePosTerminalLink, setTerminalPrinter } from '@shareat/domain';
import { POS_TABLET_REGISTER_RULES, POS_TILL_ADD_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';
import { withOrgPrincipal } from '../../expenses/lib';
import { deviceTail, normaliseDeviceId, revokeConfirmName } from './lib';

const RETURN_TO = '/admin/pos-tablets';
/** T-546: the Tills section also lives on the manager's page; the form says which page to come back to, and only these two are believed. */
const TILL_PAGES = [RETURN_TO, '/settings/pos-tablet'] as const;
function tillPage(fd: FormData): string {
  const v = str(fd, 'returnTo');
  return TILL_PAGES.find((p) => p === v) ?? RETURN_TO;
}
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

/** T-546: add a till (number 1 to 99). The domain refuses a used number or a bad one in words. */
export async function createTillAction(fd: FormData): Promise<void> {
  const actor = await requireActor(tillPage(fd));
  const storeId = str(fd, 'storeId');
  const terminalNo = Number(str(fd, 'terminalNo'));
  let ok: string;
  try {
    // Authorize first, then the form's own rule (T-440 S9); the domain call decides again and owns the refusal sentence.
    if (!UUID.test(storeId)) throw refuse(`createTillAction: store ${storeId} is not an id`, 'Pick a store.');
    await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, 'pair_pos_tablet', { storeId }));
    assertFieldRules(POS_TILL_ADD_RULES, fd);
    await withOrgPrincipal(actor.orgId, (tx) => createTerminal(tx, actor, { storeId, terminalNo }));
    ok = `Added till ${terminalNo}. Choose its tablet and printer below.`;
  } catch (err) {
    return await redirectWithFlash(tillPage(fd), { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath(tillPage(fd));
  return await redirectWithFlash(tillPage(fd), { store: storeId }, { ok });
}

/** T-546: choose which paired tablet acts as a till; an empty `pairingId` is "No tablet" (un-link). */
export async function linkTillAction(fd: FormData): Promise<void> {
  const actor = await requireActor(tillPage(fd));
  const storeId = str(fd, 'storeId');
  const pairingId = str(fd, 'pairingId');
  let ok: string;
  try {
    await withOrgPrincipal(actor.orgId, (tx) => linkTerminal(tx, actor, { storeId, terminalId: str(fd, 'terminalId'), pairingId: pairingId === '' ? null : pairingId }));
    ok = pairingId === '' ? 'The till has no tablet now.' : 'Tablet chosen for the till.';
  } catch (err) {
    return await redirectWithFlash(tillPage(fd), { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath(tillPage(fd));
  return await redirectWithFlash(tillPage(fd), { store: storeId }, { ok });
}

/** T-546: the till's receipt paper (58 or 80 mm) and copies (1 to 3). The tablet picks them up with its next snapshot. */
export async function setTillPrinterAction(fd: FormData): Promise<void> {
  const actor = await requireActor(tillPage(fd));
  const storeId = str(fd, 'storeId');
  let ok: string;
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setTerminalPrinter(tx, actor, { storeId, terminalId: str(fd, 'terminalId'), receiptPaperMm: Number(str(fd, 'receiptPaperMm')), receiptCopies: Number(str(fd, 'receiptCopies')) }),
    );
    ok = 'Printer settings saved. The tablet uses them after its next refresh.';
  } catch (err) {
    return await redirectWithFlash(tillPage(fd), { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath(tillPage(fd));
  return await redirectWithFlash(tillPage(fd), { store: storeId }, { ok });
}
