/**
 * Documents - templated HR documents (COE, memo, NTE, contract). T-584, docs/tasks/584-documents.md s4. Migration 0259 (hand-authored, ADR-012).
 *
 * Six tables (`document_kinds` came with T-637, migration 0281):
 *  - `document_kinds`              the org's own list of document kinds (Certificate of employment, Memo, ...), edited on screen. A template points at one by `kind_id`.
 *  - `document_templates`          the library entry: name, kind, retired. Wording lives in its versions.
 *  - `document_template_versions`  APPEND-ONLY. Every save of a template is a new version; an old one is never edited. T-637: `body_doc` is the JSON document, with the page settings
 *                                  (margins, header, footer); `body` is its plain text. A version from before 0281 has `body_doc` NULL and is read through the converter.
 *  - `issued_documents`            the document itself: number, who, when, for whom. Only the void columns may change after insert.
 *  - `issued_document_versions`    APPEND-ONLY (R7). The text of every version of an issued document. A revision is version N+1.
 *  - `issued_document_signatures`  APPEND-ONLY. One row per (version, slot): who signed, when, and which saved signature file,
 *                                  copied BY REFERENCE at signing time so a later change to the person's signature changes nothing.
 *
 * NOTE: ENABLE + FORCE ROW LEVEL SECURITY, the org-isolation policies, the append-only and immutability triggers, the version-sequence
 * and current-version triggers, the expression/CHECK rules Drizzle cannot express (array subset, void all-or-nothing) and the column-level
 * UPDATE grants are hand-added in migration 0259.
 * NOTE: `*_org_id_id_unique` and every `*_same_org_fk` below are mirrored in 0259 as the house same-org pattern (T-398 S1).
 */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { employments } from './employment';
import { organizations } from './organizations';
import { persons } from './persons';
import { storedFiles } from './stored-files';
import { stores } from './stores';

export const DOCUMENT_KIND_STATUSES = ['active', 'retired'] as const;
export type DocumentKindStatus = (typeof DOCUMENT_KIND_STATUSES)[number];
export const DOCUMENT_MARGINS = ['narrow', 'normal', 'wide'] as const;
export type DocumentMargins = (typeof DOCUMENT_MARGINS)[number];

export const SIGNATURE_SLOTS = ['issuer', 'employee'] as const;
export type SignatureSlot = (typeof SIGNATURE_SLOTS)[number];

/** Longest reason kept with a revision or a void (a DB CHECK says the same). */
export const DOCUMENT_REASON_MAX = 500;

/**
 * The facts a printed page needs, copied onto EVERY version when it is written (R7: a version is kept as it was). Print reads this, never the live records, so a
 * later change to the company's registered name or a store's address cannot change a document already issued. Every value may be null (a store with no address).
 */
export interface DocumentLetterhead {
  orgLegalName: string | null;
  orgTradingName: string;
  orgTin: string | null;
  tinBranchCode: string | null;
  storeName: string | null;
  storeAddress: string | null;
  storeContact: string | null;
  templateName: string;
  /** Before 0281 the kind code ('coe'); from T-637 the kind's NAME as it was when the version was written (same value as `kindName`). */
  templateKind: string;
  /** T-637: the kind's name as it was when this version was written. Absent on a version from before 0281. */
  kindName?: string;
  /** T-637: the page this version prints on, header and footer ALREADY FILLED. Absent on a version from before 0281 (it prints the old built-in letterhead above). */
  page?: DocumentPageSnapshot;
}

export interface DocumentPageSnapshot {
  margins: DocumentMargins;
  /** A JSON document (see packages/domain documents/doc.ts), or null for none. */
  headerDoc: unknown;
  footerDoc: unknown;
}

/**
 * T-637. The org's own list of document kinds, edited on /documents/templates. Names are unique per org ignoring case; retiring one is refused while an ACTIVE template uses it
 * (the domain, under a lock on this row). NOTE: the case-insensitive unique index, the name CHECKs, RLS, the grants and the seed are hand-added in migration 0281.
 */
