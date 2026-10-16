/**
 * T-434 / bible row 353 - the ONE rule for opening a staff SIGNATURE file, and the audit of every attempt.
 *
 * ## ⛔ Why signatures do not use the shared read check
 *
 * Every other purpose is read with `PURPOSE_CAPABILITY[purpose]` at the file's store (`assertCanRead` / `canReadFiles`). For
 * `staff_signature` that capability (`enrol_staff`) governs UPLOAD only. A signature can be forged, so reading it is a separate,
 * narrower rule that lives only here, and `readFileUrl` / `canReadFiles` route around the shared check for this purpose.
 *
 * ## The rule (`mayViewSignature`) - exactly two ways in
 *
 * a) `view_staff_signature` held at ANY store where the person has an OPEN employment. A person with no open employment (the file is
 *    effectively store-less): administrators only (admin / super_admin by role).
 * b) The uploader, narrowly: the viewer uploaded THIS file, it is the person's CURRENT signature, and the viewer holds `enrol_staff` at a
 *    store where the person has an open employment that was CREATED before the upload. (`created_at`, not `started_on`: a start date can
 *    be back-dated, so a hire made after the upload grants nothing.)
 *
 * Old, replaced or removed signature files resolve to their person through `stored_files.linked_to` and are viewable via (a) only.
 *
 * ## Audit (DEF-668, signatures only)
 *
 * `staff_signature.viewed` is written in the SAME transaction that mints the link, after the check passes. A refusal writes
 * `staff_signature.view_refused` in a SEPARATE transaction (the caller's rolls back with the refusal). Payloads carry no file id, path or URL.
 */
import { AuthorizationError, can, type Actor } from '@shareat/auth';
import { accessRepo, auditLogRepo, employmentRepo, personsRepo, withOrgPrincipal, type StoredFileRow, type Tx } from '@shareat/db';
import { logger } from '@shareat/core/logger';
import { resolveStorageDriver } from './driver';

/** A signature link lives this long, enforced here and never by the caller. */
export const SIGNATURE_LINK_SECONDS = 60;

/** A fresh instance each time (an Error carries its stack). The text names no file, path, person or store. */
function refusal(): AuthorizationError {
  return new AuthorizationError(
    'authorize: a staff signature may not be opened by this person',
    'view_staff_signature',
    "You can't open this signature.",
  );
}

export type SignatureFile = Pick<StoredFileRow, 'id' | 'storagePath' | 'contentType' | 'linkedTo' | 'uploadedBy' | 'uploadedAt' | 'orgId'>;

/** The yes/no. Writes nothing. Never reads or fills the shared `canReadFiles` verdict cache. */
export async function mayViewSignature(tx: Tx, actor: Actor, file: SignatureFile): Promise<boolean> {
  const personId = file.linkedTo;
  const open = personId ? await employmentRepo.listOpenForPerson(tx, personId) : [];

  // (a) the capability, at any store of an open job
  for (const e of open) {
    if (await can(tx, actor, 'view_staff_signature', { storeId: e.storeId })) return true;
  }
  // no open job: administrators only (by role, never by a grant)
  if (open.length === 0) {
    const role = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
    return role?.role === 'admin' || role?.role === 'super_admin';
  }

  // (b) the uploader, narrowly
  if (personId && file.uploadedBy === actor.personId) {
    const current = await personsRepo.getSignatureFileId(tx, actor.orgId, personId);
    if (current === file.id) {
      for (const e of open) {
        if (e.createdAt.getTime() < file.uploadedAt.getTime() && (await can(tx, actor, 'enrol_staff', { storeId: e.storeId }))) return true;
      }
    }
  }
  return false;
}

/**
 * A set / replace / remove row. `entityId` is the PERSON; the payload is one flat boolean, never an id, path or URL.
 * (The action strings are literals on purpose: the audit build guard scans for them.)
 */
export async function auditSignatureChange(
  tx: Tx,
  actor: Actor,
  personId: string,
  storeId: string,
  change: { removed: boolean; hadPrevious: boolean },
): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: change.removed ? 'staff_signature.removed' : change.hadPrevious ? 'staff_signature.replaced' : 'staff_signature.set',
    storeId,
    entityId: personId,
    before: null,
    after: { hadPrevious: change.hadPrevious },
    source: 'web',
  });
}

/** A `viewed` row (same transaction as the minted link) or a `view_refused` row. `entityId` is the PERSON. */
async function auditSignatureView(tx: Tx, actor: Actor, personId: string, refused: boolean, via: 'screen' | 'print'): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: refused ? 'staff_signature.view_refused' : 'staff_signature.viewed',
    storeId: null,
    entityId: personId,
    before: null,
    after: { via },
    source: 'web',
  });
}

/** `view_refused` in its OWN transaction so it survives the caller's rollback. A failure to write it must not hide the refusal. */
async function auditRefusedView(actor: Actor, personId: string): Promise<void> {
  try {
    await withOrgPrincipal(actor.orgId, (t) => auditSignatureView(t, actor, personId, true, 'screen'));
  } catch (err) {
    logger.error({ kind: 'fault', errorName: err instanceof Error ? err.name : typeof err }, 'files: could not record a refused signature view');
  }
}

/** Check + audit. Throws a refusal (after recording it) or resolves once the `viewed` row is written. */
async function gate(tx: Tx, actor: Actor, file: SignatureFile, via: 'screen' | 'print'): Promise<void> {
  const personId = file.linkedTo ?? actor.personId;
  if (!(await mayViewSignature(tx, actor, file))) {
    await auditRefusedView(actor, personId);
    throw refusal();
  }
  await auditSignatureView(tx, actor, personId, false, via);
}

/** A 60 s link to a signature file, after the rule and the `viewed` audit. The URL is never stored and never logged. */
export async function signatureUrl(tx: Tx, actor: Actor, file: SignatureFile): Promise<{ url: string; contentType: string }> {
  await gate(tx, actor, file, 'screen');
  const url = await resolveStorageDriver().signedUrl(file.storagePath, SIGNATURE_LINK_SECONDS);
  return { url, contentType: file.contentType };
}

/** The signature's BYTES, for a server-side print route. Gated and audited exactly like a view; never a URL. */
export async function signatureBytes(tx: Tx, actor: Actor, file: SignatureFile): Promise<{ bytes: Uint8Array; contentType: string }> {
  await gate(tx, actor, file, 'print');
  const bytes = await resolveStorageDriver().get(file.storagePath);
  return { bytes, contentType: file.contentType };
}
