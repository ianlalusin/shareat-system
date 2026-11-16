/**
 * Documents: templates, issued documents, their versions and signatures. T-584 (docs/tasks/584-documents.md).
 *
 * SQL only, every read and write filtered by `org_id` (RLS backstops it). The domain (`packages/domain/src/documents`) owns every rule, sentence,
 * capability and audit row; the database owns immutability and the version sequence (triggers in migration 0259). Nothing here authorizes.
 *
 * ⛔ A signature IMAGE is never selected by a list. `getSignatureForServing` is the one read of a stored file path, and the domain gates it.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  documentTemplates,
  documentTemplateVersions,
  issuedDocuments,
  issuedDocumentVersions,
  issuedDocumentSignatures,
  type DocumentKind,
  type DocumentLetterhead,
  type SignatureSlot,
} from '../../schema/documents';
import { employmentPositions, employments, positions } from '../../schema/employment';
import { organizations } from '../../schema/organizations';
import { persons } from '../../schema/persons';
import { storedFiles } from '../../schema/stored-files';
import { stores } from '../../schema/stores';
import { lockDocumentNumbering } from './advisory-locks';

// -------------------------------------------------------------------------------------------------------------------
// Templates
// -------------------------------------------------------------------------------------------------------------------
export interface TemplateRow {
  id: string;
  name: string;
  kind: DocumentKind;
  retiredAt: Date | null;
  createdAt: Date;
}
export interface TemplateVersionRow {
  id: string;
  templateId: string;
  versionNo: number;
  body: string;
  signatureSlots: SignatureSlot[];
  createdBy: string;
  createdByName: string;
  createdAt: Date;
}

export async function insertTemplate(tx: Tx, input: { orgId: string; name: string; kind: DocumentKind; createdBy: string }): Promise<string> {
  const [row] = await tx.insert(documentTemplates).values(input).returning({ id: documentTemplates.id });
  return row!.id;
}

/** The template row, locked, so two saves of one template queue and number their versions one after the other. */
export async function getTemplateForUpdate(tx: Tx, orgId: string, templateId: string): Promise<TemplateRow | null> {
  const rows = await tx.execute(sql`
    select id, name, kind, retired_at, created_at from document_templates
    where org_id = ${orgId} and id = ${templateId} for update`);
  const r = (rows as unknown as Record<string, unknown>[])[0];
  return r ? { id: String(r.id), name: String(r.name), kind: r.kind as DocumentKind, retiredAt: (r.retired_at as Date | null) ?? null, createdAt: r.created_at as Date } : null;
}

export async function getTemplate(tx: Tx, orgId: string, templateId: string): Promise<TemplateRow | null> {
  const [row] = await tx
    .select({ id: documentTemplates.id, name: documentTemplates.name, kind: documentTemplates.kind, retiredAt: documentTemplates.retiredAt, createdAt: documentTemplates.createdAt })
    .from(documentTemplates)
    .where(and(eq(documentTemplates.orgId, orgId), eq(documentTemplates.id, templateId)))
    .limit(1);
  return row ?? null;
}

export async function updateTemplateHead(tx: Tx, orgId: string, templateId: string, set: { name: string; kind: DocumentKind }): Promise<void> {
  await tx.update(documentTemplates).set(set).where(and(eq(documentTemplates.orgId, orgId), eq(documentTemplates.id, templateId)));
}

export async function setTemplateRetired(tx: Tx, orgId: string, templateId: string, retired: boolean): Promise<void> {
  await tx
    .update(documentTemplates)
    .set({ retiredAt: retired ? sql`now()` : null })
    .where(and(eq(documentTemplates.orgId, orgId), eq(documentTemplates.id, templateId)));
}

