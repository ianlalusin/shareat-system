/**
 * Document templates. T-584 S2 (docs/tasks/584-documents.md s3 item 1, s5, s7).
 *
 * Admins only (`manage_document_templates`, org scope; a manager is refused even in scope of a store). Every save creates a NEW version of the
 * template: an old version is never edited (a trigger refuses it) because a document already issued names the version it was written from.
 * The template row is locked while a version number is chosen, so two saves queue and number 2 then 3.
 *
 * The wording is entered through the screen (Ian, R5): nothing is seeded. A waiver or quitclaim kind is not offered (R6).
 *
 * T-637: a template holds a JSON document (strictly whitelisted, `doc.ts`), not text. The server judges EVERY save: a node, mark, attribute, value or field that is not on the list is
 * refused in words. The kind is an id into the org's own list (`kinds.ts`). The old plain `body` text is still written (the document's plain text) so history and search keep working.
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, documentsRepo, type Tx } from '@shareat/db';
import { SIGNATURE_SLOTS, type SignatureSlot } from '@shareat/db/schema';
import { refuse } from '../shared/refusal';
import { unknownFields } from './merge-fields';
import { DEFAULT_MARGIN, PAGE_MARGIN_KEYS, effectiveDoc, legacyBodyToDoc, placeholderLookalikes, plainTextOf, validateDoc, type DocJson, type PageMargin } from './doc';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BODY_LENGTH = 50_000;
const MAX_NAME_LENGTH = 120;

export interface SaveTemplateInput {
  /** Omitted to create a new template. */
  templateId?: string;
  name: string;
  kindId: string;
  /** The JSON document (T-637). Judged by `validateDoc`. */
  bodyDoc?: unknown;
  /** The OLD plain markup, converted to a document at save. Used when `bodyDoc` is absent (an import, a test); the screens send `bodyDoc`. */
  body?: string;
  /** Optional letterhead header and footer, JSON documents that may hold fields. Absent or empty means none. */
  headerDoc?: unknown;
  footerDoc?: unknown;
  margins?: PageMargin;
  signatureSlots: readonly SignatureSlot[];
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  versionNo: number;
  /** The plain text (`{{field}}` for each tag), or the original wording of a version from before 0281. */
  body: string;
  /** The document: the stored JSON, or the old body converted (`legacy` says which). */
  doc: DocJson;
  legacy: boolean;
  margins: PageMargin;
  headerDoc: DocJson | null;
  footerDoc: DocJson | null;
  signatureSlots: SignatureSlot[];
  createdByName: string;
  createdAt: Date;
}
export interface TemplateListItem {
  id: string;
  name: string;
  kindId: string;
  kindName: string;
  retired: boolean;
  latest: TemplateVersion;
}

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

/** A header or footer that holds nothing (no text, no field) is no header. A bad one is refused in words. */
function cleanSideDoc(raw: unknown, what: 'header' | 'footer'): DocJson | null {
  if (raw === null || raw === undefined) return null;
  const c = validateDoc(raw);
  if (!c.ok) throw refuse(`saveDocumentTemplate: ${what}: ${c.reason}`, `The ${what} cannot be saved. ${c.reason}`);
  return plainTextOf(c.doc) === '' ? null : c.doc;
}

