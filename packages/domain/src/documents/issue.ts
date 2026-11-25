/**
 * Issue, register, revise and print. T-584 S3 (docs/tasks/584-documents.md s3 items 2, 4, 5, 6; s5; s7; R7).
 *
 * WHO. `issue_documents` (store scope) at the store of the document: the employee's store, or the store chosen for a general memo. A document
 * with no store at all (an organisation-wide memo) needs `manage_document_templates`, which is the admin's. Reading needs `view_documents` at the
 * same store. Store scope is the manager's limit: a manager of one store is refused for another store's staff.
 *
 * THE BODY. Filled on the server from the whitelist (`merge-fields.ts`), shown to the issuer to edit, and frozen at issue as version 1. A
 * `[missing: ...]` marker blocks Issue. T-637: the body is a JSON document (`doc.ts`): each field tag becomes plain TEXT when filled, the issuer edits the document in the editor,
 * and the server judges the result with the same whitelist as a template. The template's header and footer are filled on the server and frozen with the version (`letterhead.page`);
 * a version from before 0281 has no `body_doc` and keeps printing from its `body`. A revision is a NEW version of the SAME document (same number); every earlier version is kept and nothing is
 * edited in place (R7). The number is `DOC-YYYY-NNNN`, per organisation per year, allocated under an advisory lock.
 */
import { authorize, can, type Actor } from '@shareat/auth';
import { auditLogRepo, documentsRepo, storesRepo, type Tx } from '@shareat/db';
import type { DocumentLetterhead, SignatureSlot } from '@shareat/db/schema';
import { toBusinessDate } from '@shareat/core/datetime';
import { DOCUMENT_REASON_RULES } from '../field-rules/documents';
import { assertFieldRules } from '../shared/field-rules-assert';
import { gone, refuse } from '../shared/refusal';
import { fieldsInDoc, fillDoc, legacyBodyToDoc, missingInDoc, plainTextOf, validateDoc, effectiveDoc, type DocJson, type DocPage } from './doc';
import { lengthOfService, longDate, type MergeValues } from './merge-fields';
import { authorizeViewStoreless } from './access';
import { assertBodyText } from './templates';

// ---------------------------------------------------------------------------------------------------------------------
// Capability helpers
// ---------------------------------------------------------------------------------------------------------------------
type DocCapability = 'issue_documents' | 'view_documents';

/**
 * At the document's store. A document with no store: READING it is open to anyone who holds `view_documents` at any store (Ian, 15 Nov); issuing, revising
 * and voiding it stay the admin's (`manage_document_templates`, org scope).
 */
async function authorizeAt(tx: Tx, actor: Actor, capability: DocCapability, storeId: string | null): Promise<void> {
  if (storeId) await authorize(tx, actor, capability, { storeId });
  else if (capability === 'view_documents') await authorizeViewStoreless(tx, actor);
  else await authorize(tx, actor, 'manage_document_templates', {});
}

/** The stores where `actor` holds `capability`, and whether the organisation-wide documents (no store) are theirs too. Refuses when they hold neither. */
async function scopeOf(tx: Tx, actor: Actor, capability: DocCapability): Promise<{ storeIds: string[]; includeOrgWide: boolean }> {
  const stores = await storesRepo.listForOrg(tx, actor.orgId);
  const storeIds: string[] = [];
  for (const s of stores) if (await can(tx, actor, capability, { storeId: s.id })) storeIds.push(s.id);
  // Reading storeless documents follows view_documents at any store; the issue picker keeps them the admin's.
  const includeOrgWide = (capability === 'view_documents' && storeIds.length > 0) || (await can(tx, actor, 'manage_document_templates', {}));
  if (storeIds.length === 0 && !includeOrgWide && stores[0]) await authorize(tx, actor, capability, { storeId: stores[0].id });
  return { storeIds, includeOrgWide };
}

// ---------------------------------------------------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------------------------------------------------
type PartsOf = { displayName: string; firstName: string | null; middleName: string | null; lastName: string | null };

/** "First M. Last" when the parts are on file, else the display name as saved. A document reads in the order a person says their name. */
export function fullNameOf(p: PartsOf): string {
  if (!p.firstName || !p.lastName) return p.displayName;
  const mid = p.middleName ? ` ${p.middleName.trim().charAt(0).toUpperCase()}.` : '';
  return `${p.firstName}${mid} ${p.lastName}`;
}
const titleCase = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));