export async function nextTemplateVersionNo(tx: Tx, orgId: string, templateId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${documentTemplateVersions.versionNo}), 0)::int` })
    .from(documentTemplateVersions)
    .where(and(eq(documentTemplateVersions.orgId, orgId), eq(documentTemplateVersions.templateId, templateId)));
  return (row?.max ?? 0) + 1;
}

export async function insertTemplateVersion(
  tx: Tx,
  input: { orgId: string; templateId: string; versionNo: number; body: string; signatureSlots: SignatureSlot[]; createdBy: string },
): Promise<string> {
  const [row] = await tx.insert(documentTemplateVersions).values(input).returning({ id: documentTemplateVersions.id });
  return row!.id;
}

const versionColumns = {
  id: documentTemplateVersions.id,
  templateId: documentTemplateVersions.templateId,
  versionNo: documentTemplateVersions.versionNo,
  body: documentTemplateVersions.body,
  signatureSlots: documentTemplateVersions.signatureSlots,
  createdBy: documentTemplateVersions.createdBy,
  createdByName: persons.displayName,
  createdAt: documentTemplateVersions.createdAt,
} as const;

function asVersionRow(r: { id: string; templateId: string; versionNo: number; body: string; signatureSlots: string[]; createdBy: string; createdByName: string; createdAt: Date }): TemplateVersionRow {
  return { ...r, signatureSlots: r.signatureSlots as SignatureSlot[] };
}

export async function listTemplateVersions(tx: Tx, orgId: string, templateId: string): Promise<TemplateVersionRow[]> {
  const rows = await tx
    .select(versionColumns)
    .from(documentTemplateVersions)
    .innerJoin(persons, eq(persons.id, documentTemplateVersions.createdBy))
    .where(and(eq(documentTemplateVersions.orgId, orgId), eq(documentTemplateVersions.templateId, templateId)))
    .orderBy(desc(documentTemplateVersions.versionNo));
  return rows.map(asVersionRow);
}

/** Every template with its latest version's number, body and slots (one row per template). */
export async function listTemplatesWithLatest(tx: Tx, orgId: string): Promise<Array<TemplateRow & { latest: TemplateVersionRow }>> {
  const heads = await tx
    .select({ id: documentTemplates.id, name: documentTemplates.name, kind: documentTemplates.kind, retiredAt: documentTemplates.retiredAt, createdAt: documentTemplates.createdAt })
    .from(documentTemplates)
    .where(eq(documentTemplates.orgId, orgId))
    .orderBy(asc(documentTemplates.name));
  if (heads.length === 0) return [];
  const versions = await tx
    .select(versionColumns)
    .from(documentTemplateVersions)
    .innerJoin(persons, eq(persons.id, documentTemplateVersions.createdBy))
    .where(and(eq(documentTemplateVersions.orgId, orgId), inArray(documentTemplateVersions.templateId, heads.map((h) => h.id))))
    .orderBy(desc(documentTemplateVersions.versionNo));
  const latest = new Map<string, TemplateVersionRow>();
  for (const v of versions) if (!latest.has(v.templateId)) latest.set(v.templateId, asVersionRow(v));
  return heads.flatMap((h) => {
    const l = latest.get(h.id);
    return l ? [{ ...h, latest: l }] : [];
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Merge-field facts (what the whitelist resolves from)
// -------------------------------------------------------------------------------------------------------------------
export interface EmploymentFacts {
  id: string;
  storeId: string;
  personId: string;
  displayName: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  staffCode: string;
  status: string;
  startedOn: string;
  endedOn: string | null;
  positionNames: string[];
}

export async function getEmploymentFacts(tx: Tx, orgId: string, employmentId: string): Promise<EmploymentFacts | null> {
  const [row] = await tx
    .select({
      id: employments.id,
      storeId: employments.storeId,
      personId: employments.personId,
      displayName: persons.displayName,
      firstName: persons.firstName,
      middleName: persons.middleName,
      lastName: persons.lastName,
      staffCode: employments.staffCode,
      status: employments.employmentStatus,
      startedOn: employments.startedOn,
      endedOn: employments.endedOn,
    })
    .from(employments)
    .innerJoin(persons, eq(persons.id, employments.personId))
    .where(and(eq(employments.orgId, orgId), eq(employments.id, employmentId)))
    .limit(1);
  if (!row) return null;
  const pos = await positionNamesOf(tx, orgId, [row.id]);
  return { ...row, startedOn: String(row.startedOn), endedOn: row.endedOn === null ? null : String(row.endedOn), positionNames: pos.get(row.id) ?? [] };
}

async function positionNamesOf(tx: Tx, orgId: string, employmentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (employmentIds.length === 0) return out;
  const rows = await tx
    .select({ employmentId: employmentPositions.employmentId, name: positions.name, isPrimary: employmentPositions.isPrimary })
    .from(employmentPositions)
    .innerJoin(positions, eq(positions.id, employmentPositions.positionId))
    .where(and(eq(positions.orgId, orgId), inArray(employmentPositions.employmentId, employmentIds)))
    .orderBy(desc(employmentPositions.isPrimary), asc(positions.name));
  for (const r of rows) out.set(r.employmentId, [...(out.get(r.employmentId) ?? []), r.name]);
  return out;
}

export interface PersonFacts {
  id: string;
  displayName: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  isTerminal: boolean;
}

export async function getPersonFacts(tx: Tx, orgId: string, personId: string): Promise<PersonFacts | null> {
  const [row] = await tx
    .select({
      id: persons.id,
      displayName: persons.displayName,
      firstName: persons.firstName,
      middleName: persons.middleName,
      lastName: persons.lastName,
      kind: persons.kind,
    })
    .from(persons)
    .where(and(eq(persons.orgId, orgId), eq(persons.id, personId)))
    .limit(1);
  return row ? { id: row.id, displayName: row.displayName, firstName: row.firstName, middleName: row.middleName, lastName: row.lastName, isTerminal: row.kind === 'terminal' } : null;
}

/** The issuer's position names across their open jobs, primary first. Empty when they hold no open employment (an admin with no job). */
export async function openPositionNamesOfPerson(tx: Tx, orgId: string, personId: string): Promise<string[]> {
  const open = await tx
    .select({ id: employments.id })
    .from(employments)
    .where(and(eq(employments.orgId, orgId), eq(employments.personId, personId), isNull(employments.endedOn)));
  const map = await positionNamesOf(tx, orgId, open.map((o) => o.id));
  return [...new Set(open.flatMap((o) => map.get(o.id) ?? []))];
}

/** Every staff code the person has ever held (open or ended), upper-case. The Employee ID typed to sign must be one of them. */
export async function staffCodesOfPerson(tx: Tx, orgId: string, personId: string): Promise<string[]> {
  const rows = await tx
    .select({ staffCode: employments.staffCode })
    .from(employments)
    .where(and(eq(employments.orgId, orgId), eq(employments.personId, personId)));
  return [...new Set(rows.map((r) => r.staffCode.trim().toUpperCase()))];
}

export interface StoreFacts {
  id: string;
  name: string;
  address: string | null;
  tinBranchCode: string | null;
  contactNumber: string | null;
}
export async function getStoreFacts(tx: Tx, orgId: string, storeId: string): Promise<StoreFacts | null> {
  const [row] = await tx
    .select({ id: stores.id, name: stores.name, address: stores.address, tinBranchCode: stores.tinBranchCode, contactNumber: stores.contactNumber })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, storeId)))
    .limit(1);
  return row ?? null;
}

export interface OrgFacts {
  legalName: string | null;
  tradingName: string;
  tin: string | null;
}
export async function getOrgFacts(tx: Tx, orgId: string): Promise<OrgFacts | null> {
  const [row] = await tx
    .select({ legalName: organizations.legalName, tradingName: organizations.name, tin: organizations.tin })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row ?? null;
}

/** For the issue screen's employee picker: employments of the given stores (all stores when `storeIds` is undefined), open first. */
export interface PickerEmployment {
  id: string;
  storeId: string;
  storeName: string;
  staffCode: string;
  displayName: string;
  status: string;
  ended: boolean;
}
export async function listEmploymentsForPicker(tx: Tx, orgId: string, storeIds: readonly string[] | undefined): Promise<PickerEmployment[]> {
  if (storeIds && storeIds.length === 0) return [];
  const rows = await tx
    .select({
      id: employments.id,
      storeId: employments.storeId,
      storeName: stores.name,
      staffCode: employments.staffCode,
      displayName: persons.displayName,
      status: employments.employmentStatus,
      endedOn: employments.endedOn,
    })
    .from(employments)
    .innerJoin(persons, eq(persons.id, employments.personId))
    .innerJoin(stores, eq(stores.id, employments.storeId))
    .where(and(eq(employments.orgId, orgId), storeIds ? inArray(employments.storeId, [...storeIds]) : undefined))
    .orderBy(sql`(${employments.endedOn} is not null)`, asc(persons.displayName));
  return rows.map((r) => ({ id: r.id, storeId: r.storeId, storeName: r.storeName, staffCode: r.staffCode, displayName: r.displayName, status: r.status, ended: r.endedOn !== null }));
}

// -------------------------------------------------------------------------------------------------------------------
// Issued documents
// -------------------------------------------------------------------------------------------------------------------

/** The next `DOC-YYYY-NNNN` for the organisation and year, allocated under an advisory lock held to commit (two issues queue). */
export async function allocateNumber(tx: Tx, orgId: string, year: number): Promise<string> {
  await lockDocumentNumbering(tx, orgId, year);
  const prefix = `DOC-${String(year)}-`;
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max((substring(${issuedDocuments.number} from ${prefix.length + 1}::int))::int), 0)::int` })
    .from(issuedDocuments)
    .where(and(eq(issuedDocuments.orgId, orgId), sql`${issuedDocuments.number} like ${prefix + '%'}`));
  return `${prefix}${String((row?.max ?? 0) + 1).padStart(4, '0')}`;
}

