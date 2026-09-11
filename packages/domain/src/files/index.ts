/**
 * The upload broker. T-141, ADR-002 §3, bible row 155.
 *
 * ## ⭐ The bucket becomes unreachable from a browser
 *
 * v1 uploads client-side and guards it with `storage.rules`, whose own comments admit the holes:
 * *"any signed-in user can write into any store's folder"*, and — the one nobody had written down
 * — `allow read: if request.auth != null` over the whole bucket, i.e. **every org's documents to
 * every signed-in user** (DEF-070).
 *
 * Here nothing but this module touches the bucket. Paths are derived from the session, reads are
 * `authorize()`d and handed out as short-lived signed URLs, and the bucket's own rules become
 * deny-all — **which is the point rather than a side effect**: once no client reaches it, isolation
 * lives in the same `authorize()` as everything else, and this project's recorded Storage-rules
 * landmines (OR-semantics, `firestore.get()` failing silently) stop being reachable.
 *
 * **A rule you cannot get wrong beats a rule you have to get right.**
 */
import { createHash } from 'node:crypto';
import { authorize, type Actor } from '@shareat/auth';
import { filesRepo, systemTransaction, transaction, type FilePurpose, type Tx } from '@shareat/db';
import { stripImageMetadata } from '@shareat/core/exif';
import { resolveStorageDriver } from './driver';

export * from './driver';

/**
 * What each purpose may hold, and how big. ⚠️ v1 used one blanket 25 MB with *"no content-type
 * restriction"* because a single rule had to cover images, PDFs and Word documents at once.
 * Per-purpose limits make the blanket unnecessary.
 */
export const PURPOSE_LIMITS: Record<
  FilePurpose,
  { readonly types: readonly string[]; readonly maxBytes: number }
> = {
  receipt_photo: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 8 * 1024 * 1024 },
  ar_collection_proof: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 8 * 1024 * 1024 },
  memo_document: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 15 * 1024 * 1024 },
  wastage_dispute: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * 1024 * 1024 },
  onboarding_document: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 25 * 1024 * 1024 },
};