interface Target {
  storeId: string | null;
  employmentId: string | null;
  employment: documentsRepo.EmploymentFacts | null;
}

/** Reads what the document is about. The employee decides the store; a general memo is about a chosen store, or none. */
async function resolveTarget(tx: Tx, actor: Actor, input: { employmentId?: string | null; storeId?: string | null }): Promise<Target> {
  if (input.employmentId) {
    const employment = await documentsRepo.getEmploymentFacts(tx, actor.orgId, input.employmentId);
    if (!employment) throw gone('documents: employment not found', 'employee');
    return { storeId: employment.storeId, employmentId: employment.id, employment };
  }
  if (input.storeId) {
    const store = await documentsRepo.getStoreFacts(tx, actor.orgId, input.storeId);
    if (!store) throw gone('documents: store not found', 'store');
    return { storeId: store.id, employmentId: null, employment: null };
  }
  return { storeId: null, employmentId: null, employment: null };
}

async function mergeValuesFor(tx: Tx, actor: Actor, target: Target): Promise<MergeValues> {
  const [org, store, issuer, issuerPositions] = await Promise.all([
    documentsRepo.getOrgFacts(tx, actor.orgId),
    target.storeId ? documentsRepo.getStoreFacts(tx, actor.orgId, target.storeId) : Promise.resolve(null),
    documentsRepo.getPersonFacts(tx, actor.orgId, actor.personId),
    documentsRepo.openPositionNamesOfPerson(tx, actor.orgId, actor.personId),
  ]);
  const e = target.employment;
  return {
    'employee.full_name': e ? fullNameOf(e) : null,
    'employee.first_name': e?.firstName ?? null,
    'employee.last_name': e?.lastName ?? null,
    'employee.staff_code': e?.staffCode ?? null,
    'employee.position': e && e.positionNames.length > 0 ? e.positionNames.join(' / ') : null,
    'employee.status': e ? titleCase(e.status) : null,
    'employee.started_on': e ? longDate(e.startedOn) : null,
    'employee.ended_on': e ? longDate(e.endedOn) : null,
    'employee.length_of_service': e ? lengthOfService(e.startedOn, e.endedOn, toBusinessDate()) : null,
    'employee.email': e?.email ?? null,
    'employee.phone': e?.phone ?? null,
    'store.name': store?.name ?? null,
    'store.address': store?.address ?? null,
    'store.phone': store?.contactNumber ?? null,
    'store.tin_branch_code': store?.tinBranchCode ?? null,
    'org.legal_name': org?.legalName ?? null,
    'org.trading_name': org?.tradingName ?? null,
    'org.tin': org?.tin ?? null,
    'issuer.full_name': issuer ? fullNameOf(issuer) : null,
    'issuer.position': issuerPositions.length > 0 ? issuerPositions.join(' / ') : null,
    today: longDate(toBusinessDate()),
  };
}

/** The letterhead and names as they are NOW, to be copied onto the version being written (R7: every version is kept as it was). */
async function freezeLetterhead(tx: Tx, actor: Actor, storeId: string | null, template: { name: string; kindName: string }, page: DocPage | null): Promise<DocumentLetterhead> {
  const [org, store] = await Promise.all([
    documentsRepo.getOrgFacts(tx, actor.orgId),
    storeId ? documentsRepo.getStoreFacts(tx, actor.orgId, storeId) : Promise.resolve(null),
  ]);
  return {
    orgLegalName: org?.legalName ?? null,
    orgTradingName: org?.tradingName ?? '',
    orgTin: org?.tin ?? null,
    tinBranchCode: store?.tinBranchCode ?? null,
    storeName: store?.name ?? null,
    storeAddress: store?.address ?? null,
    storeContact: store?.contactNumber ?? null,
    templateName: template.name,
    templateKind: template.kindName,
    kindName: template.kindName,
    ...(page ? { page } : {}),
  };
}