export async function insertDocument(
  tx: Tx,
  input: { orgId: string; storeId: string | null; number: string; templateVersionId: string; employmentId: string | null; issuedBy: string },
): Promise<{ id: string; issuedAt: Date }> {
  const [row] = await tx.insert(issuedDocuments).values(input).returning({ id: issuedDocuments.id, issuedAt: issuedDocuments.issuedAt });
  return row!;
}

export async function insertDocumentVersion(
  tx: Tx,
  input: { orgId: string; issuedDocumentId: string; versionNo: number; body: string; reason: string | null; letterhead: DocumentLetterhead; createdBy: string },
): Promise<string> {
  const [row] = await tx.insert(issuedDocumentVersions).values(input).returning({ id: issuedDocumentVersions.id });
  return row!.id;
}

export async function insertSignature(
  tx: Tx,
  input: { orgId: string; issuedDocumentVersionId: string; slot: SignatureSlot; personId: string; signerName: string; fileId: string },
): Promise<string> {
  const [row] = await tx.insert(issuedDocumentSignatures).values(input).returning({ id: issuedDocumentSignatures.id });
  return row!.id;
}

export async function voidDocument(tx: Tx, orgId: string, documentId: string, by: { personId: string; reason: string }): Promise<boolean> {
  const rows = await tx
    .update(issuedDocuments)
    .set({ voidedAt: sql`now()`, voidedBy: by.personId, voidReason: by.reason })
    .where(and(eq(issuedDocuments.orgId, orgId), eq(issuedDocuments.id, documentId), isNull(issuedDocuments.voidedAt)))
    .returning({ id: issuedDocuments.id });
  return rows.length > 0;
}