/** The capability that governs the THING, not a generic "may upload". */
const PURPOSE_CAPABILITY: Record<FilePurpose, Parameters<typeof authorize>[2]> = {
  // ⭐ T-130 moved the receipt photo from the expense to the supplier INVOICE, so the capability
  // that governs the thing moved with it. No access changes — both are granted to staff — but a
  // photo is now attached while logging a bill, which is not the same act as recording a spend.
  receipt_photo: 'record_supplier_invoice',
  ar_collection_proof: 'record_ar_collection',
  memo_document: 'manage_users',
  wastage_dispute: 'record_wastage',
  onboarding_document: 'enrol_staff',
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export interface UploadInput {
  purpose: FilePurpose;
  storeId: string | null;
  contentType: string;
  bytes: Uint8Array;
}

export interface UploadResult {
  fileId: string;
  storagePath: string;
  byteSize: number;
  /** How many metadata segments were stripped. Surfaced so "did it actually strip?" is answerable. */
  metadataRemoved: number;
}

export async function uploadFile(
  tx: Tx | null,
  actor: Actor,
  input: UploadInput,
): Promise<UploadResult> {
  if (tx) return runUpload(tx, actor, input);
  return transaction((trx) => runUpload(trx, actor, input));
}

async function runUpload(tx: Tx, actor: Actor, input: UploadInput): Promise<UploadResult> {
  const limits = PURPOSE_LIMITS[input.purpose];
  if (!limits) throw new Error(`uploadFile: ${input.purpose} is not a known kind of file.`);

  // ⭐ Gated on the capability that governs the THING. Attaching a receipt is part of recording an
  // expense, so it needs `create_expense` — not a generic upload permission that would let anyone
  // who can upload anything upload everything.
  await authorize(tx, actor, PURPOSE_CAPABILITY[input.purpose], {
    ...(input.storeId ? { storeId: input.storeId } : {}),
  });

  if (!limits.types.includes(input.contentType)) {
    throw new Error(
      `uploadFile: ${input.contentType} is not accepted for a ${input.purpose.replace(/_/g, ' ')}. ` +
        `Allowed: ${limits.types.join(', ')}.`,
    );
  }
  if (input.bytes.length === 0) throw new Error('uploadFile: the file is empty.');
  if (input.bytes.length > limits.maxBytes) {
    throw new Error(
      `uploadFile: the file is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB, and the limit ` +
        `for a ${input.purpose.replace(/_/g, ' ')} is ${limits.maxBytes / 1024 / 1024} MB.`,
    );
  }

  // ⚠️ A phone photo of a receipt carries GPS, the device serial and the capture time. The photo is
  // evidence of a purchase, not of where an employee was.
  const stripped = stripImageMetadata(input.bytes, input.contentType);
  const bytes = stripped.bytes;

  const id = crypto.randomUUID();
  // ⛔ EVERY SEGMENT COMES FROM THE SERVER. Accepting a client path while calling this "brokered"
  // would be theatre — it is precisely how "any signed-in user can write into any store's folder"
  // happens.
  const storagePath =
    `orgs/${actor.orgId}/` +
    (input.storeId ? `stores/${input.storeId}/` : '') +
    `${input.purpose}/${id}.${EXTENSIONS[input.contentType] ?? 'bin'}`;

  const checksum = createHash('sha256').update(bytes).digest('hex');

  // ⚠️ Bytes first, row second. A row pointing at nothing is a broken reference the app will trip
  // over; bytes with no row are an orphan the sweep collects. The second failure is the cheaper one.
  await resolveStorageDriver().put({ path: storagePath, bytes, contentType: input.contentType });

  const row = await filesRepo.insertFile(tx, {
    id,
    orgId: actor.orgId,
    storeId: input.storeId,
    purpose: input.purpose,
    storagePath,
    contentType: input.contentType,
    byteSize: bytes.length,
    checksum,
    uploadedBy: actor.personId,
  });

  return {
    fileId: row.id,
    storagePath,
    byteSize: bytes.length,
    metadataRemoved: stripped.removed,
  };
}

/**
 * A URL good for a few minutes, minted per request.
 *
 * ⛔ **Never stored and never logged.** A stored URL is a permanent unauthenticated grant, which is
 * exactly what `getDownloadURL()` hands out and exactly what this replaces.
 */
export async function readFileUrl(
  tx: Tx | null,
  actor: Actor,
  input: { fileId: string; expiresInSeconds?: number },
): Promise<{ url: string; contentType: string }> {
  const run = async (trx: Tx) => {
    // ⭐ The org check is the WHOLE POINT (DEF-070). The bucket has no isolation of its own, so
    // this row — reachable only under the actor's own org through RLS — is where it comes from.
    const file = await filesRepo.getById(trx, actor.orgId, input.fileId);
    if (!file) {
      throw new Error(`readFileUrl: file ${input.fileId} does not exist in this org.`);
    }
    await authorize(trx, actor, PURPOSE_CAPABILITY[file.purpose], {
      ...(file.storeId ? { storeId: file.storeId } : {}),
    });

    const url = await resolveStorageDriver().signedUrl(
      file.storagePath,
      input.expiresInSeconds ?? 300,
    );
    return { url, contentType: file.contentType };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Claims a file, so the orphan sweep leaves it alone. */
export async function linkFile(
  tx: Tx,
  orgId: string,
  fileId: string,
  linkedTo: string,
): Promise<void> {
  await filesRepo.linkFile(tx, orgId, fileId, linkedTo);
}

/**
 * ⭐ The orphan sweep — bytes nobody can reach.
 *
 * A file uploaded for a draft that was never saved is unreachable by construction: nothing points
 * at it, and nothing ever will. ⚠️ Like T-140's runs, this REPORTS what it did — a sweep that
 * deletes quietly is indistinguishable from one that has stopped running.
 *
 * ⭐ **T-267/DEF-298 — the row is deleted BEFORE the bytes are removed, deliberately reversed from
 * the original order.** `listOrphans`'s read can go stale: another request may `linkFile` a
 * candidate before this loop reaches it. The database row is the only participant that can decide
 * atomically whether anything still references the file, so it goes first — `deleteFile` now
 * reports whether it actually matched a row (DEF-297), and the bytes are touched only when it did.
 * A file claimed in that window keeps BOTH its row and its bytes; it simply is not an orphan.
 *
 * ⚠️ **The accepted residual, named rather than hidden:** if the row-delete commits and
 * `driver.remove` then fails, the row is gone and the bytes are stranded — wasted storage,
 * detectable and recoverable by a later sweep against the bucket. That is preferred over the
 * alternative (a live row pointing at deleted bytes, which is silent, unrecoverable data loss) and
 * is why the transaction is not held open across the `driver.remove` call to "fix" it — that would
 * trade a benign failure for the worse one this task exists to remove.
 */
export async function sweepOrphanedFiles(
  olderThanHours = 24,
): Promise<{ removed: number; claimed: number; failed: { path: string; error: string }[] }> {
  const driver = resolveStorageDriver();
  const orphans = await systemTransaction((tx) => filesRepo.listOrphans(tx, olderThanHours));

  let removed = 0;
  let claimed = 0;
  const failed: { path: string; error: string }[] = [];
  for (const o of orphans) {
    try {
      const deleted = await systemTransaction((tx) => filesRepo.deleteFile(tx, o.id));
      if (!deleted) {
        // Claimed between the read and this delete — no longer an orphan. Neither removed nor
        // failed: its bytes are deliberately untouched, and there is nothing to retry.
        claimed += 1;
        continue;
      }
      await driver.remove(o.storagePath);
      removed += 1;
    } catch (err) {
      // ⚠️ One unreachable object must not stop the sweep — and it must be visible, not swallowed.
      // ⚠️ If this fires after the row-delete above already committed, the row is gone and these
      // bytes are the accepted residual described above — findable here by `path`, not silent.
      failed.push({ path: o.storagePath, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, claimed, failed };
}