/** What the template editor's preview fills the fields with for one chosen employee: the same values issue would use (`[missing: x]` where a record has none). Writes nothing; admin only. */
export async function documentPreviewValues(tx: Tx, actor: Actor, input: { employmentId?: string | null }): Promise<MergeValues> {
  await authorize(tx, actor, 'manage_document_templates', {});
  return mergeValuesFor(tx, actor, await resolveTarget(tx, actor, { employmentId: input.employmentId ?? null }));
}

/** The page a NEW document prints on: the template's margins, with its header and footer filled for THIS document (a missing value prints nothing, it never blocks issue). */
function pageFor(version: { margins: DocPage['margins']; headerDoc: DocJson | null; footerDoc: DocJson | null }, values: MergeValues): DocPage {
  return {
    margins: version.margins,
    headerDoc: version.headerDoc ? fillDoc(version.headerDoc, values, 'blank') : null,
    footerDoc: version.footerDoc ? fillDoc(version.footerDoc, values, 'blank') : null,
  };
}

export interface DocumentDraft {
  template: { id: string; name: string; kindId: string; kindName: string; versionId: string; versionNo: number; signatureSlots: SignatureSlot[] };
  storeId: string | null;
  employmentId: string | null;
  /** The template document with every field filled (a field is plain text now); a hole reads `[missing: employee.ended_on]`. */
  doc: DocJson;
  /** The same wording as plain text. */
  body: string;
  /** The page it will print on, header and footer filled. Shown in the preview; the server rebuilds it at issue. */
  page: DocPage;
  missing: string[];
}

async function activeTemplate(tx: Tx, actor: Actor, templateId: string) {
  const head = await documentsRepo.getTemplate(tx, actor.orgId, templateId);
  if (!head) throw gone('documents: template not found', 'template');
  if (head.retiredAt) throw refuse('documents: template retired', 'This template is retired, so nothing can be issued from it. Pick another template.');
  const [latest] = await documentsRepo.listTemplateVersions(tx, actor.orgId, templateId);
  if (!latest) throw gone('documents: template has no version', 'template');
  return { head, latest };
}

