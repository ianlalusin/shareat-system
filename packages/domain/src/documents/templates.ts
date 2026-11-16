/**
 * Document templates. T-584 S2 (docs/tasks/584-documents.md s3 item 1, s5, s7).
 *
 * Admins only (`manage_document_templates`, org scope; a manager is refused even in scope of a store). Every save creates a NEW version of the
 * template: an old version is never edited (a trigger refuses it) because a document already issued names the version it was written from.
 * The template row is locked while a version number is chosen, so two saves queue and number 2 then 3.
 *
 * The wording is entered through the screen (Ian, R5): nothing is seeded. A waiver or quitclaim kind is not offered (R6).
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, documentsRepo, type Tx } from '@shareat/db';
import { DOCUMENT_KINDS, SIGNATURE_SLOTS, type DocumentKind, type SignatureSlot } from '@shareat/db/schema';
import { refuse } from '../shared/refusal';
import { unknownFields } from './merge-fields';

export const MAX_BODY_LENGTH = 50_000;
const MAX_NAME_LENGTH = 120;

export interface SaveTemplateInput {
  /** Omitted to create a new template. */
  templateId?: string;
  name: string;
  kind: DocumentKind;
  body: string;
  signatureSlots: readonly SignatureSlot[];
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  versionNo: number;
  body: string;
  signatureSlots: SignatureSlot[];
  createdByName: string;
  createdAt: Date;
}
export interface TemplateListItem {
  id: string;
  name: string;
  kind: DocumentKind;
  retired: boolean;
  latest: TemplateVersion;
}

const KIND_WORDS: Record<DocumentKind, string> = { coe: 'Certificate of employment', memo: 'Memo', nte: 'Notice to explain', contract: 'Employment contract', other: 'Other' };
export const documentKindLabel = (k: DocumentKind): string => KIND_WORDS[k];
export const SLOT_WORDS: Record<SignatureSlot, string> = { issuer: 'Issuer', employee: 'Employee' };

function cleanSlots(raw: readonly string[]): SignatureSlot[] {
  const bad = raw.filter((s) => !(SIGNATURE_SLOTS as readonly string[]).includes(s));
  if (bad.length > 0) {
    throw refuse(`saveDocumentTemplate: unknown signature slot ${bad.join(',')}`, 'A signature slot is either the issuer or the employee. Pick from the list.');
  }
  return SIGNATURE_SLOTS.filter((s) => raw.includes(s));
}

/** Throws the plain-words refusal for a body that cannot be kept (too long, blank). Shared by templates and issued documents. */
export function assertBodyText(body: string, what: 'template' | 'document'): string {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (text === '') throw refuse(`${what}: blank body`, `The wording of the ${what} cannot be empty. Write what it should say.`);
  if (text.length > MAX_BODY_LENGTH) {
    throw refuse(`${what}: body over ${MAX_BODY_LENGTH} characters`, `The wording is too long. The limit is 50,000 characters; this has ${text.length.toLocaleString('en-US')}.`);
  }
  return text;
}

export async function saveDocumentTemplate(tx: Tx, actor: Actor, input: SaveTemplateInput): Promise<{ templateId: string; versionId: string; versionNo: number }> {
  await authorize(tx, actor, 'manage_document_templates', {});

  const name = String(input.name ?? '').trim();
  if (name === '') throw refuse('saveDocumentTemplate: blank name', 'A template needs a name, for example "Certificate of Employment".');
  if (name.length > MAX_NAME_LENGTH) throw refuse('saveDocumentTemplate: name too long', 'The template name is too long. Keep it under 120 characters.');
  if (!(DOCUMENT_KINDS as readonly string[]).includes(input.kind)) {
    throw refuse(`saveDocumentTemplate: unknown kind ${String(input.kind)}`, 'Pick what kind of document this is from the list: certificate of employment, memo, notice to explain, contract or other.');
  }
  const body = assertBodyText(input.body, 'template');
  const bad = unknownFields(body);
  if (bad.length > 0) {
    throw refuse(
      `saveDocumentTemplate: unknown merge field(s) ${bad.join(',')}`,
      `These fields are not known: ${bad.map((b) => `{{${b}}}`).join(', ')}. Check the spelling against the list of fields shown beside the wording.`,
    );
  }
  const slots = cleanSlots(input.signatureSlots);

  let templateId = input.templateId;
  if (templateId) {
    const head = await documentsRepo.getTemplateForUpdate(tx, actor.orgId, templateId);
    if (!head) throw refuse('saveDocumentTemplate: template not found', 'That template does not exist in this organisation.');
    if (head.retiredAt) throw refuse('saveDocumentTemplate: template retired', 'This template is retired, so it cannot be changed. Make a new template instead.');
    if (head.name !== name || head.kind !== input.kind) await documentsRepo.updateTemplateHead(tx, actor.orgId, templateId, { name, kind: input.kind });
  } else {
    templateId = await documentsRepo.insertTemplate(tx, { orgId: actor.orgId, name, kind: input.kind, createdBy: actor.personId });
  }

  const versionNo = await documentsRepo.nextTemplateVersionNo(tx, actor.orgId, templateId);
  const versionId = await documentsRepo.insertTemplateVersion(tx, {
    orgId: actor.orgId,
    templateId,
    versionNo,
    body,
    signatureSlots: slots,
    createdBy: actor.personId,
  });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document_template.version_saved',
    storeId: null,
    entityId: templateId,
    before: null,
    after: { templateId, versionNo, kind: input.kind, signatureSlots: slots },
    source: 'web',
  });
  return { templateId, versionId, versionNo };
}

export async function retireDocumentTemplate(tx: Tx, actor: Actor, templateId: string): Promise<void> {
  await authorize(tx, actor, 'manage_document_templates', {});
  const head = await documentsRepo.getTemplateForUpdate(tx, actor.orgId, templateId);
  if (!head) throw refuse('retireDocumentTemplate: template not found', 'That template does not exist in this organisation.');
  if (head.retiredAt) return;
  await documentsRepo.setTemplateRetired(tx, actor.orgId, templateId, true);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document_template.retired',
    storeId: null,
    entityId: templateId,
    before: { retired: false },
    after: { retired: true },
    source: 'web',
  });
}

const asVersion = (v: documentsRepo.TemplateVersionRow): TemplateVersion => ({
  id: v.id,
  templateId: v.templateId,
  versionNo: v.versionNo,
  body: v.body,
  signatureSlots: v.signatureSlots,
  createdByName: v.createdByName,
  createdAt: v.createdAt,
});

/** Every template (retired ones too, marked), each with its latest version. Admin screen. */
export async function listDocumentTemplates(tx: Tx, actor: Actor): Promise<TemplateListItem[]> {
  await authorize(tx, actor, 'manage_document_templates', {});
  const rows = await documentsRepo.listTemplatesWithLatest(tx, actor.orgId);
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, retired: r.retiredAt !== null, latest: asVersion(r.latest) }));
}

/** Every version of one template, newest first. Old versions are read-only history. */
export async function listDocumentTemplateVersions(tx: Tx, actor: Actor, templateId: string): Promise<TemplateVersion[]> {
  await authorize(tx, actor, 'manage_document_templates', {});
  return (await documentsRepo.listTemplateVersions(tx, actor.orgId, templateId)).map(asVersion);
}
