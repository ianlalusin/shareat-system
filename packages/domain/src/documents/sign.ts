/**
 * Signing and voiding. T-584 S4 (docs/tasks/584-documents.md s3 items 3 and 7, s7; R3, R4, R7).
 *
 * R4 - a saved signature is attached to a document ONLY when its owner enters their own Employee ID and PIN. This module never writes a new PIN path: it
 * calls `verifySignerPin` (packages/auth), which reuses `runChargedPinLookup`, the same lock-out and attempt cap every other PIN door uses. The attempt is
 * charged to the person at the keyboard (the signed-in actor), and a wrong one is audited and refused with ONE generic sentence.
 *
 * R3 - the signature is the person's saved signature (the one place it is saved, T-434; read through `personsRepo`), COPIED BY REFERENCE into the signature row at that
 * moment. A later change to the person's signature changes nothing already signed.
 *
 * R7 - a signature belongs to ONE version. The caller names the version on screen (`versionNo`); if the document has moved on, nothing is signed. The
 * issuer slot of a version is whoever wrote that version, the employee slot is the document's employee. The database repeats every one of these rules
 * as a trigger (only the current version of a live document can be signed).
 */
import { authorize, verifySignerPin, AuthenticationError, type Actor } from '@shareat/auth';
import { auditLogRepo, documentsRepo, personsRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { SIGNATURE_SLOTS, type SignatureSlot } from '@shareat/db/schema';
import { DOCUMENT_REASON_RULES, DOCUMENT_SIGN_RULES } from '../field-rules/documents';
import { assertFieldRules } from '../shared/field-rules-assert';
import { gone, internalFault, refuse } from '../shared/refusal';
import { resolveStorageDriver } from '../files/driver';

export interface SignInput {
  documentId: string;
  slot: SignatureSlot;
  /** The version the signer was looking at (a number, or the digits of one from a form). */
  versionNo: number | string;
  /** What the signer typed: the number of their staff code (`7`) or the whole code (`SE-007`). */
  employeeId: string;
  pin: string;
  deviceId?: string;
}

/** Writes a refused signing in its OWN transaction: the caller's rolls back with the refusal, and the refusal is the thing to keep. */
async function auditRefusedSigning(actor: Actor, doc: { id: string; number: string; storeId: string | null }, slot: SignatureSlot, versionNo: number): Promise<void> {
  await withOrgPrincipal(actor.orgId, (t) =>
    auditLogRepo.append(t, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'document.sign_refused',
      storeId: doc.storeId,
      entityId: doc.id,
      before: null,
      after: { documentId: doc.id, number: doc.number, slot, versionNo },
      source: 'web',
    }),
  );
}