/** The filled-in wording the issuer may edit, plus which fields could not be filled. Writes nothing. */
export async function documentDraft(tx: Tx, actor: Actor, input: { templateId: string; employmentId?: string | null; storeId?: string | null }): Promise<DocumentDraft> {
  const target = await resolveTarget(tx, actor, input);
  await authorizeAt(tx, actor, 'issue_documents', target.storeId);
  const { head, latest } = await activeTemplate(tx, actor, input.templateId);
  const values = await mergeValuesFor(tx, actor, target);
  const doc = fillDoc(effectiveDoc(latest.bodyDoc, latest.body), values, 'marker');
  return {
    template: { id: head.id, name: head.name, kindId: head.kindId, kindName: head.kindName, versionId: latest.id, versionNo: latest.versionNo, signatureSlots: latest.signatureSlots },
    storeId: target.storeId,
    employmentId: target.employmentId,
    doc,
    body: plainTextOf(doc),
    page: pageFor(await sideDocs(latest), values),
    missing: missingInDoc(doc),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------------------------------
/** A stored side document that no longer validates is treated as none (it was judged on the way in). */
async function sideDocs(v: documentsRepo.TemplateVersionRow): Promise<{ margins: DocPage['margins']; headerDoc: DocJson | null; footerDoc: DocJson | null }> {
  const one = (raw: unknown): DocJson | null => {
    if (raw === null || raw === undefined) return null;
    const c = validateDoc(raw);
    return c.ok ? c.doc : null;
  };
  return { margins: v.margins, headerDoc: one(v.headerDoc), footerDoc: one(v.footerDoc) };
}

/** The body an issuer or a reviser sends: the JSON document, or (an import, a test) the old plain text converted. Judged by the same whitelist as a template; blank and too long refused. */
function cleanIssuedDoc(input: { bodyDoc?: unknown; body?: string }): { doc: DocJson; body: string } {
  let doc: DocJson;
  if (input.bodyDoc !== undefined) {
    const c = validateDoc(input.bodyDoc);
    if (!c.ok) throw refuse(`documents: ${c.reason}`, `The wording cannot be kept. ${c.reason}`);
    doc = c.doc;
  } else {
    doc = legacyBodyToDoc(assertBodyText(String(input.body ?? ''), 'document'));
  }
  // A document being issued holds filled text, never a fill-in tag: a tag here would print as a grey label instead of a value.
  if (fieldsInDoc(doc).length > 0) throw refuse('documents: field tag in an issued body', 'This document still holds a fill-in field. Fields are filled in before issue; replace the field with the words it should say.');
  return { doc, body: assertBodyText(plainTextOf(doc), 'document') };
}

function assertNoHoles(doc: DocJson): void {
  const missing = missingInDoc(doc);
  if (missing.length > 0) {
    throw refuse(
      `documents: ${missing.length} [missing: ...] marker(s) left: ${missing.join(',')}`,
      `This still has gaps to fill in or take out: ${missing.map((m) => `[missing: ${m}]`).join(', ')}. Type the value in, or delete the line, then try again.`,
    );
  }
}

export async function issueDocument(
  tx: Tx,
  actor: Actor,
  input: { templateId: string; employmentId?: string | null; storeId?: string | null; bodyDoc?: unknown; body?: string },
): Promise<{ documentId: string; number: string; versionId: string }> {
  const target = await resolveTarget(tx, actor, input);
  await authorizeAt(tx, actor, 'issue_documents', target.storeId);
  const { head, latest } = await activeTemplate(tx, actor, input.templateId);
  const { doc, body } = cleanIssuedDoc(input);
  assertNoHoles(doc);

  const year = Number(toBusinessDate().slice(0, 4));
  const number = await documentsRepo.allocateNumber(tx, actor.orgId, year);
  const created = await documentsRepo.insertDocument(tx, {
    orgId: actor.orgId,
    storeId: target.storeId,
    number,
    templateVersionId: latest.id,
    employmentId: target.employmentId,
    issuedBy: actor.personId,
  });
  // The header and footer are filled HERE from the template's latest version (never taken from the browser) and frozen with the version.
  const page = pageFor(await sideDocs(latest), await mergeValuesFor(tx, actor, target));
  const letterhead = await freezeLetterhead(tx, actor, target.storeId, head, page);
  const versionId = await documentsRepo.insertDocumentVersion(tx, { orgId: actor.orgId, issuedDocumentId: created.id, versionNo: 1, body, bodyDoc: doc, reason: null, letterhead, createdBy: actor.personId });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document.issued',
    storeId: target.storeId,
    entityId: created.id,
    before: null,
    after: { documentId: created.id, number, kind: head.kindName, versionNo: 1, templateVersionId: latest.id, employmentId: target.employmentId },
    source: 'web',
  });
  return { documentId: created.id, number, versionId };
}

// ---------------------------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------------------------
export interface IssuedDocumentSummary {
  id: string;
  number: string;
  storeId: string | null;
  storeName: string | null;
  employmentId: string | null;
  employeePersonId: string | null;
  employeeName: string | null;
  templateVersionId: string;
  templateVersionNo: number;
  templateName: string;
  kindId: string;
  /** The kind's current name. A printed page uses the name frozen on its version. */
  kindName: string;
  signatureSlots: SignatureSlot[];
  issuedBy: string;
  issuedByName: string;
  issuedAt: Date;
  voided: boolean;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
  currentVersionNo: number;
  signedOnCurrent: number;
}
const summarise = (r: documentsRepo.DocumentRow): IssuedDocumentSummary => ({ ...r, voided: r.voidedAt !== null });

export interface IssuedDocumentVersion {
  id: string;
  versionNo: number;
  body: string;
  /** The version's document: its stored JSON, or (a version from before 0281) the body converted. `legacy` says which. */
  doc: DocJson;
  legacy: boolean;
  /** The page this version prints on (header and footer filled); null for a version from before 0281. */
  page: DocPage | null;
  reason: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  /** The letterhead and template names as they were when this version was written. */
  letterhead: DocumentLetterhead;
  signatures: Array<{ id: string; slot: SignatureSlot; personId: string; personName: string; signedAt: Date }>;
}

