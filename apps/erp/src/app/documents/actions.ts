'use server';

/**
 * Server actions for `/documents`. T-584 S3 and S4.
 *
 * ⛔ No rule is re-implemented here. Each domain call authorizes first (`issue_documents` / `view_documents` at the document's store, or the admin
 * capability for a document with no store), owns the sentences, and writes the audit row. These actions read the form, call the domain, and show the
 * sentence that comes back. A refused issue or revision keeps what was typed; a signing keeps nothing (it carries a PIN).
 */
import { revalidatePath } from 'next/cache';
import { issueDocument, reviseDocument, signDocument, voidDocument } from '@shareat/domain';
import type { SignatureSlot } from '@shareat/db/schema';
import { requireActor } from '../../lib/session';
import { errorMessage } from '../../lib/constraint-messages';
import { redirectWithFlash } from '../../lib/flash';
import { keepTyping } from '../../lib/keep-typing';
import { loadDestructiveTarget, retypeRefusalError } from '../../lib/destructive';
import { retypeMatches } from '../../lib/retype';
import { withOrgPrincipal } from './lib';
import { DOCUMENT_ISSUE, DOCUMENT_REVISE } from './typed-forms';

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export async function issueDocumentAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents/new');
  const templateId = str(fd, 'templateId');
  const employmentId = str(fd, 'employmentId');
  const storeId = str(fd, 'storeId');
  // The wording keeps its own blank lines; the domain normalises the line endings.
  const input = { templateId, employmentId: employmentId || null, storeId: storeId || null, body: String(fd.get('body') ?? '') };
  let result: { documentId: string; number: string };
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => issueDocument(tx, actor, input));
  } catch (err) {
    return await redirectWithFlash(
      '/documents/new',
      { template: templateId, ...(employmentId ? { employmentId } : {}), ...(storeId ? { store: storeId } : {}) },
      { error: errorMessage(err), typed: keepTyping(fd, DOCUMENT_ISSUE, templateId, { actorId: actor.personId }) },
    );
  }
  revalidatePath('/documents');
  return await redirectWithFlash(`/documents/${result.documentId}`, {}, { ok: `Issued as ${result.number}. Ask for the signatures below, then print it.` });
}

export async function reviseDocumentAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents');
  const documentId = str(fd, 'documentId');
  const input = { documentId, body: String(fd.get('body') ?? ''), reason: str(fd, 'reason') };
  const here = `/documents/${documentId}`;
  try {
    await withOrgPrincipal(actor.orgId, (tx) => reviseDocument(tx, actor, input));
  } catch (err) {
    return await redirectWithFlash(here, {}, { error: errorMessage(err), typed: keepTyping(fd, DOCUMENT_REVISE, documentId, { actorId: actor.personId }) });
  }
  revalidatePath('/documents');
  return await redirectWithFlash(here, {}, { ok: 'Saved as a new version. Every signature is needed again; earlier versions stay in the history.' });
}

export async function signDocumentAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents');
  const documentId = str(fd, 'documentId');
  const here = `/documents/${documentId}`;
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      signDocument(tx, actor, {
        documentId,
        slot: str(fd, 'slot') as SignatureSlot,
        versionNo: str(fd, 'versionNo'),
        employeeId: str(fd, 'employeeId'),
        pin: str(fd, 'pin'),
      }),
    );
  } catch (err) {
    // Nothing the person typed is kept: the PIN must never be echoed back, and the Employee ID is quick to type again.
    return await redirectWithFlash(here, {}, { error: errorMessage(err) });
  }
  revalidatePath(here);
  return await redirectWithFlash(here, {}, { ok: 'Signed. The saved signature is now on this version.' });
}

export async function voidDocumentAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents');
  const documentId = str(fd, 'documentId');
  const here = `/documents/${documentId}`;
  try {
    // The number to retype comes from the database, never from the form; the store is the record's.
    const target = await loadDestructiveTarget(actor, 'issued_document', documentId, ['issue_documents', 'manage_document_templates']);
    if (!retypeMatches(str(fd, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
    await withOrgPrincipal(actor.orgId, (tx) => voidDocument(tx, actor, { documentId, reason: str(fd, 'reason') }));
  } catch (err) {
    return await redirectWithFlash(here, {}, { error: errorMessage(err) });
  }
  revalidatePath('/documents');
  return await redirectWithFlash(here, {}, { ok: 'The document is void. It stays in the register, marked void.', stamp: 'VOID' });
}
