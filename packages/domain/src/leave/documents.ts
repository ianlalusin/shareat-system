/**
 * T-436 S6 - medical-certificate photos for a leave request (spec D14). Attach (a manager's act) and `leaveProofFileId` (decide only);
 * the one reader is `readFileUrl` behind GET /files/{id} (T-441 S4).
 *
 * The bytes go through the file broker (`uploadFile`: purpose `leave_document`, jpeg / png / webp, the app-wide 1 MB photo cap, EXIF
 * stripped) and are claimed for the request at upload (`linked_to` = the request id), so the orphan sweep leaves them alone.
 */
import { leaveRepo, UUID_SHAPE, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { gone } from '../shared/refusal';
import { claimUpload, linkFile, uploadFile } from '../files';
import { decideLeaveDocumentRead } from './document-access';
import { leaveRefusal } from './refusal';

const run = <T>(tx: Tx, fn: (trx: Tx) => Promise<T>): Promise<T> => fn(tx);

/**
 * Attaches a photo to a request. A manage_attendance holder at the request's store; the employee and a colleague cannot.
 * Two ways in: `{ fileId }` claims a photo the upload control already stored (T-441: the claim checks it is the actor's own,
 * unlinked, fresh, of this purpose and this request's store), or `{ contentType, bytes }` uploads it here (the no-JS path).
 */
export function attachLeaveDocument(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; fileId: string } | { requestId: string; contentType: string; bytes: Uint8Array },
): Promise<{ fileId: string }> {
  return run(tx, async (trx) => {
    const request = await leaveRepo.getRequest(trx, actor.orgId, input.requestId);
    if (!request) throw gone('leave: that request does not exist', 'leave request');
    await authorize(trx, actor, 'manage_attendance', { storeId: request.storeId });
    if (request.status === 'cancelled' || request.status === 'rejected') {
      throw leaveRefusal('LEAVE_DOCUMENT_REFUSED', 'A certificate cannot be attached to a request that was cancelled or rejected.');
    }
    if ('fileId' in input) {
      await claimUpload(trx, actor, { fileId: input.fileId, purpose: 'leave_document', storeId: request.storeId, linkTo: request.id });
      return { fileId: input.fileId };
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
 * The newest certificate's file id, ONLY if `decideLeaveDocumentRead` lets this viewer open it - else null. Decides and nothing
 * else: no audit row (the audited event is the GET of `/files/{id}` that the Lightbox makes). Any fault is null.
 */
export async function leaveProofFileId(tx: Tx, actor: Actor, input: { requestId: string }): Promise<string | null> {
  if (!UUID_SHAPE.test(input.requestId)) return null;
  try {
    return await run(tx, async (trx) => {
      const fileId = await leaveRepo.proofFileOf(trx, actor.orgId, input.requestId);
      if (!fileId) return null;
      const verdict = await decideLeaveDocumentRead(trx, actor, { id: fileId });
      return verdict.allowed ? fileId : null;
    });
  } catch {
    return null;
  }
}
