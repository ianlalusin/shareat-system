/**
 * Issue, register, revise and print. T-584 S3 (docs/tasks/584-documents.md s3 items 2, 4, 5, 6; s5; s7; R7).
 *
 * WHO. `issue_documents` (store scope) at the store of the document: the employee's store, or the store chosen for a general memo. A document
 * with no store at all (an organisation-wide memo) needs `manage_document_templates`, which is the admin's. Reading needs `view_documents` at the
 * same store. Store scope is the manager's limit: a manager of one store is refused for another store's staff.
 *
 * THE BODY. Filled on the server from the whitelist (`merge-fields.ts`), shown to the issuer to edit, and frozen at issue as version 1. A
 * `[missing: ...]` marker blocks Issue. A revision is a NEW version of the SAME document (same number); every earlier version is kept and nothing is
 * edited in place (R7). The number is `DOC-YYYY-NNNN`, per organisation per year, allocated under an advisory lock.
 */
import { authorize, can, type Actor } from '@shareat/auth';
import { auditLogRepo, documentsRepo, storesRepo, type Tx } from '@shareat/db';
import type { DocumentKind, SignatureSlot } from '@shareat/db/schema';
import { toBusinessDate } from '@shareat/core/datetime';
import { gone, refuse } from '../shared/refusal';
import { fillBody, longDate, missingIn, type MergeValues } from './merge-fields';
import { assertBodyText } from './templates';

// ---------------------------------------------------------------------------------------------------------------------
// Capability helpers
// ---------------------------------------------------------------------------------------------------------------------
type DocCapability = 'issue_documents' | 'view_documents';

/** At the document's store; a document with no store is the admin's (`manage_document_templates`, org scope). */
async function authorizeAt(tx: Tx, actor: Actor, capability: DocCapability, storeId: string | null): Promise<void> {
  if (storeId) await authorize(tx, actor, capability, { storeId });
  else await authorize(tx, actor, 'manage_document_templates', {});
}

/** The stores where `actor` holds `capability`, and whether the organisation-wide documents (no store) are theirs too. Refuses when they hold neither. */
async function scopeOf(tx: Tx, actor: Actor, capability: DocCapability): Promise<{ storeIds: string[]; includeOrgWide: boolean }> {
  const stores = await storesRepo.listForOrg(tx, actor.orgId);
  const storeIds: string[] = [];
  for (const s of stores) if (await can(tx, actor, capability, { storeId: s.id })) storeIds.push(s.id);
  const includeOrgWide = await can(tx, actor, 'manage_document_templates', {});
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
    'employee.staff_code': e?.staffCode ?? null,
    'employee.position': e && e.positionNames.length > 0 ? e.positionNames.join(' / ') : null,
    'employee.status': e ? titleCase(e.status) : null,
    'employee.started_on': e ? longDate(e.startedOn) : null,
    'employee.ended_on': e ? longDate(e.endedOn) : null,
    'store.name': store?.name ?? null,
    'store.address': store?.address ?? null,
    'store.tin_branch_code': store?.tinBranchCode ?? null,
    'org.legal_name': org?.legalName ?? null,
    'org.trading_name': org?.tradingName ?? null,
    'org.tin': org?.tin ?? null,
    'issuer.full_name': issuer ? fullNameOf(issuer) : null,
    'issuer.position': issuerPositions.length > 0 ? issuerPositions.join(' / ') : null,
    today: longDate(toBusinessDate()),
  };
}

export interface DocumentDraft {
  template: { id: string; name: string; kind: DocumentKind; versionId: string; versionNo: number; signatureSlots: SignatureSlot[] };
  storeId: string | null;
  employmentId: string | null;
  /** The template wording with every field filled; a hole reads `[missing: employee.ended_on]`. */
  body: string;
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
  const body = fillBody(latest.body, await mergeValuesFor(tx, actor, target));
  return {
    template: { id: head.id, name: head.name, kind: head.kind, versionId: latest.id, versionNo: latest.versionNo, signatureSlots: latest.signatureSlots },
    storeId: target.storeId,
    employmentId: target.employmentId,
    body,
    missing: missingIn(body),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------------------------------
function assertNoHoles(text: string): void {
  const missing = missingIn(text);
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
  input: { templateId: string; employmentId?: string | null; storeId?: string | null; body: string },
): Promise<{ documentId: string; number: string; versionId: string }> {
  const target = await resolveTarget(tx, actor, input);
  await authorizeAt(tx, actor, 'issue_documents', target.storeId);
  const { head, latest } = await activeTemplate(tx, actor, input.templateId);
  const body = assertBodyText(input.body, 'document');
  assertNoHoles(body);

  const year = Number(toBusinessDate().slice(0, 4));
  const number = await documentsRepo.allocateNumber(tx, actor.orgId, year);
  const doc = await documentsRepo.insertDocument(tx, {
    orgId: actor.orgId,
    storeId: target.storeId,
    number,
    templateVersionId: latest.id,
    employmentId: target.employmentId,
    issuedBy: actor.personId,
  });
  const versionId = await documentsRepo.insertDocumentVersion(tx, { orgId: actor.orgId, issuedDocumentId: doc.id, versionNo: 1, body, reason: null, createdBy: actor.personId });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document.issued',
    storeId: target.storeId,
    entityId: doc.id,
    before: null,
    after: { documentId: doc.id, number, kind: head.kind, versionNo: 1, templateVersionId: latest.id, employmentId: target.employmentId },
    source: 'web',
  });
  return { documentId: doc.id, number, versionId };
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
  kind: DocumentKind;
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
  reason: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  signatures: Array<{ id: string; slot: SignatureSlot; personId: string; personName: string; signedAt: Date }>;
}