export interface DocumentRow {
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
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
  currentVersionNo: number;
  /** How many signatures the CURRENT version already carries. */
  signedOnCurrent: number;
}

const signedOnCurrentSql = sql<number>`(select count(*) from issued_document_signatures s where s.issued_document_version_id = (select v.id from issued_document_versions v where v.issued_document_id = ${issuedDocuments.id} order by v.version_no desc limit 1))::int`;
const currentVersionNoSql = sql<number>`(select max(v.version_no) from issued_document_versions v where v.issued_document_id = ${issuedDocuments.id})::int`;

function documentSelect(tx: Tx) {
  const issuer = persons;
  return tx
    .select({
      id: issuedDocuments.id,
      number: issuedDocuments.number,
      storeId: issuedDocuments.storeId,
      storeName: stores.name,
      employmentId: issuedDocuments.employmentId,
      employeePersonId: employments.personId,
      employeeName: sql<string | null>`(select p.display_name from persons p where p.id = ${employments.personId})`,
      templateVersionId: issuedDocuments.templateVersionId,
      templateVersionNo: documentTemplateVersions.versionNo,
      templateName: documentTemplates.name,
      kind: documentTemplates.kind,
      signatureSlots: documentTemplateVersions.signatureSlots,
      issuedBy: issuedDocuments.issuedBy,
      issuedByName: issuer.displayName,
      issuedAt: issuedDocuments.issuedAt,
      voidedAt: issuedDocuments.voidedAt,
      voidedByName: sql<string | null>`(select p.display_name from persons p where p.id = ${issuedDocuments.voidedBy})`,
      voidReason: issuedDocuments.voidReason,
      currentVersionNo: currentVersionNoSql,
      signedOnCurrent: signedOnCurrentSql,
    })
    .from(issuedDocuments)
    .innerJoin(documentTemplateVersions, eq(documentTemplateVersions.id, issuedDocuments.templateVersionId))
    .innerJoin(documentTemplates, eq(documentTemplates.id, documentTemplateVersions.templateId))
    .innerJoin(issuer, eq(issuer.id, issuedDocuments.issuedBy))
    .leftJoin(stores, eq(stores.id, issuedDocuments.storeId))
    .leftJoin(employments, eq(employments.id, issuedDocuments.employmentId));
}

