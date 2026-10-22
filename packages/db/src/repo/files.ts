/**
 * The only place SQL is written for stored files. T-141.
 *
 * ⛔ **No public-URL column exists to read**, and none should. A read is brokered per request; see
 * `packages/domain/src/files`.
 */
import { and, asc, count, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { FILE_PURPOSES, storedFiles, type FilePurpose } from '../../schema/stored-files';
import { recordGone } from './record-gone';

export interface StoredFileRow {
  id: string;
  orgId: string;
  storeId: string | null;
  purpose: FilePurpose;
  storagePath: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  linkedTo: string | null;
  uploadedBy: string;
  uploadedAt: Date;
}

export interface InsertFileInput {
  id: string;
  orgId: string;
  storeId: string | null;
  purpose: FilePurpose;
  storagePath: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  uploadedBy: string;
}

export async function insertFile(tx: Tx, input: InsertFileInput): Promise<{ id: string }> {
  const [row] = await tx.insert(storedFiles).values(input).returning({ id: storedFiles.id });
  return row!;
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<StoredFileRow | undefined> {
  const [row] = await tx
    .select()
    .from(storedFiles)
    .where(and(eq(storedFiles.id, id), eq(storedFiles.orgId, orgId)))
    .limit(1);
  return row as StoredFileRow | undefined;
}

/** Several files of one org in a single read - for a screen that has to ask about each of a list's photos. */
export async function getByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<StoredFileRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(storedFiles)
    .where(and(eq(storedFiles.orgId, orgId), inArray(storedFiles.id, [...ids])));
  return rows as StoredFileRow[];
}

export async function linkFile(
  tx: Tx,
  orgId: string,
  id: string,
  linkedTo: string,
): Promise<void> {
  const updated = await tx
    .update(storedFiles)
    .set({ linkedTo })
    .where(and(eq(storedFiles.id, id), eq(storedFiles.orgId, orgId)))
    .returning({ id: storedFiles.id });
  if (updated.length === 0) {
    throw recordGone(`linkFile: file ${id} does not exist in org ${orgId}`, 'file');
  }
}

/**
 * T-441 (audit A1) - claim an upload-on-pick file for the record that owns it, in ONE conditional UPDATE.
 * Matches only the uploader's own, still-unlinked file of this purpose and store (NULL-safe), under 24 h old on the
 * DATABASE clock (the clock `listOrphans` uses). Returns whether a row matched; zero rows means "not claimable" for
 * every reason alike. Do not reuse `linkFile`: it has no `linked_to IS NULL` guard.
 */
export async function claimFile(
  tx: Tx,
  input: { orgId: string; id: string; uploadedBy: string; purpose: FilePurpose; storeId: string | null; linkedTo: string },
): Promise<boolean> {
  const updated = await tx
    .update(storedFiles)
    .set({ linkedTo: input.linkedTo })
    .where(
      and(
        eq(storedFiles.id, input.id),
        eq(storedFiles.orgId, input.orgId),
        eq(storedFiles.uploadedBy, input.uploadedBy),
        eq(storedFiles.purpose, input.purpose),
        input.storeId === null ? isNull(storedFiles.storeId) : eq(storedFiles.storeId, input.storeId),
        isNull(storedFiles.linkedTo),
        gt(storedFiles.uploadedAt, sql`now() - interval '24 hours'`),
      ),
    )
    .returning({ id: storedFiles.id });
  return updated.length > 0;
}

/** T-441: how many uploads this person holds that nothing has claimed yet and that are younger than `hours`. */
export async function countUnclaimedBy(tx: Tx, orgId: string, uploadedBy: string, hours: number): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(storedFiles)
    .where(
      and(
        eq(storedFiles.orgId, orgId),
        eq(storedFiles.uploadedBy, uploadedBy),
        isNull(storedFiles.linkedTo),
        gt(storedFiles.uploadedAt, sql`now() - make_interval(hours => ${hours})`),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * ⭐ T-272/DEF-306 — the ONE definition of the orphan sweep's per-run candidate cap. Compared
 * against in `scheduler/index.ts` to detect when a run was capped rather than fully drained
 * (`candidates === ORPHAN_SWEEP_BATCH_LIMIT`); changing the limit here changes the comparison too,
 * so the two cannot silently drift apart the way a duplicated literal would.
 */
export const ORPHAN_SWEEP_BATCH_LIMIT = 500;

/**
 * Files nothing has claimed, older than `hours`, in ONE org.
 *
 * ⭐ T-272/DEF-299 — scoped per org since `scheduler_runs.org_id` is `NOT NULL` and cannot record a
 * global run. Mechanical: `stored_files.org_id` was already `NOT NULL`; this just filters on it.
 */
export async function listOrphans(
  tx: Tx,
  orgId: string,
  hours: number,
): Promise<{ id: string; storagePath: string }[]> {
  return tx
    .select({ id: storedFiles.id, storagePath: storedFiles.storagePath })
    .from(storedFiles)
    .where(
      and(
        eq(storedFiles.orgId, orgId),
        isNull(storedFiles.linkedTo),
        lt(storedFiles.uploadedAt, sql`now() - make_interval(hours => ${hours})`),
        hasNoReferences(orgId),
      ),
    )
    .orderBy(asc(storedFiles.uploadedAt))
    .limit(ORPHAN_SWEEP_BATCH_LIMIT);
}

/**
 * ⛔ Only ever called by the orphan sweep, for a file nothing points at.
 *
 * A file behind a POSTED expense is the evidence for a journal entry; the FK from
 * `expenses.receipt_file_id` is `ON DELETE restrict`, so the database refuses that deletion rather
 * than trusting this function's caller to remember.
 *
 * ⭐ **T-267/DEF-297 — returns whether it deleted a row, deliberately a `boolean` rather than
 * `updateTerms`'s throw-on-zero-rows convention** (`fixed-assets.ts:305-323`). There the row is
 * expected to exist; a miss is a bug. Here the sweep's own read (`listOrphans`) can go stale by the
 * time this runs — another request may `linkFile` the row in between — and that race is a normal,
 * expected outcome, not an error. The caller (`sweepOrphanedFiles`) needs to tell "deleted" from
 * "already claimed, leave it alone" without wrapping every delete in a try/catch for a case that
 * is not exceptional.
 *
 * ⭐ **T-272 — takes `orgId` even though `stored_files` carries FORCE RLS scoping this at the
 * database.** In production the app connects as `doadmin` with `rolbypassrls = t`, so RLS is not
 * enforced there today and the id-came-from-an-org-scoped-read three lines up would otherwise be
 * the ONLY thing keeping this delete inside the caller's org — one layer, where RULES §6 item 3 /
 * bible §15.11 require tenancy to be layered on purpose. Matches `getById`/`linkFile` above.
 */
export async function deleteFile(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const deleted = await tx
    .delete(storedFiles)
    .where(and(eq(storedFiles.id, id), eq(storedFiles.orgId, orgId), isNull(storedFiles.linkedTo), hasNoReferences(orgId)))
    .returning({ id: storedFiles.id });
  return deleted.length > 0;
}

/** Namespace (first int4) for the per-person unclaimed-upload lock. T-441 (see `advisory-locks.ts` for the other namespaces). */
const UNCLAIMED_UPLOAD_LOCK_NAMESPACE = 441001;

/** Serialises one person's uploads from "count what they hold" through the row insert, so parallel requests cannot all
 *  read 29 and all insert. Transaction-scoped: released at COMMIT/ROLLBACK. Take it AFTER the capability check. */
export async function lockUnclaimedUploads(tx: Tx, orgId: string, personId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${UNCLAIMED_UPLOAD_LOCK_NAMESPACE}::int4, hashtext(${orgId}::text || ':' || ${personId}::text))`,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// T-442 - the registry of every column that points at `stored_files`, and the census / backfill reads over it.
// ---------------------------------------------------------------------------------------------------------------------

/** Purposes whose files are read through their own guarded rule (signature, staff photo, leave proof). */
export const GUARDED_PURPOSES: readonly FilePurpose[] = ['staff_signature', 'staff_photo', 'leave_document'];

export interface FileReference {
  table: string;
  column: string;
  /** `table.column` - the key the reports use. */
  label: string;
  /** The purposes a file may have to be linked to a row of this source (T-442 audit A3). Fail closed: list them. */
  allowedPurposes: readonly FilePurpose[];
}

const ref = (table: string, column: string, allowedPurposes: readonly FilePurpose[]): FileReference => ({
  table,
  column,
  label: `${table}.${column}`,
  allowedPurposes,
});

/**
 * ⭐ T-442 - the ONE list of foreign keys into `stored_files`. A test reads `pg_constraint` and fails when a table
 * gains a file column nobody added here. Every source lists the purposes it may point at (audit A3).
 */
export const FILE_REFERENCES: readonly FileReference[] = [
  ref('supplier_invoices', 'receipt_file_id', ['receipt_photo']),
  ref('ar_collections', 'receipt_file_id', ['receipt_photo', 'ar_collection_proof']),
  ref('deliveries', 'proof_file_id', ['receipt_photo']),
  ref('channel_settlements', 'withholding_certificate_file_id', FILE_PURPOSES.filter((p) => !GUARDED_PURPOSES.includes(p))),
  ref('employments', 'photo_file_id', ['staff_photo']),
  ref('persons', 'signature_file_id', ['staff_signature']),
];

export interface ReferenceRow {
  fileId: string;
  ownerId: string;
  source: string;
  purpose: FilePurpose;
}

export interface ReferenceProblem {
  fileId: string;
  ownerId: string;
  source: string;
  /** null when the file is not in this org (cross-org reference): its purpose cannot be read. */
  purpose: FilePurpose | null;
}

export interface UnreferencedRow {
  purpose: FilePurpose;
  bucket: 'fresh' | 'older';
  n: number;
}

/** One row per (source, owner row, file) of this org. Identifiers come from the constant registry, never from input. */
function referencesCte(orgId: string) {
  const branches = FILE_REFERENCES.map(
    (r) =>
      sql`select ${r.label}::text as source, t.id as owner_id, t.${sql.identifier(r.column)} as file_id
            from ${sql.identifier(r.table)} t where t.org_id = ${orgId} and t.${sql.identifier(r.column)} is not null`,
  );
  return sql`refs as (${sql.join(branches, sql` union all `)})`;
}

/** Same predicate at selection and deletion: a committed reference makes a file ineligible. FK RESTRICT remains the backstop. */
function hasNoReferences(orgId: string) {
  return sql`not exists (with ${referencesCte(orgId)} select 1 from refs r where r.file_id = ${storedFiles.id})`;
}

/** Files, not referencing rows: a shared file counts once. All purposes count, including wrong-purpose references. */
export async function countReferencedUnlinked(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.execute(sql`
    with ${referencesCte(orgId)}
    select count(distinct sf.id)::int as n from stored_files sf
    join refs r on r.file_id = sf.id
    where sf.org_id = ${orgId} and sf.linked_to is null`);
  const [row] = rows as unknown as { n: number }[];
  return row?.n ?? 0;
}

/** Every reference whose file is in this org and still has `linked_to IS NULL`, lowest owner id first per file. */
export async function listReferencedUnlinked(tx: Tx, orgId: string): Promise<ReferenceRow[]> {
  const rows = await tx.execute(sql`
    with ${referencesCte(orgId)}
    select r.file_id::text as "fileId", r.owner_id::text as "ownerId", r.source as "source", sf.purpose as "purpose"
      from refs r
      join stored_files sf on sf.id = r.file_id and sf.org_id = ${orgId}
     where sf.linked_to is null
     order by r.file_id, r.owner_id`);
  return rows as unknown as ReferenceRow[];
}

/**
 * Reference problems the backfill reports and never writes:
 *  - `shared`: a file referenced by 2+ rows; lists every reference except the lowest owner id (which owns the link).
 *  - `mismatched`: the file is linked to an id that is not its referencing row's (shared non-owners are `shared` only).
 *  - `crossOrg`: a row of this org references a file that has no `stored_files` row in this org (DEF-491 shape).
 */
export async function listReferenceProblems(
  tx: Tx,
  orgId: string,
): Promise<{ shared: ReferenceProblem[]; mismatched: ReferenceProblem[]; crossOrg: ReferenceProblem[] }> {
  const ranked = sql`
    ranked as (
      select r.file_id, r.owner_id, r.source, sf.purpose, sf.linked_to,
             row_number() over (partition by r.file_id order by r.owner_id) as rn,
             count(*) over (partition by r.file_id) as n
        from refs r
        join stored_files sf on sf.id = r.file_id and sf.org_id = ${orgId}
    )`;
  const cols = sql`file_id::text as "fileId", owner_id::text as "ownerId", source as "source", purpose as "purpose"`;
  const shared = await tx.execute(sql`
    with ${referencesCte(orgId)}, ${ranked}
    select ${cols} from ranked where n > 1 and rn > 1 order by file_id, owner_id`);
  const mismatched = await tx.execute(sql`
    with ${referencesCte(orgId)}, ${ranked}
    select ${cols} from ranked
     where linked_to is not null and linked_to <> owner_id::text and not (n > 1 and rn > 1)
     order by file_id, owner_id`);
  const crossOrg = await tx.execute(sql`
    with ${referencesCte(orgId)}
    select r.file_id::text as "fileId", r.owner_id::text as "ownerId", r.source as "source", null::text as "purpose"
      from refs r
     where not exists (select 1 from stored_files sf where sf.id = r.file_id and sf.org_id = ${orgId})
     order by r.file_id, r.owner_id`);
  return {
    shared: shared as unknown as ReferenceProblem[],
    mismatched: mismatched as unknown as ReferenceProblem[],
    crossOrg: crossOrg as unknown as ReferenceProblem[],
  };
}

/** Files nothing links and nothing references, counted per purpose and age bucket. Report only: the sweep removes them. */
export async function listUnreferenced(tx: Tx, orgId: string): Promise<UnreferencedRow[]> {
  const rows = await tx.execute(sql`
    with ${referencesCte(orgId)}
    select sf.purpose as "purpose",
           case when sf.uploaded_at < now() - interval '24 hours' then 'older' else 'fresh' end as "bucket",
           count(*)::int as "n"
      from stored_files sf
     where sf.org_id = ${orgId} and sf.linked_to is null
       and not exists (select 1 from refs r where r.file_id = sf.id)
     group by 1, 2
     order by 1, 2`);
  return rows as unknown as UnreferencedRow[];
}

/**
 * T-442 - link a file to the row that references it, only if nothing has linked it yet. Returns whether a row changed.
 * ⛔ Not `linkFile`: that has no `linked_to IS NULL` guard and would overwrite an existing link.
 */
export async function backfillLink(tx: Tx, orgId: string, fileId: string, ownerId: string): Promise<boolean> {
  const updated = await tx
    .update(storedFiles)
    .set({ linkedTo: ownerId })
    .where(and(eq(storedFiles.id, fileId), eq(storedFiles.orgId, orgId), isNull(storedFiles.linkedTo)))
    .returning({ id: storedFiles.id });
  return updated.length > 0;
}