export async function listIssuedDocuments(
  tx: Tx,
  actor: Actor,
  filter: { storeId?: string; employmentId?: string; kindId?: string } = {},
): Promise<IssuedDocumentSummary[]> {
  if (filter.storeId) await authorize(tx, actor, 'view_documents', { storeId: filter.storeId });
  const scope = await scopeOf(tx, actor, 'view_documents');
  const rows = await documentsRepo.listDocuments(tx, actor.orgId, {
    storeIds: scope.storeIds,
    includeOrgWide: scope.includeOrgWide && !filter.storeId,
    ...(filter.storeId ? { storeId: filter.storeId } : {}),
    ...(filter.employmentId ? { employmentId: filter.employmentId } : {}),
    ...(filter.kindId ? { kindId: filter.kindId } : {}),
  });
  return rows.map(summarise);
}

/** One document with every version, each with its own signatures. */
export async function getIssuedDocument(tx: Tx, actor: Actor, documentId: string): Promise<{ document: IssuedDocumentSummary; versions: IssuedDocumentVersion[] }> {
  const row = await documentsRepo.getDocument(tx, actor.orgId, documentId);
  if (!row) throw gone('documents: document not found', 'document');
  await authorizeAt(tx, actor, 'view_documents', row.storeId);
  const [versions, signatures] = await Promise.all([documentsRepo.listDocumentVersions(tx, actor.orgId, documentId), documentsRepo.listDocumentSignatures(tx, actor.orgId, documentId)]);
  return {
    document: summarise(row),
    versions: versions.map(({ bodyDoc, ...v }) => ({
      ...v,
      doc: effectiveDoc(bodyDoc, v.body),
      legacy: bodyDoc === null || bodyDoc === undefined,
      page: v.letterhead.page ? toPage(v.letterhead.page) : null,
      signatures: signatures.filter((s) => s.versionId === v.id).map((s) => ({ id: s.id, slot: s.slot, personId: s.personId, personName: s.personName, signedAt: s.signedAt })),
    })),
  };
}

/** The people who must sign the CURRENT version: the issuer slot is whoever wrote that version, the employee slot is the document's employee. */
export function expectedSignerNames(doc: Pick<IssuedDocumentSummary, 'employeeName'>, current: { createdByName: string }): Record<SignatureSlot, string | null> {
  return { issuer: current.createdByName, employee: doc.employeeName };
}

export interface PrintData {
  number: string;
  versionNo: number;
  isCurrent: boolean;
  voided: boolean;
  voidReason: string | null;
  /** The kind's name as it was when this version was written. */
  kind: string;
  body: string;
  /** The version's document (the stored JSON, or the old body converted). */
  doc: DocJson;
  /** The page this version prints on, header and footer already filled; null for a version from before 0281 (it prints the old built-in letterhead below). */
  page: DocPage | null;
  letterhead: { legalName: string | null; tradingName: string; tin: string | null; storeName: string | null; storeAddress: string | null; tinBranchCode: string | null; storeContact: string | null; templateName: string };
  slots: Array<{ slot: SignatureSlot; name: string | null; signatureId: string | null; signedAt: Date | null }>;
  issuedAt: Date;
  revisionReason: string | null;
  storeId: string | null;
}

const toPage = (p: NonNullable<DocumentLetterhead['page']>): DocPage => {
  const one = (raw: unknown): DocJson | null => {
    if (raw === null || raw === undefined) return null;
    const c = validateDoc(raw);
    return c.ok ? c.doc : null;
  };
  return { margins: p.margins, headerDoc: one(p.headerDoc), footerDoc: one(p.footerDoc) };
};

