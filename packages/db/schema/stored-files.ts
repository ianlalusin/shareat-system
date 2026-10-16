/**
 * Files the books point at — receipts, proofs, exports. T-141, ADR-002 §3, bible row 155.
 *
 * ## ⭐ Postgres stores the PATH, never the bytes
 *
 * ADR-002's rule, and it is what keeps the bucket a replaceable detail: migrating to another
 * bucket later is a copy job plus a path rewrite, not a re-architecture.
 *
 * ## ⛔ There is no public URL column
 *
 * A stored URL is a **permanent unauthenticated grant** — which is exactly what Firebase's
 * `getDownloadURL()` hands out, and exactly what T-141 exists to remove. Reads go through a route
 * that calls `authorize()` and mints a signed URL good for minutes.
 *
 * ## ⭐ One table, not a URL column per feature
 *
 * v1 grew **six separate uploaders** — onboarding docs, receipt proofs, purchase proofs, wastage
 * disputes, memo docs, staff photos — and none of them shared a check. One table means one broker,
 * one content-type allow-list, one retention policy and one orphan sweep.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/**
 * What the file is FOR. ⚠️ Drives the size cap and the allow-list — v1's blanket 25 MB with
 * *"no content-type restriction"* was a compromise forced by having one rule for every kind of
 * upload, and per-purpose limits make it unnecessary.
 */
export const FILE_PURPOSES = [
  'receipt_photo',
  'ar_collection_proof',
  'memo_document',
  'wastage_dispute',
  'onboarding_document',
  // T-436 (migration 0205): a medical-certificate photo for a leave request. Row-353 guarded; read only via assertCanReadLeaveDocument.
  'leave_document',
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export const storedFiles = pgTable(
  'stored_files',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⚠️ Nullable: an org-level export belongs to no store. Everything else names one. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),

    purpose: text('purpose', { enum: FILE_PURPOSES }).notNull(),

    /**
     * ⭐ Derived server-side from the session, NEVER accepted from the client.
     * `orgs/{orgId}/stores/{storeId}/{purpose}/{id}.{ext}` — a client-supplied path is how
     * *"any signed-in user can write into any store's folder"* happens (DEF-070's neighbour).
     */
    storagePath: text('storage_path').notNull(),

    contentType: text('content_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    /** SHA-256 of the stored bytes, so "is this the file the entry points at?" is answerable. */
    checksum: text('checksum').notNull(),

    /** ⚠️ Null until something claims it. The orphan sweep collects what is still null after a
     *  day — a file uploaded for a draft nobody saved is bytes no one can reach. */
    linkedTo: text('linked_to'),

    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stored_files_org_purpose_idx').on(t.orgId, t.purpose),
    index('stored_files_unlinked_idx').on(t.uploadedAt).where(sql`${t.linkedTo} is null`),
    uniqueIndex('stored_files_path_unique').on(t.storagePath),

    check('stored_files_size_positive_check', sql`${t.byteSize} > 0`),
    /** ⛔ The path must be the shape the broker builds. A row whose path did not come from the
     *  deriver is the one thing that would make every other guarantee here decorative. */
    check('stored_files_path_shape_check', sql`${t.storagePath} ~ '^orgs/[0-9a-f-]{36}/'`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'stored_files_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.uploadedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stored_files_uploaded_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);
