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
import {
  approveLeave,
  attachLeaveDocument,
  cancelLeave,
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
    // T-440 S9: the raw date fields travel to the domain, which judges them once the gate has passed.
    screen: { from: str(fd, 'from'), to: str(fd, 'to'), birthDate: str(fd, 'birthDate') },
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

/**
 * A manager attaches a medical-certificate photo. The control uploaded it on pick (`certificateFileId`), or, with JavaScript off,
 * the form posts the file itself. Either way the domain does the work: it checks the right and the request's state FIRST, and
 * only then claims the uploaded id or stores the posted bytes, so a refused save leaves nothing behind. The store is the
 * request's own, read by the domain. Nothing about the file is echoed back.
 */
export async function attachLeaveDocumentAction(formData: FormData): Promise<void> {
  const { actor } = await requireSession();
  const requestId = str(formData, 'requestId');
  const fileId = str(formData, 'certificateFileId');
  const photo = formData.get('certificate');
  const hasFile = photo instanceof File && photo.size > 0;
  if (!fileId && !hasFile) return await redirectWithFlash(BACK, {}, { error: 'Choose a photo of the certificate first.' });
  try {
    const bytes = !fileId && hasFile ? new Uint8Array(await photo.arrayBuffer()) : null;
    await withOrgPrincipal(actor.orgId, (tx) =>
      attachLeaveDocument(
        tx,
        actor,
        fileId ? { requestId, fileId } : { requestId, contentType: (photo as File).type, bytes: bytes! },
      ),
    );
  } catch (err) {
    return await redirectWithFlash(BACK, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(BACK, {}, { ok: 'Certificate attached.' });
}
