/**
 * T-441 - the file id a form action should claim, from either way a photo can arrive.
 *
 * - JavaScript on: the control already uploaded the file on pick and posts `<name>FileId`. That id wins, and the bytes
 *   are not sent twice.
 * - JavaScript off: the form posts the file itself under `<name>`; it is uploaded here by the same actor.
 * - Nothing posted: null.
 *
 * It does NOT link anything. The action inserts its record first and then claims the id with the domain claim (linking it to the record)
 * for either path, so both end linked and a failed insert leaves only a sweepable orphan. No `next/*` import: callable
 * from any server action.
 */
import type { Actor } from '@shareat/auth';
import type { FilePurpose, Tx } from '@shareat/db';
import { uploadFile } from '@shareat/domain';

export async function resolveUploadedFile(
  tx: Tx,
  actor: Actor,
  formData: FormData,
  name: string,
  opts: { purpose: FilePurpose; storeId: string | null },
): Promise<string | null> {
  const posted = formData.get(`${name}FileId`);
  if (typeof posted === 'string' && posted.trim() !== '') return posted.trim();

  const file = formData.get(name);
  if (file instanceof File && file.size > 0) {
    const uploaded = await uploadFile(tx, actor, {
      purpose: opts.purpose,
      storeId: opts.storeId,
      contentType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return uploaded.fileId;
  }
  return null;
}