function asDocumentRow(r: Awaited<ReturnType<ReturnType<typeof documentSelect>['limit']>>[number]): DocumentRow {
  return { ...r, signatureSlots: r.signatureSlots as SignatureSlot[] };
}

export async function getDocument(tx: Tx, orgId: string, documentId: string): Promise<DocumentRow | null> {
  const [row] = await documentSelect(tx)
    .where(and(eq(issuedDocuments.orgId, orgId), eq(issuedDocuments.id, documentId)))
    .limit(1);
  return row ? asDocumentRow(row) : null;
}

export interface DocumentFilter {
  /** Restrict to these stores; undefined = every store (an org-wide actor). Org-wide memos (no store) are included only when `includeOrgWide`. */
  storeIds?: readonly string[] | undefined;
  includeOrgWide: boolean;
  storeId?: string;
  employmentId?: string;
  personId?: string;
  kind?: DocumentKind;
  limit?: number;
}

export async function listDocuments(tx: Tx, orgId: string, f: DocumentFilter): Promise<DocumentRow[]> {
  if (f.storeIds && f.storeIds.length === 0 && !f.includeOrgWide) return [];
  // An empty store list never reaches `in ()`: with org-wide documents allowed it means only the ones with no store; without them the early return above already answered.
  const scope = f.storeIds
    ? f.storeIds.length === 0
      ? isNull(issuedDocuments.storeId)
      : f.includeOrgWide
        ? or(isNull(issuedDocuments.storeId), inArray(issuedDocuments.storeId, [...f.storeIds]))
        : inArray(issuedDocuments.storeId, [...f.storeIds])
    : undefined;
  const rows = await documentSelect(tx)
    .where(
      and(
        eq(issuedDocuments.orgId, orgId),
        scope,
        f.storeId ? eq(issuedDocuments.storeId, f.storeId) : undefined,
        f.employmentId ? eq(issuedDocuments.employmentId, f.employmentId) : undefined,
        f.personId ? eq(employments.personId, f.personId) : undefined,
        f.kind ? eq(documentTemplates.kind, f.kind) : undefined,
      ),
    )
    .orderBy(desc(issuedDocuments.issuedAt), desc(issuedDocuments.id))
    .limit(f.limit ?? 200);
  return rows.map(asDocumentRow);
}