export async function saveDocumentTemplate(
  tx: Tx,
  actor: Actor,
  input: SaveTemplateInput,
): Promise<{ templateId: string; versionId: string; versionNo: number; warnings: string[] }> {
  await authorize(tx, actor, 'manage_document_templates', {});

  const name = String(input.name ?? '').trim();
  if (name === '') throw refuse('saveDocumentTemplate: blank name', 'A template needs a name, for example "Certificate of Employment".');
  if (name.length > MAX_NAME_LENGTH) throw refuse('saveDocumentTemplate: name too long', 'The template name is too long. Keep it under 120 characters.');

  let doc: DocJson;
  if (input.bodyDoc !== undefined) {
    const c = validateDoc(input.bodyDoc);
    if (!c.ok) throw refuse(`saveDocumentTemplate: ${c.reason}`, `The template cannot be saved. ${c.reason}`);
    doc = c.doc;
  } else {
    const text = assertBodyText(String(input.body ?? ''), 'template');
    // The old markup left an unknown {{name}} as literal text; a template may not hold one (it would print as typed), so it is refused as it always was.
    const unknown = unknownFields(text);
    if (unknown.length > 0) {
      throw refuse(
        `saveDocumentTemplate: unknown merge field(s) ${unknown.join(',')}`,
        `These fields are not known: ${unknown.map((b) => `{{${b}}}`).join(', ')}. Type {{ and pick from the list of fields.`,
      );
    }
    doc = legacyBodyToDoc(text);
    const bad = validateDoc(doc);
    if (!bad.ok) throw refuse(`saveDocumentTemplate: ${bad.reason}`, `The template cannot be saved. ${bad.reason}`);
  }
  // The plain text is what the old `body` column keeps; the same blank and length rules judge it.
  const body = assertBodyText(plainTextOf(doc), 'template');
  const headerDoc = cleanSideDoc(input.headerDoc, 'header');
  const footerDoc = cleanSideDoc(input.footerDoc, 'footer');
  const margins = input.margins ?? DEFAULT_MARGIN;
  if (!PAGE_MARGIN_KEYS.includes(margins)) throw refuse(`saveDocumentTemplate: unknown margins ${String(margins)}`, 'Pick the page margins from the list: narrow, normal or wide.');
  const slots = cleanSlots(input.signatureSlots);

  // The kind row is share-locked: a retire of it (FOR UPDATE) and this save queue instead of crossing.
  const kind = UUID.test(String(input.kindId)) ? await documentsRepo.getKindLocked(tx, actor.orgId, input.kindId, 'share') : null;
  if (!kind) throw refuse(`saveDocumentTemplate: unknown kind ${String(input.kindId)}`, 'Pick what kind of document this is from the list of kinds.');
  if (kind.status !== 'active') throw refuse(`saveDocumentTemplate: kind ${kind.id} is retired`, `The kind "${kind.name}" is retired. Pick another kind, or bring it back on the list of kinds.`);

  let templateId = input.templateId;
  if (templateId) {
    const head = await documentsRepo.getTemplateForUpdate(tx, actor.orgId, templateId);
    if (!head) throw refuse('saveDocumentTemplate: template not found', 'That template does not exist in this organisation.');
    if (head.retiredAt) throw refuse('saveDocumentTemplate: template retired', 'This template is retired, so it cannot be changed. Make a new template instead.');
    if (head.name !== name || head.kindId !== kind.id) await documentsRepo.updateTemplateHead(tx, actor.orgId, templateId, { name, kindId: kind.id });
  } else {
    templateId = await documentsRepo.insertTemplate(tx, { orgId: actor.orgId, name, kindId: kind.id, createdBy: actor.personId });
  }

  const versionNo = await documentsRepo.nextTemplateVersionNo(tx, actor.orgId, templateId);
  const versionId = await documentsRepo.insertTemplateVersion(tx, {
    orgId: actor.orgId,
    templateId,
    versionNo,
    body,
    bodyDoc: doc,
    margins,
    headerDoc,
    footerDoc,
    signatureSlots: slots,
    createdBy: actor.personId,
  });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document_template.version_saved',
    storeId: null,
    entityId: templateId,
    before: null,
    after: { templateId, versionNo, kindId: kind.id, kind: kind.name, signatureSlots: slots },
    source: 'web',
  });
  // A warning, never a block: `[EMPLOYEE FULL NAME]` text is usually a fill-in that should be a field tag.
  const looks = placeholderLookalikes(doc, headerDoc, footerDoc);
  const warnings = looks.length > 0 ? [`This looks like a fill-in placeholder: ${looks.join(', ')}. Use Insert field (or type {{) so the system fills it in; text in square brackets is printed as it is.`] : [];
  return { templateId, versionId, versionNo, warnings };
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

/** A stored side document that no longer validates is treated as none rather than breaking the screen (it was judged on the way in). */
const sideDoc = (raw: unknown): DocJson | null => {
  if (raw === null || raw === undefined) return null;
  const c = validateDoc(raw);
  return c.ok ? c.doc : null;
};

const asVersion = (v: documentsRepo.TemplateVersionRow): TemplateVersion => ({
  id: v.id,
  templateId: v.templateId,
  versionNo: v.versionNo,
  body: v.body,
  doc: effectiveDoc(v.bodyDoc, v.body),
  legacy: v.bodyDoc === null || v.bodyDoc === undefined,
  margins: v.margins,
  headerDoc: sideDoc(v.headerDoc),
  footerDoc: sideDoc(v.footerDoc),
  signatureSlots: v.signatureSlots,
  createdByName: v.createdByName,
  createdAt: v.createdAt,
});

/** Every template (retired ones too, marked), each with its latest version. Admin screen. */
export async function listDocumentTemplates(tx: Tx, actor: Actor): Promise<TemplateListItem[]> {
  await authorize(tx, actor, 'manage_document_templates', {});
  const rows = await documentsRepo.listTemplatesWithLatest(tx, actor.orgId);
  return rows.map((r) => ({ id: r.id, name: r.name, kindId: r.kindId, kindName: r.kindName, retired: r.retiredAt !== null, latest: asVersion(r.latest) }));
}

/** Every version of one template, newest first. Old versions are read-only history. */
export async function listDocumentTemplateVersions(tx: Tx, actor: Actor, templateId: string): Promise<TemplateVersion[]> {
  await authorize(tx, actor, 'manage_document_templates', {});
  return (await documentsRepo.listTemplateVersions(tx, actor.orgId, templateId)).map(asVersion);
}