/** Everything the A4 page prints for one version (the current one unless `versionNo` is given). The letterhead comes from the database. */
export async function documentPrintData(tx: Tx, actor: Actor, documentId: string, versionNo?: number): Promise<PrintData> {
  const { document, versions } = await getIssuedDocument(tx, actor, documentId);
  const current = versions[0];
  if (!current) throw gone('documents: document has no version', 'document');
  const v = versionNo === undefined ? current : versions.find((x) => x.versionNo === versionNo);
  if (!v) throw gone('documents: version not found', 'version');
  // Everything printed comes from what was frozen on THIS version, never from the live records.
  const names = expectedSignerNames(document, v);
  return {
    number: document.number,
    versionNo: v.versionNo,
    isCurrent: v.versionNo === current.versionNo,
    voided: document.voided,
    voidReason: document.voidReason,
    kind: v.letterhead.kindName ?? document.kindName,
    body: v.body,
    doc: v.doc,
    page: v.page,
    letterhead: {
      legalName: v.letterhead.orgLegalName,
      tradingName: v.letterhead.orgTradingName,
      tin: v.letterhead.orgTin,
      storeName: v.letterhead.storeName,
      storeAddress: v.letterhead.storeAddress,
      tinBranchCode: v.letterhead.tinBranchCode,
      storeContact: v.letterhead.storeContact,
      templateName: v.letterhead.templateName,
    },
    slots: document.signatureSlots.map((slot) => {
      const s = v.signatures.find((x) => x.slot === slot);
      return { slot, name: s?.personName ?? names[slot], signatureId: s?.id ?? null, signedAt: s?.signedAt ?? null };
    }),
    issuedAt: document.issuedAt,
    revisionReason: v.reason,
    storeId: document.storeId,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Revise (R7)
// ---------------------------------------------------------------------------------------------------------------------
export async function reviseDocument(tx: Tx, actor: Actor, input: { documentId: string; bodyDoc?: unknown; body?: string; reason: string }): Promise<{ versionId: string; versionNo: number }> {
  const row = await documentsRepo.getDocument(tx, actor.orgId, input.documentId);
  if (!row) throw gone('documents: document not found', 'document');
  await authorizeAt(tx, actor, 'issue_documents', row.storeId);

  const reason = assertFieldRules(DOCUMENT_REASON_RULES, { reason: input.reason }).reason ?? '';
  const { doc, body } = cleanIssuedDoc(input);
  assertNoHoles(doc);

  // The row is locked, then read again: a void or another revision that landed meanwhile is seen, not overwritten.
  const locked = await documentsRepo.lockDocument(tx, actor.orgId, input.documentId);
  if (!locked) throw gone('documents: document not found', 'document');
  if (locked.voided) throw refuse('reviseDocument: document is void', 'This document is void, so it cannot be changed. Issue a new document instead.');
  const versionNo = locked.currentVersionNo + 1;
  // The page (margins, header, footer) is carried over from the version being revised, as it was filled at issue: a later change to the template or the company changes nothing printed.
  const [current] = await documentsRepo.listDocumentVersions(tx, actor.orgId, input.documentId);
  const letterhead = await freezeLetterhead(tx, actor, row.storeId, { name: row.templateName, kindName: row.kindName }, current?.letterhead.page ? toPage(current.letterhead.page) : null);
  const versionId = await documentsRepo.insertDocumentVersion(tx, { orgId: actor.orgId, issuedDocumentId: input.documentId, versionNo, body, bodyDoc: doc, reason, letterhead, createdBy: actor.personId });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document.revised',
    storeId: row.storeId,
    entityId: input.documentId,
    before: { versionNo: locked.currentVersionNo },
    after: { documentId: input.documentId, number: row.number, versionNo, reason },
    source: 'web',
  });
  return { versionId, versionNo };
}

// ---------------------------------------------------------------------------------------------------------------------
// The issue screen's choices
// ---------------------------------------------------------------------------------------------------------------------
export interface IssueOptions {
  templates: Array<{ id: string; name: string; kindName: string; signatureSlots: SignatureSlot[]; versionNo: number }>;
  employments: documentsRepo.PickerEmployment[];
  stores: Array<{ id: string; name: string }>;
  /** True for an administrator: a document with no store at all is theirs to issue. */
  canIssueOrgWide: boolean;
}

/** What the issue screen may offer THIS person: the active templates, the staff of the stores where they may issue, and those stores. Refuses when they may issue nowhere. */
export async function documentIssueOptions(tx: Tx, actor: Actor): Promise<IssueOptions> {
  const scope = await scopeOf(tx, actor, 'issue_documents');
  const [templates, employments, stores] = await Promise.all([
    documentsRepo.listTemplatesWithLatest(tx, actor.orgId),
    documentsRepo.listEmploymentsForPicker(tx, actor.orgId, scope.storeIds),
    storesRepo.listForOrg(tx, actor.orgId),
  ]);
  return {
    templates: templates.filter((t) => t.retiredAt === null).map((t) => ({ id: t.id, name: t.name, kindName: t.kindName, signatureSlots: t.latest.signatureSlots, versionNo: t.latest.versionNo })),
    employments,
    stores: stores.filter((s) => scope.storeIds.includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
    canIssueOrgWide: scope.includeOrgWide,
  };
}