export async function signDocument(tx: Tx, actor: Actor, input: SignInput): Promise<{ signatureId: string; versionNo: number }> {
  const doc = await documentsRepo.getDocument(tx, actor.orgId, input.documentId);
  if (!doc) throw gone('documents: document not found', 'document');
  // Whoever holds the device must be someone who may read this document at its store, or no PIN is ever charged on their account.
  await authorize(tx, actor, doc.storeId ? 'view_documents' : 'manage_document_templates', doc.storeId ? { storeId: doc.storeId } : {});

  // A malformed Employee ID or PIN is refused here, in the same words as the screen's live line, BEFORE any PIN attempt is charged (the format is public).
  const typed = assertFieldRules(DOCUMENT_SIGN_RULES, { employeeId: input.employeeId, pin: input.pin });

  if (!(SIGNATURE_SLOTS as readonly string[]).includes(input.slot) || !doc.signatureSlots.includes(input.slot)) {
    throw refuse(`signDocument: slot ${String(input.slot)} not asked for`, 'This document does not take that signature.');
  }
  const locked = await documentsRepo.lockDocument(tx, actor.orgId, input.documentId);
  if (!locked) throw gone('documents: document not found', 'document');
  if (locked.voided) throw refuse('signDocument: document is void', 'This document is void, so it cannot be signed.');
  const seen = typeof input.versionNo === 'number' ? input.versionNo : /^[0-9]{1,4}$/.test(input.versionNo) ? Number(input.versionNo) : NaN;
  if (seen !== locked.currentVersionNo) {
    throw refuse(
      `signDocument: version ${String(input.versionNo)} is not the current version ${locked.currentVersionNo}`,
      'This document was changed since you opened it. Open it again and sign the new version.',
    );
  }
  const already = (await documentsRepo.listDocumentSignatures(tx, actor.orgId, input.documentId)).some((s) => s.versionId === locked.currentVersionId && s.slot === input.slot);
  if (already) throw refuse('signDocument: slot already signed', 'That signature is already on this version.');

  // Whose signature this slot takes is decided by the document, never by the form.
  const expectedPersonId = input.slot === 'issuer' ? locked.createdBy : doc.employeePersonId;
  if (!expectedPersonId) throw refuse('signDocument: no employee on a memo', 'This document is not about an employee, so there is no employee signature.');

  const acceptedStaffCodes = await documentsRepo.staffCodesOfPerson(tx, actor.orgId, expectedPersonId);
  try {
    // `null`, not `tx`: the wrong-PIN charge commits on its own connection so it survives this refusal rolling the caller's transaction back.
    await verifySignerPin(null, {
      orgId: actor.orgId,
      actorPersonId: actor.personId,
      expectedPersonId,
      acceptedStaffCodes,
      employeeId: typed.employeeId ?? '',
      pin: typed.pin ?? '',
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    });
  } catch (err) {
    if (err instanceof AuthenticationError) await auditRefusedSigning(actor, doc, input.slot, locked.currentVersionNo);
    throw err;
  }

  const signer = await documentsRepo.getPersonFacts(tx, actor.orgId, expectedPersonId);
  if (!signer) throw internalFault('signDocument: the signer vanished after their PIN was checked.');
  const savedFile = await personsRepo.getSignatureFileId(tx, actor.orgId, expectedPersonId);
  if (!savedFile) {
    throw refuse(
      'signDocument: the signer has no saved signature',
      `${signer.displayName} has no saved signature yet. Save a signature on the staff page first, then sign again.`,
    );
  }
  const signatureId = await documentsRepo.insertSignature(tx, {
    orgId: actor.orgId,
    issuedDocumentVersionId: locked.currentVersionId,
    slot: input.slot,
    personId: expectedPersonId,
    signerName: signer.displayName,
    fileId: savedFile,
  });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document.signed',
    storeId: doc.storeId,
    entityId: doc.id,
    before: null,
    after: { documentId: doc.id, number: doc.number, versionNo: locked.currentVersionNo, slot: input.slot, signerPersonId: expectedPersonId },
    source: 'web',
  });
  return { signatureId, versionNo: locked.currentVersionNo };
}

// ---------------------------------------------------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------------------------------------------------

/** Admin, or the issuing store's manager (`issue_documents` at the document's store; a store-less document is the admin's). Needs a reason; never deletes. */
export async function voidDocument(tx: Tx, actor: Actor, input: { documentId: string; reason: string }): Promise<void> {
  const doc = await documentsRepo.getDocument(tx, actor.orgId, input.documentId);
  if (!doc) throw gone('documents: document not found', 'document');
  await authorize(tx, actor, doc.storeId ? 'issue_documents' : 'manage_document_templates', doc.storeId ? { storeId: doc.storeId } : {});

  const reason = assertFieldRules(DOCUMENT_REASON_RULES, { reason: input.reason }).reason ?? '';
  const locked = await documentsRepo.lockDocument(tx, actor.orgId, input.documentId);
  if (!locked) throw gone('documents: document not found', 'document');
  if (locked.voided) throw refuse('voidDocument: already void', 'This document is already void.');
  if (!(await documentsRepo.voidDocument(tx, actor.orgId, input.documentId, { personId: actor.personId, reason }))) {
    throw refuse('voidDocument: already void (raced)', 'This document is already void.');
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document.voided',
    storeId: doc.storeId,
    entityId: doc.id,
    before: { voided: false },
    after: { documentId: doc.id, number: doc.number, reason },
    source: 'web',
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The signature image
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The bytes of one signature ON ONE DOCUMENT, for the gated route behind the screen and the print page. Anyone who holds `view_documents` for that
 * document's store may see it: an explicit, narrow exception to `view_staff_signature` (bible row 353), because the signer's own PIN put the image there.
 * The id of a signature on a document nobody may view is refused with the same permission refusal as the document itself; another organisation's id is simply absent.
 */
export async function documentSignatureImage(tx: Tx, actor: Actor, signatureId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const row = await documentsRepo.getSignatureForServing(tx, actor.orgId, signatureId);
  if (!row) throw gone('documents: signature not found', 'signature');
  if (row.storeId) await authorize(tx, actor, 'view_documents', { storeId: row.storeId });
  else await authorize(tx, actor, 'manage_document_templates', {});
  return { bytes: await resolveStorageDriver().get(row.storagePath), contentType: row.contentType };
}
