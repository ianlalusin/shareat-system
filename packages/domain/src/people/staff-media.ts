/**
 * T-434 - a staff member's PHOTO (on the employment: the store's ID card) and SIGNATURE (on the person: their legal mark).
 * `docs/tasks/434-staff-photo-and-signature.md`, bible row 353 ("strictly guard staff info, especially the signature").
 *
 * ## Who can CHANGE (upload / replace / remove)
 * `enrol_staff` at the store of an OPEN employment of the person. Staff cannot do their own (actor person = target person is
 * refused even for a manager who holds `enrol_staff`). A signature is changed by someone who holds `enrol_staff` at ANY store where
 * the person has an open employment.
 *
 * ## Who can SEE
 * Photo: `enrol_staff` at the file's store (the shared file rule, unchanged). Signature: only `files/signature.ts` decides - a separate,
 * narrower rule, audited per view. Nothing here returns a signature file id: callers learn `hasSignature` and `canViewSignature`.
 *
 * ## Input is bytes, never a data URL
 * The signature arrives as PNG bytes (multipart, via the broker). A `data:` string is refused wherever it appears.
 */
import { authorize, can, AuthorizationError, type Actor } from '@shareat/auth';
import { accessRepo, auditLogRepo, employmentRepo, filesRepo, personsRepo, refuse, type Tx } from '@shareat/db';
import { uploadFile } from '../files';
import { assertMayLearnSignatureAbsent, auditSignatureChange, mayViewSignature, signatureBytes, signatureUrl } from '../files/signature';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikeDataUrl(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().toLowerCase().startsWith('data:');
  if (v instanceof Uint8Array) {
    const head = new TextDecoder().decode(v.subarray(0, 5)).toLowerCase();
    return head === 'data:';
  }
  return false;
}

/** The signature must be real PNG bytes: not a string, not a `data:` URL, not a file that merely claims image/png. */
function assertSignaturePng(contentType: unknown, bytes: unknown): asserts bytes is Uint8Array {
  if (looksLikeDataUrl(contentType) || looksLikeDataUrl(bytes) || !(bytes instanceof Uint8Array)) {
    throw refuse('setStaffSignature: input must be PNG bytes, not a data URL', 'Draw the signature on the pad and save it; a pasted image string is not accepted.');
  }
  if (contentType !== 'image/png' || bytes.length < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => bytes[i] !== b)) {
    throw refuse('setStaffSignature: not a PNG', 'A signature must be a PNG image drawn on the pad.');
  }
}

function selfRefusal(): AuthorizationError {
  return new AuthorizationError(
    'authorize: staff may not change their own photo or signature',
    'enrol_staff',
    "You can't change your own photo or signature. Ask your manager.",
  );
}

/** The store to file a person-level change under: the first open employment where the actor holds `enrol_staff`. Throws a real refusal otherwise. */
async function signatureChangeStore(tx: Tx, actor: Actor, personId: string): Promise<string> {
  if (actor.personId === personId) throw selfRefusal();
  const open = await employmentRepo.listOpenForPerson(tx, personId);
  for (const e of open) {
    if (await can(tx, actor, 'enrol_staff', { storeId: e.storeId })) return e.storeId;
  }
  if (open[0]) await authorize(tx, actor, 'enrol_staff', { storeId: open[0].storeId }); // throws (and is logged as a denial)
  throw new AuthorizationError(
    'authorize: no open employment to change a signature under',
    'enrol_staff',
    'This person has no current job at a store you manage, so you cannot change their signature.',
  );
}

async function openEmploymentForPhoto(tx: Tx, actor: Actor, employmentId: string) {
  const emp = await employmentRepo.getEmployment(tx, employmentId);
  if (!emp || emp.orgId !== actor.orgId) throw refuse('staff photo: no such employment', 'That employment does not exist.');
  if (actor.personId === emp.personId) throw selfRefusal();
  await authorize(tx, actor, 'enrol_staff', { storeId: emp.storeId });
  if (emp.endedOn !== null) throw refuse('staff photo: employment ended', 'This employment has ended, so its photo cannot be changed.');
  return emp;
}

// ------------------------------------------------------------------ photo

export async function setStaffPhoto(
  tx: Tx,
  actor: Actor,
  input: { employmentId: string; contentType: string; bytes: Uint8Array },
): Promise<{ fileId: string }> {
  const emp = await openEmploymentForPhoto(tx, actor, input.employmentId);
  const previous = (await employmentRepo.photoFileIds(tx, [emp.id])).get(emp.id) ?? null;
  const up = await uploadFile(tx, actor, { purpose: 'staff_photo', storeId: emp.storeId, contentType: input.contentType, bytes: input.bytes });
  await filesRepo.linkFile(tx, actor.orgId, up.fileId, emp.id);
  await employmentRepo.setPhotoFileId(tx, emp.id, up.fileId);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: previous ? 'staff_photo.replaced' : 'staff_photo.set',
    storeId: emp.storeId,
    entityId: emp.id,
    before: null,
    after: { hadPrevious: previous !== null },
    source: 'web',
  });
  return { fileId: up.fileId };
}