export const documentKinds = pgTable(
  'document_kinds',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status', { enum: DOCUMENT_KIND_STATUSES }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('document_kinds_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: UNIQUE (org_id, lower(name)) is an expression index, hand-added in 0281 as document_kinds_org_name_unique.
    check('document_kinds_name_check', sql`char_length(${t.name}) between 1 and 40 and ${t.name} = btrim(${t.name})`),
    check('document_kinds_status_check', sql`${t.status} in ('active', 'retired')`),
  ],
);

export const documentTemplates = pgTable(
  'document_templates',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    kindId: uuid('kind_id')
      .notNull()
      .references(() => documentKinds.id, { onDelete: 'restrict' }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_templates_org_id_id_unique').on(t.orgId, t.id),
    index('document_templates_org_idx').on(t.orgId),
    index('document_templates_kind_idx').on(t.kindId),
    check('document_templates_name_check', sql`btrim(${t.name}) <> '' and ${t.name} = btrim(${t.name})`),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'document_templates_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.kindId],
      foreignColumns: [documentKinds.orgId, documentKinds.id],
      name: 'document_templates_kind_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const documentTemplateVersions = pgTable(
  'document_template_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => documentTemplates.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    /** The plain text of `body_doc` (`{{field}}` for each tag), or for a version from before 0281 the original wording. */
    body: text('body').notNull(),
    /** T-637: the JSON document (validated on the server at save). NULL for a version from before 0281: it is read through `legacyBodyToDoc(body)`. */
    bodyDoc: jsonb('body_doc').$type<unknown>(),
    /** T-637: page margins, `narrow` / `normal` / `wide` (A4 is the only page size). */
    margins: text('margins', { enum: DOCUMENT_MARGINS }).notNull().default('normal'),
    /** T-637: optional letterhead header and footer, each a JSON document that may hold fields. */
    headerDoc: jsonb('header_doc').$type<unknown>(),
    footerDoc: jsonb('footer_doc').$type<unknown>(),
    /** A subset of `issuer`, `employee`; empty means the document needs no signature. Hand-added CHECK in 0259 (array subset). */
    signatureSlots: text('signature_slots').array().notNull().default(sql`'{}'::text[]`),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_template_versions_org_id_id_unique').on(t.orgId, t.id),
    uniqueIndex('document_template_versions_template_version_unique').on(t.templateId, t.versionNo),
    index('document_template_versions_org_idx').on(t.orgId),
    check('document_template_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('document_template_versions_body_check', sql`btrim(${t.body}) <> '' and length(${t.body}) <= 50000`),
    check('document_template_versions_margins_check', sql`${t.margins} in ('narrow', 'normal', 'wide')`),
    check(
      'document_template_versions_docs_check',
      sql`(${t.bodyDoc} is null or jsonb_typeof(${t.bodyDoc}) = 'object') and (${t.headerDoc} is null or jsonb_typeof(${t.headerDoc}) = 'object') and (${t.footerDoc} is null or jsonb_typeof(${t.footerDoc}) = 'object')`,
    ),
    foreignKey({
      columns: [t.orgId, t.templateId],
      foreignColumns: [documentTemplates.orgId, documentTemplates.id],
      name: 'document_template_versions_template_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'document_template_versions_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const issuedDocuments = pgTable(
  'issued_documents',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** NULL for an organisation-wide memo. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /** `DOC-YYYY-NNNN`, unique per organisation. Gaps are allowed (a rolled-back issue). */
    number: text('number').notNull(),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => documentTemplateVersions.id, { onDelete: 'restrict' }),
    employmentId: uuid('employment_id').references(() => employments.id, { onDelete: 'restrict' }),
    issuedBy: uuid('issued_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
  },
  (t) => [
    unique('issued_documents_org_id_id_unique').on(t.orgId, t.id),
    uniqueIndex('issued_documents_org_number_unique').on(t.orgId, t.number),
    index('issued_documents_org_issued_idx').on(t.orgId, t.issuedAt),
    index('issued_documents_employment_idx').on(t.employmentId),
    check('issued_documents_number_check', sql`${t.number} ~ '^DOC-[0-9]{4}-[0-9]{4,}$'`),
    check(
      'issued_documents_void_all_or_nothing_check',
      sql`(${t.voidedAt} is null and ${t.voidedBy} is null and ${t.voidReason} is null)
        or (${t.voidedAt} is not null and ${t.voidedBy} is not null and coalesce(btrim(${t.voidReason}), '') <> '' and length(${t.voidReason}) <= 500)`,
    ),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'issued_documents_store_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.templateVersionId],
      foreignColumns: [documentTemplateVersions.orgId, documentTemplateVersions.id],
      name: 'issued_documents_template_version_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.employmentId],
      foreignColumns: [employments.orgId, employments.id],
      name: 'issued_documents_employment_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.issuedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'issued_documents_issued_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'issued_documents_voided_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const issuedDocumentVersions = pgTable(
  'issued_document_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    issuedDocumentId: uuid('issued_document_id')
      .notNull()
      .references(() => issuedDocuments.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    body: text('body').notNull(),
    /** T-637: the JSON document of this version. NULL for a version from before 0281 (it keeps the stored `body` and prints from it). */
    bodyDoc: jsonb('body_doc').$type<unknown>(),
    /** NULL for version 1; a revision (version 2 and later) always says why. */
    reason: text('reason'),
    /** Frozen at the time of THIS version (see DocumentLetterhead). */
    letterhead: jsonb('letterhead').$type<DocumentLetterhead>().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('issued_document_versions_org_id_id_unique').on(t.orgId, t.id),
    uniqueIndex('issued_document_versions_doc_version_unique').on(t.issuedDocumentId, t.versionNo),
    index('issued_document_versions_org_idx').on(t.orgId),
    check('issued_document_versions_body_check', sql`btrim(${t.body}) <> '' and length(${t.body}) <= 50000`),
    check(
      'issued_document_versions_reason_check',
      sql`(${t.versionNo} = 1 and ${t.reason} is null) or (${t.versionNo} > 1 and coalesce(btrim(${t.reason}), '') <> '' and length(${t.reason}) <= 500)`,
    ),
    check('issued_document_versions_letterhead_check', sql`jsonb_typeof(${t.letterhead}) = 'object'`),
    check('issued_document_versions_body_doc_check', sql`${t.bodyDoc} is null or jsonb_typeof(${t.bodyDoc}) = 'object'`),
    foreignKey({
      columns: [t.orgId, t.issuedDocumentId],
      foreignColumns: [issuedDocuments.orgId, issuedDocuments.id],
      name: 'issued_document_versions_document_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'issued_document_versions_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const issuedDocumentSignatures = pgTable(
  'issued_document_signatures',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    issuedDocumentVersionId: uuid('issued_document_version_id')
      .notNull()
      .references(() => issuedDocumentVersions.id, { onDelete: 'restrict' }),
    slot: text('slot', { enum: SIGNATURE_SLOTS }).notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    /** The signer's display name as it was when they signed (frozen; a later rename does not touch a printed document). */
    signerName: text('signer_name').notNull(),
    /** The person's CURRENT saved signature at signing time, copied by reference. Never updated, so a later change cannot touch it. */
    fileId: uuid('file_id')
      .notNull()
      .references(() => storedFiles.id, { onDelete: 'restrict' }),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('issued_document_signatures_version_slot_unique').on(t.issuedDocumentVersionId, t.slot),
    index('issued_document_signatures_org_idx').on(t.orgId),
    check('issued_document_signatures_slot_check', sql`${t.slot} in ('issuer', 'employee')`),
    check('issued_document_signatures_signer_name_check', sql`btrim(${t.signerName}) <> ''`),
    foreignKey({
      columns: [t.orgId, t.issuedDocumentVersionId],
      foreignColumns: [issuedDocumentVersions.orgId, issuedDocumentVersions.id],
      name: 'issued_document_signatures_version_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'issued_document_signatures_person_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.fileId],
      foreignColumns: [storedFiles.orgId, storedFiles.id],
      name: 'issued_document_signatures_file_same_org_fk',
    }).onDelete('restrict'),
  ],
);
