'use server';

/**
 * Server actions for `/documents/templates`. T-584 S2.
 *
 * ⛔ No rule is re-implemented here. `saveDocumentTemplate` and `retireDocumentTemplate` call `authorize(..., 'manage_document_templates')` as their first
 * statement (admin only), and own the merge-field whitelist, the length and the version number, each with its own plain sentence. This action reads the
 * form, calls it and shows the sentence that comes back; a refused save keeps what was typed.
 */
import { revalidatePath } from 'next/cache';
import { retireDocumentTemplate, saveDocumentTemplate } from '@shareat/domain';
import type { SignatureSlot } from '@shareat/db/schema';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { keepTyping } from '../../../lib/keep-typing';
import { withOrgPrincipal } from '../lib';
import { DOCUMENT_TEMPLATE_EDIT, NEW_TEMPLATE_RECORD } from './typed-forms';

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export async function saveTemplateAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents/templates');
  const templateId = str(fd, 'templateId');
  const input = {
    ...(templateId ? { templateId } : {}),
    name: str(fd, 'name'),
    kindId: str(fd, 'kindId'),
    // The wording keeps its own blank lines and indentation; only the form's line endings are normalised by the domain.
    body: String(fd.get('body') ?? ''),
    signatureSlots: fd.getAll('slot').filter((s): s is string => typeof s === 'string') as SignatureSlot[],
  };
  try {
    await withOrgPrincipal(actor.orgId, (tx) => saveDocumentTemplate(tx, actor, input));
  } catch (err) {
    return await redirectWithFlash('/documents/templates', {}, { error: errorMessage(err), typed: keepTyping(fd, DOCUMENT_TEMPLATE_EDIT, templateId || NEW_TEMPLATE_RECORD, { actorId: actor.personId }) });
  }
  revalidatePath('/documents/templates');
  return await redirectWithFlash('/documents/templates', {}, { ok: templateId ? 'The new version is saved. Documents already issued keep the wording they were written from.' : 'The template is saved as version 1.' });
}

export async function retireTemplateAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents/templates');
  const templateId = str(fd, 'templateId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => retireDocumentTemplate(tx, actor, templateId));
  } catch (err) {
    return await redirectWithFlash('/documents/templates', {}, { error: errorMessage(err) });
  }
  revalidatePath('/documents/templates');
  return await redirectWithFlash('/documents/templates', {}, { ok: 'The template is retired. It is not offered for new documents; documents already issued are untouched.' });
}
