'use server';

/**
 * Server actions for `/attendance/leave`. T-436.
 *
 * ⭐ Every gate lives in the domain, not here. `requestLeave` / `recordLeave` / `approveLeave` / `rejectLeave` / `cancelLeave` /
 * `voidLeave` authorize, take the person's lock, and apply caps, the SIL balance and the nobody-approves-their-own rule. A check in
 * an action protects one caller; these add none. The screen only SHOWS why a control is closed.
 *
 * ⚠️ One action per decision, never one generic action taking a `kind` from the form (the form would choose which decision was made).
 * ⚠️ No person id is read from the form: the actor is the session, and a request is filed under an EMPLOYMENT the domain checks.
 */
import { redirect } from 'next/navigation';
import {
  approveLeave,
  attachLeaveDocument,
  cancelLeave,
  openLeaveDocument,
  recordLeave,
  rejectLeave,
  requestLeave,
  voidLeave,
} from '@shareat/domain';
import { redirectWithFlash } from '@/lib/flash';
import { errorMessage } from '@/lib/constraint-messages';
import { requireSession } from '../../../lib/session';
import { expandRange, withOrgPrincipal } from './lib';

const BACK = '/attendance/leave';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** "2026-03-04, 2026-03-05" -> a set of dates the person has off anyway (v2 has no roster, so the person says so). */
function restDaySet(fd: FormData): Set<string> {
  return new Set(
    str(fd, 'restDays')
      .split(/[\s,;]+/)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  );
}

/** The pay choice: '' = as the kind decides, 'paid' / 'unpaid' = the manager's call. */
function payChoice(fd: FormData): boolean | undefined {
  const v = str(fd, 'pay');
  return v === 'paid' ? true : v === 'unpaid' ? false : undefined;
}

function leaveInput(fd: FormData) {
  return {
    employmentId: str(fd, 'employmentId'),
    leaveType: str(fd, 'leaveType'),
    days: expandRange(str(fd, 'from'), str(fd, 'to') || str(fd, 'from'), restDaySet(fd)),
    note: str(fd, 'note') || null,
    birthDate: str(fd, 'birthDate') || null,
  };
}

export async function requestLeaveAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  try {
    await withOrgPrincipal(actor.orgId, (tx) => requestLeave(tx, actor, leaveInput(formData)));
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Leave requested. A manager will decide it.' });
}

export async function recordLeaveAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  try {
    await withOrgPrincipal(actor.orgId, (tx) => recordLeave(tx, actor, { ...leaveInput(formData), paid: payChoice(formData) }));
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Absence recorded.' });
}

export async function approveLeaveAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  try {
    await withOrgPrincipal(actor.orgId, (tx) => approveLeave(tx, actor, { requestId: str(formData, 'requestId'), paid: payChoice(formData) }));
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Leave approved.' });
}

export async function rejectLeaveAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  try {
    await withOrgPrincipal(actor.orgId, (tx) => rejectLeave(tx, actor, { requestId: str(formData, 'requestId'), reason: str(formData, 'reason') }));
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Leave rejected.' });
}

export async function cancelLeaveAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  try {
    await withOrgPrincipal(actor.orgId, (tx) => cancelLeave(tx, actor, { requestId: str(formData, 'requestId') }));
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Request cancelled.' });
}

export async function voidLeaveAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  try {
    await withOrgPrincipal(actor.orgId, (tx) => voidLeave(tx, actor, { requestId: str(formData, 'requestId'), reason: str(formData, 'reason') }));
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Leave voided.' });
}

/** A manager attaches a medical-certificate photo. The domain stores it through the file broker; nothing about it is echoed back. */
export async function attachLeaveDocumentAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  const photo = formData.get('certificate');
  if (!(photo instanceof File) || photo.size === 0) {
    return await redirectWithFlash(BACK, {}, { error: 'Choose a photo of the certificate first.' });
  }
  try {
    const bytes = new Uint8Array(await photo.arrayBuffer());
    await withOrgPrincipal(actor.orgId, (tx) =>
      attachLeaveDocument(tx, actor, { requestId: str(formData, 'requestId'), contentType: photo.type, bytes }),
    );
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Certificate attached.' });
}

/**
 * Opens a certificate: a link good for 60 seconds, and a row in the activity log. Anyone not allowed gets the same plain
 * message as for a certificate that does not exist.
 */
export async function openLeaveDocumentAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  let url: string;
  try {
    ({ url } = await withOrgPrincipal(actor.orgId, (tx) => openLeaveDocument(tx, actor, { requestId: str(formData, 'requestId') })));
  } catch {
    return await redirectWithFlash(BACK, {}, { error: "This certificate isn't available to you." });
  }
  redirect(`${url}`);
}
