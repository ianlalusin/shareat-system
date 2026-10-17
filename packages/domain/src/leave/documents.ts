/**
 * T-436 S6 - medical-certificate photos for a leave request (spec D14). Attach (a manager's act) and open (the ONLY reader).
 *
 * The bytes go through the file broker (`uploadFile`: purpose `leave_document`, jpeg / png / webp, the app-wide 1 MB photo cap, EXIF
 * stripped) and are claimed for the request at upload (`linked_to` = the request id), so the orphan sweep leaves them alone.
 */
import { transaction, leaveRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { gone } from '../shared/refusal';
import { FileNotFoundError, linkFile, readFileUrl, uploadFile } from '../files';
import { leaveRefusal } from './refusal';

const run = <T>(tx: Tx | null, fn: (trx: Tx) => Promise<T>): Promise<T> => (tx ? fn(tx) : transaction(fn));

/** Attaches a photo to a request. A manage_attendance holder at the request's store; the employee and a colleague cannot. */
export function attachLeaveDocument(
  tx: Tx | null,
  actor: Actor,
  input: { requestId: string; contentType: string; bytes: Uint8Array },
): Promise<{ fileId: string }> {
  return run(tx, async (trx) => {
    const request = await leaveRepo.getRequest(trx, actor.orgId, input.requestId);
    if (!request) throw gone('leave: that request does not exist', 'leave request');
    await authorize(trx, actor, 'manage_attendance', { storeId: request.storeId });
    if (request.status === 'cancelled' || request.status === 'rejected') {
      throw leaveRefusal('LEAVE_DOCUMENT_REFUSED', 'A certificate cannot be attached to a request that was cancelled or rejected.');
    }
    const up = await uploadFile(trx, actor, {
      purpose: 'leave_document',
      storeId: request.storeId,
      contentType: input.contentType,
      bytes: input.bytes,
    });
    await linkFile(trx, actor.orgId, up.fileId, request.id);
    return { fileId: up.fileId };
  });
}

/**
 * Opens the newest certificate of a request: a link good for 60 seconds, and a `leave_document.viewed` row. Goes through
 * `readFileUrl`, whose leave-document branch is the one place the decision and the audit live; a viewer who may not open it
 * gets the same "not found" as a missing file, and a `leave_document.view_refused` row.
 */
export function openLeaveDocument(tx: Tx | null, actor: Actor, input: { requestId: string }): Promise<{ url: string }> {
  return run(tx, async (trx) => {
    const fileId = await leaveRepo.proofFileOf(trx, actor.orgId, input.requestId);
    if (!fileId) throw new FileNotFoundError(`readFileUrl: file for leave request ${input.requestId} does not exist in this org.`);
    const { url } = await readFileUrl(trx, actor, { fileId });
    return { url };
  });
}