export interface DocumentVersionRow {
  id: string;
  versionNo: number;
  body: string;
  reason: string | null;
  letterhead: DocumentLetterhead;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
}
export async function listDocumentVersions(tx: Tx, orgId: string, documentId: string): Promise<DocumentVersionRow[]> {
  return tx
    .select({
      id: issuedDocumentVersions.id,
      versionNo: issuedDocumentVersions.versionNo,
      body: issuedDocumentVersions.body,
      reason: issuedDocumentVersions.reason,
      letterhead: issuedDocumentVersions.letterhead,
      createdBy: issuedDocumentVersions.createdBy,
      createdByName: persons.displayName,
      createdAt: issuedDocumentVersions.createdAt,
    })
    .from(issuedDocumentVersions)
    .innerJoin(persons, eq(persons.id, issuedDocumentVersions.createdBy))
    .where(and(eq(issuedDocumentVersions.orgId, orgId), eq(issuedDocumentVersions.issuedDocumentId, documentId)))
    .orderBy(desc(issuedDocumentVersions.versionNo));
}

export interface SignatureRow {
  id: string;
  versionId: string;
  slot: SignatureSlot;
  personId: string;
  personName: string;
  signedAt: Date;
}
/** Every signature on every version of a document. The file id is NOT returned: the image is fetched only through the gated route. */
export async function listDocumentSignatures(tx: Tx, orgId: string, documentId: string): Promise<SignatureRow[]> {
  const rows = await tx
    .select({
      id: issuedDocumentSignatures.id,
      versionId: issuedDocumentSignatures.issuedDocumentVersionId,
      slot: issuedDocumentSignatures.slot,
      personId: issuedDocumentSignatures.personId,
      personName: issuedDocumentSignatures.signerName,
      signedAt: issuedDocumentSignatures.signedAt,
    })
    .from(issuedDocumentSignatures)
    .innerJoin(issuedDocumentVersions, eq(issuedDocumentVersions.id, issuedDocumentSignatures.issuedDocumentVersionId))
    .where(and(eq(issuedDocumentSignatures.orgId, orgId), eq(issuedDocumentVersions.issuedDocumentId, documentId)))
    .orderBy(asc(issuedDocumentSignatures.signedAt));
  return rows;
}

/** One signature's stored file and the document it sits on (its store), for the gated image route. */
export async function getSignatureForServing(
  tx: Tx,
  orgId: string,
  signatureId: string,
): Promise<{ documentId: string; storeId: string | null; storagePath: string; contentType: string } | null> {
  const [row] = await tx
    .select({
      documentId: issuedDocuments.id,
      storeId: issuedDocuments.storeId,
      storagePath: storedFiles.storagePath,
      contentType: storedFiles.contentType,
    })
    .from(issuedDocumentSignatures)
    .innerJoin(issuedDocumentVersions, eq(issuedDocumentVersions.id, issuedDocumentSignatures.issuedDocumentVersionId))
    .innerJoin(issuedDocuments, eq(issuedDocuments.id, issuedDocumentVersions.issuedDocumentId))
    .innerJoin(storedFiles, eq(storedFiles.id, issuedDocumentSignatures.fileId))
    .where(and(eq(issuedDocumentSignatures.orgId, orgId), eq(issuedDocumentSignatures.id, signatureId)))
    .limit(1);
  return row ?? null;
}

/** The document row, locked, so a revision, a signature and a void on ONE document queue one after the other. Returns the current version, or null when the document is not in this org. */
export async function lockDocument(tx: Tx, orgId: string, documentId: string): Promise<{ currentVersionId: string; currentVersionNo: number; createdBy: string; voided: boolean } | null> {
  const locked = (await tx.execute(sql`select voided_at from issued_documents where org_id = ${orgId} and id = ${documentId} for update`)) as unknown as { voided_at: Date | null }[];
  if (locked.length === 0) return null;
  const [cur] = await tx
    .select({ id: issuedDocumentVersions.id, versionNo: issuedDocumentVersions.versionNo, createdBy: issuedDocumentVersions.createdBy })
    .from(issuedDocumentVersions)
    .where(and(eq(issuedDocumentVersions.orgId, orgId), eq(issuedDocumentVersions.issuedDocumentId, documentId)))
    .orderBy(desc(issuedDocumentVersions.versionNo))
    .limit(1);
  if (!cur) return null;
  return { currentVersionId: cur.id, currentVersionNo: cur.versionNo, createdBy: cur.createdBy, voided: locked[0]!.voided_at !== null };
}