export async function listIssuedDocuments(
  tx: Tx,
  actor: Actor,
  filter: { storeId?: string; employmentId?: string; kind?: DocumentKind } = {},
): Promise<IssuedDocumentSummary[]> {
  if (filter.storeId) await authorize(tx, actor, 'view_documents', { storeId: filter.storeId });
  const scope = await scopeOf(tx, actor, 'view_documents');
  const rows = await documentsRepo.listDocuments(tx, actor.orgId, {
    storeIds: scope.storeIds,
    includeOrgWide: scope.includeOrgWide && !filter.storeId,
    ...(filter.storeId ? { storeId: filter.storeId } : {}),
    ...(filter.employmentId ? { employmentId: filter.employmentId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
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
    versions: versions.map((v) => ({
      ...v,
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
  kind: DocumentKind;
  body: string;
  letterhead: { legalName: string | null; tradingName: string; tin: string | null; storeName: string | null; storeAddress: string | null; tinBranchCode: string | null };
  slots: Array<{ slot: SignatureSlot; name: string | null; signatureId: string | null; signedAt: Date | null }>;
  issuedAt: Date;
  revisionReason: string | null;
  storeId: string | null;
}

/** Everything the A4 page prints for one version (the current one unless `versionNo` is given). The letterhead comes from the database. */
export async function documentPrintData(tx: Tx, actor: Actor, documentId: string, versionNo?: number): Promise<PrintData> {
  const { document, versions } = await getIssuedDocument(tx, actor, documentId);
  const current = versions[0];
  if (!current) throw gone('documents: document has no version', 'document');
  const v = versionNo === undefined ? current : versions.find((x) => x.versionNo === versionNo);
  if (!v) throw gone('documents: version not found', 'version');
  const [org, store] = await Promise.all([
    documentsRepo.getOrgFacts(tx, actor.orgId),
    document.storeId ? documentsRepo.getStoreFacts(tx, actor.orgId, document.storeId) : Promise.resolve(null),
  ]);
  const names = expectedSignerNames(document, v);
  return {
    number: document.number,
    versionNo: v.versionNo,
    isCurrent: v.versionNo === current.versionNo,
    voided: document.voided,
    voidReason: document.voidReason,
    kind: document.kind,
    body: v.body,
    letterhead: {
      legalName: org?.legalName ?? null,
      tradingName: org?.tradingName ?? '',
      tin: org?.tin ?? null,
      storeName: store?.name ?? null,
      storeAddress: store?.address ?? null,
      tinBranchCode: store?.tinBranchCode ?? null,
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
export async function reviseDocument(tx: Tx, actor: Actor, input: { documentId: string; body: string; reason: string }): Promise<{ versionId: string; versionNo: number }> {
  const row = await documentsRepo.getDocument(tx, actor.orgId, input.documentId);
  if (!row) throw gone('documents: document not found', 'document');
  await authorizeAt(tx, actor, 'issue_documents', row.storeId);

  const reason = String(input.reason ?? '').trim();
  if (reason === '') throw refuse('reviseDocument: blank reason', 'Say why the document is being changed. The reason is kept with the new version.');
  const body = assertBodyText(input.body, 'document');
  assertNoHoles(body);

  // The row is locked, then read again: a void or another revision that landed meanwhile is seen, not overwritten.
  const locked = await documentsRepo.lockDocument(tx, actor.orgId, input.documentId);
  if (!locked) throw gone('documents: document not found', 'document');
  if (locked.voided) throw refuse('reviseDocument: document is void', 'This document is void, so it cannot be changed. Issue a new document instead.');
  const versionNo = locked.currentVersionNo + 1;
  const versionId = await documentsRepo.insertDocumentVersion(tx, { orgId: actor.orgId, issuedDocumentId: input.documentId, versionNo, body, reason, createdBy: actor.personId });
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
  templates: Array<{ id: string; name: string; kind: DocumentKind; signatureSlots: SignatureSlot[]; versionNo: number }>;
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
    templates: templates.filter((t) => t.retiredAt === null).map((t) => ({ id: t.id, name: t.name, kind: t.kind, signatureSlots: t.latest.signatureSlots, versionNo: t.latest.versionNo })),
    employments,
    stores: stores.filter((s) => scope.storeIds.includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
    canIssueOrgWide: scope.includeOrgWide,
  };
}
