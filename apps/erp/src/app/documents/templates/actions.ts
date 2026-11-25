'use server';

/**
 * Server actions for `/documents/templates`. T-584 S2, T-637.
 *
 * ⛔ No rule is re-implemented here. `saveDocumentTemplate` and `retireDocumentTemplate` call `authorize(..., 'manage_document_templates')` as their first
 * statement (admin only), and own the whitelist of the stored document, the length and the version number, each with its own plain sentence. The editor calls
 * `saveTemplateAction` with the three documents as JSON; a refusal comes back as a sentence and the editor keeps everything typed. The kind actions are plain forms.
 */
import { revalidatePath } from 'next/cache';
import {
  createDocumentKind,
  documentPreviewValues,
  renameDocumentKind,
  retireDocumentTemplate,
  saveDocumentTemplate,
  setDocumentKindStatus,
  type MergeValues,
} from '@shareat/domain';
import type { SignatureSlot } from '@shareat/db/schema';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { keepTyping } from '../../../lib/keep-typing';
import { withOrgPrincipal } from '../lib';
import { DOCUMENT_KIND_EDIT } from './typed-forms';

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export interface SaveTemplateInput {
  templateId?: string;
  name: string;
  kindId: string;
  slots: string[];
  margins: string;
  bodyDoc: unknown;
  headerDoc: unknown;
  footerDoc: unknown;
}

/** Writes a new version. On success it redirects to the list with a banner (and any warning); on a refusal it returns the sentence so the editor keeps what was typed. */
export async function saveTemplateAction(input: SaveTemplateInput): Promise<{ error: string } | void> {
  const actor = await requireActor('/documents/templates');
  let warnings: string[] = [];
  try {
    const r = await withOrgPrincipal(actor.orgId, (tx) =>
      saveDocumentTemplate(tx, actor, {
        ...(input.templateId ? { templateId: input.templateId } : {}),
        name: input.name,
        kindId: input.kindId,
        bodyDoc: input.bodyDoc,
        headerDoc: input.headerDoc,
        footerDoc: input.footerDoc,
        margins: input.margins as 'normal',
        signatureSlots: input.slots as SignatureSlot[],
      }),
    );
    warnings = r.warnings;
  } catch (err) {
    return { error: errorMessage(err) };
  }
  revalidatePath('/documents/templates');
  const ok = input.templateId ? 'The new version is saved. Documents already issued keep the wording they were written from.' : 'The template is saved as version 1.';
  return await redirectWithFlash('/documents/templates', {}, { ok: warnings.length > 0 ? `${ok} Warning: ${warnings.join(' ')}` : ok });
}

/** The values issue would fill in for one employee, for the editor's preview. */
export async function previewValuesAction(employmentId: string): Promise<{ values: MergeValues } | { error: string }> {
  const actor = await requireActor('/documents/templates');
  try {
    return { values: await withOrgPrincipal(actor.orgId, (tx) => documentPreviewValues(tx, actor, { employmentId })) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
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

export async function createKindAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents/templates');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => createDocumentKind(tx, actor, { name: String(fd.get('name') ?? '') }));
  } catch (err) {
    return await redirectWithFlash('/documents/templates', {}, { error: errorMessage(err) });
  }
  revalidatePath('/documents/templates');
  return await redirectWithFlash('/documents/templates', {}, { ok: 'The kind is added. It can be used by a template now.' });
}

export async function renameKindAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents/templates');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => renameDocumentKind(tx, actor, { kindId: str(fd, 'kindId'), name: String(fd.get('name') ?? '') }));
  } catch (err) {
    return await redirectWithFlash('/documents/templates', {}, { error: errorMessage(err), typed: keepTyping(fd, DOCUMENT_KIND_EDIT, str(fd, 'kindId'), { actorId: actor.personId }) });
  }
  revalidatePath('/documents/templates');
  return await redirectWithFlash('/documents/templates', {}, { ok: 'The kind is renamed. Documents already issued keep the name they were issued with.' });
}

export async function setKindStatusAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/documents/templates');
  const status = str(fd, 'status') === 'retired' ? 'retired' : 'active';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setDocumentKindStatus(tx, actor, { kindId: str(fd, 'kindId'), status }));
  } catch (err) {
    return await redirectWithFlash('/documents/templates', {}, { error: errorMessage(err) });
  }
  revalidatePath('/documents/templates');
  return await redirectWithFlash('/documents/templates', {}, { ok: status === 'retired' ? 'The kind is retired. It is not offered for new templates.' : 'The kind is back on the list.' });
}