export async function removeStaffPhoto(tx: Tx, actor: Actor, input: { employmentId: string }): Promise<void> {
  const emp = await openEmploymentForPhoto(tx, actor, input.employmentId);
  const previous = (await employmentRepo.photoFileIds(tx, [emp.id])).get(emp.id) ?? null;
  if (!previous) return;
  await employmentRepo.setPhotoFileId(tx, emp.id, null);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'staff_photo.removed',
    storeId: emp.storeId,
    entityId: emp.id,
    before: null,
    after: { hadPrevious: true },
    source: 'web',
  });
}

// ------------------------------------------------------------------ signature

export async function setStaffSignature(
  tx: Tx,
  actor: Actor,
  input: { personId: string; contentType: string; bytes: Uint8Array },
): Promise<{ fileId: string }> {
  const storeId = await signatureChangeStore(tx, actor, input.personId);
  assertSignaturePng(input.contentType, input.bytes);
  const previous = await personsRepo.getSignatureFileId(tx, actor.orgId, input.personId);
  const up = await uploadFile(tx, actor, { purpose: 'staff_signature', storeId, contentType: input.contentType, bytes: input.bytes });
  // linked_to = the PERSON on every signature file: the orphan sweep never collects it, and an old file still resolves to its person.
  await filesRepo.linkFile(tx, actor.orgId, up.fileId, input.personId);
  await personsRepo.setSignatureFileId(tx, actor.orgId, input.personId, up.fileId);
  await auditSignatureChange(tx, actor, input.personId, storeId, { removed: false, hadPrevious: previous !== null });
  return { fileId: up.fileId };
}

export async function removeStaffSignature(tx: Tx, actor: Actor, input: { personId: string }): Promise<void> {
  const storeId = await signatureChangeStore(tx, actor, input.personId);
  const previous = await personsRepo.getSignatureFileId(tx, actor.orgId, input.personId);
  if (!previous) return;
  await personsRepo.setSignatureFileId(tx, actor.orgId, input.personId, null); // the old stored_files row is kept (restrict FK, history)
  await auditSignatureChange(tx, actor, input.personId, storeId, { removed: true, hadPrevious: true });
}

/** The person's CURRENT signature file, or a refusal that says nothing about why. */
async function currentSignatureFile(tx: Tx, actor: Actor, personId: string, via: 'screen' | 'print') {
  const id = await personsRepo.getSignatureFileId(tx, actor.orgId, personId);
  const file = id ? await filesRepo.getById(tx, actor.orgId, id) : undefined;
  if (!file) await assertMayLearnSignatureAbsent(tx, actor, personId, via); // refuses a non-viewer identically to "has one"
  if (!file) throw refuse('signature: none on file', 'There is no signature on file for this person.');
  return file;
}

/** A 60 s link for the "View signature" click on the staff detail page. Gated, audited (viewed / view_refused). */
export async function viewStaffSignatureUrl(tx: Tx, actor: Actor, input: { personId: string }): Promise<{ url: string; contentType: string }> {
  return signatureUrl(tx, actor, await currentSignatureFile(tx, actor, input.personId, 'screen'));
}

/** For print routes (payslip, cash advance form, ID card): the image BYTES, server-side only, gated and audited like a view. Never a URL. */
export async function signatureForPrint(tx: Tx, actor: Actor, input: { personId: string }): Promise<{ bytes: Uint8Array; contentType: string }> {
  return signatureBytes(tx, actor, await currentSignatureFile(tx, actor, input.personId, 'print'));
}

/**
 * The staff detail page's media loader. ⭐ Returns booleans for the signature, never its id, and the photo id only to a viewer who
 * holds `enrol_staff` at that store. The viewer must have store scope at the employment's store (else the same refusal as a
 * forged id).
 */
export async function staffMediaView(
  tx: Tx,
  actor: Actor,
  input: { employmentId: string },
): Promise<{ hasSignature: boolean; canViewSignature: boolean; photoFileId: string | null }> {
  const emp = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!emp || emp.orgId !== actor.orgId || !(await accessRepo.personHasStoreScope(tx, actor.personId, emp.storeId))) {
    throw refuse('staff media: not visible', 'That employment does not exist.');
  }
  const photo = (await employmentRepo.photoFileIds(tx, [emp.id])).get(emp.id) ?? null;
  const photoFileId = photo && (await can(tx, actor, 'enrol_staff', { storeId: emp.storeId })) ? photo : null;

  const sigId = await personsRepo.getSignatureFileId(tx, actor.orgId, emp.personId);
  const file = sigId ? await filesRepo.getById(tx, actor.orgId, sigId) : undefined;
  return {
    hasSignature: file !== undefined,
    canViewSignature: file !== undefined && (await mayViewSignature(tx, actor, file)),
    photoFileId,
  };
}
