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
import { authorize, type Actor, can } from '@shareat/auth';
import { filesRepo, goneSentence, refuse, RefusalError, transaction, UUID_SHAPE, withSystemOrgPrincipal, type FilePurpose, type Tx } from '@shareat/db';
import { stripImageMetadata } from '@shareat/core/exif';
import { logger } from '@shareat/core/logger';
import { resolveStorageDriver } from './driver';
import {
  decideLeaveDocumentRead,
  LEAVE_DOCUMENT_LINK_SECONDS,
  recordLeaveDocumentViewed,
  recordLeaveDocumentViewRefused,
} from '../leave/document-access';
import { signatureUrl } from './signature';
import { fileBytesMatchType } from './magic';

export * from './driver';
export { mayViewSignature, SIGNATURE_LINK_SECONDS } from './signature';
export { fileBytesMatchType } from './magic';

import { isImageContentType, MAX_IMAGE_BYTES, PURPOSE_LIMITS, type LimitPurpose } from './limits';

// T-441 (audit A7): the limits live in a db-free leaf the browser imports; this is the same object, re-exported.
export { isImageContentType, MAX_IMAGE_BYTES, PURPOSE_LIMITS } from './limits';

/** Compile-time check: the leaf's purpose list equals the schema's `FILE_PURPOSES`. A drift in either fails `typecheck`. */
type _SamePurposes = [LimitPurpose] extends [FilePurpose] ? ([FilePurpose] extends [LimitPurpose] ? true : never) : never;
const purposesMatchSchema: _SamePurposes = true;
void purposesMatchSchema;

/** The capability that governs the THING, not a generic "may upload". */
const PURPOSE_CAPABILITY: Record<FilePurpose, Parameters<typeof authorize>[2]> = {
  // ⭐ T-130 moved the receipt photo from the expense to the supplier INVOICE, so the capability
  // that governs the thing moved with it. A photo is attached while logging a bill, which is not
  // the same act as recording a spend. ⚠️ T-318 (2026-09-14): `record_supplier_invoice` and
  // `record_wastage` below are no longer automatic for `staff` — a position grant now decides who
  // holds them, same as everyone else the matrix once granted them to.
  receipt_photo: 'record_supplier_invoice',
  ar_collection_proof: 'record_ar_collection',
  memo_document: 'manage_users',
  wastage_dispute: 'record_wastage',
  onboarding_document: 'enrol_staff',
  // T-436: this governs UPLOAD only (attaching a certificate is a manage_attendance act). ⛔ READING a leave_document never goes
  // through this map - see `readFileUrl`'s leave branch and `leave/document-access.ts` (bible row 353).
  leave_document: 'manage_attendance',
  staff_photo: 'enrol_staff',
  // ⛔ T-434: this governs UPLOAD of a signature only. Signature READS never use it: see `./signature` (`mayViewSignature`).
  staff_signature: 'enrol_staff',
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

/**
 * T-441: whether this actor may upload this purpose at this store - the SAME capability `runUpload` gates on, asked with the
 * non-logging `can`, so the upload route can refuse a person who lacks it BEFORE it reads the request body. A presentation of
 * the gate, not a replacement: `uploadFile` still authorizes.
 */
export async function canUploadFile(tx: Tx, actor: Actor, purpose: FilePurpose, storeId: string | null): Promise<boolean> {
  return can(tx, actor, PURPOSE_CAPABILITY[purpose], { ...(storeId ? { storeId } : {}) });
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
  // T-441: the declared type is not trusted - the first bytes must match it, on EVERY path (route and no-JS action alike).
  if (!fileBytesMatchType(input.contentType, input.bytes)) {
    throw new Error(`uploadFile: the file does not look like the ${input.contentType} it says it is.`);
  }
  // ⭐ T-296. The app-wide photo ceiling, checked BEFORE the per-purpose limit so an oversized
  //    image gets the message about photos rather than the one about its purpose's larger cap.
  if (isImageContentType(input.contentType) && input.bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `uploadFile: this photo is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB and photos ` +
        `are capped at ${MAX_IMAGE_BYTES / 1024 / 1024} MB everywhere in the app. It is normally ` +
        'compressed in the browser before upload — if you have JavaScript disabled, or the ' +
        'compression failed, crop or retake the photo and try again.',
    );
  }
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
 * The ONE refusal that means "no such file for you". A class of its own so `/files/[fileId]` can turn
 * exactly this - and nothing else - into its uniform 404: any other refusal is not "not available to
 * you" and must not be disguised as it.
 */
export class FileNotFoundError extends RefusalError {
  constructor(message: string) {
    super(message, goneSentence('photo'));
    this.name = 'FileNotFoundError';
  }
}

/**
 * THE capability check for opening a stored file: the capability that governs the file's PURPOSE, at the
 * file's own store. One function, used by `readFileUrl` (which enforces it) and by `canReadFile` /
 * `canReadFiles` (which only ask it, so a screen can hide a link that would 404) - a check copied into
 * the second place is a check that drifts.
 */
async function assertCanRead(trx: Tx, actor: Actor, file: { purpose: FilePurpose; storeId: string | null }): Promise<void> {
  await authorize(trx, actor, PURPOSE_CAPABILITY[file.purpose], { ...(file.storeId ? { storeId: file.storeId } : {}) });
}

/**
 * Whether this actor may open this file, as a boolean, never minting a URL. The screens ask it before drawing
 * a "View photo" link, so nobody is handed a control that can only 404. ⚠️ A presentation aid: `readFileUrl`
 * is what enforces it. An UNEXPECTED fault hides the link (and logs its kind) rather than crashing the page.
 */
export async function canReadFile(tx: Tx, actor: Actor, fileId: string): Promise<boolean> {
  return (await canReadFiles(tx, actor, [fileId])).has(fileId);
}

/**
 * The subset of `fileIds` this actor may open - ONE read for the files, and one authorize per distinct
 * (purpose capability, store) rather than per file. A fault (anything but "not allowed") hides the links
 * and logs only its kind, never an id, path or URL.
 */
export async function canReadFiles(tx: Tx, actor: Actor, fileIds: readonly string[]): Promise<Set<string>> {
  const allowed = new Set<string>();
  try {
    const files = await filesRepo.getByIds(tx, actor.orgId, [...new Set(fileIds)]);
    const verdicts = new Map<string, boolean>();
    for (const file of files) {
      // ⛔ T-436: a leave document is never offered on the strength of the UPLOAD capability. The screens ask this to draw a
      // "View photo" link; for a certificate the only reader is `openLeaveDocument` (row 353), so no link is ever drawn from here.
      if (file.purpose === 'leave_document') continue;
      // ⛔ T-434: a signature is NEVER decided here (the shared verdict is keyed by capability + store, the wrong question for it).
      if (file.purpose === 'staff_signature') continue;
      const key = `${PURPOSE_CAPABILITY[file.purpose]}|${file.storeId ?? ''}`;
      let ok = verdicts.get(key);
      if (ok === undefined) {
        // T-402 S2 (A2): the non-logging check - the same capability and store `assertCanRead` gates on.
        ok = await can(tx, actor, PURPOSE_CAPABILITY[file.purpose], { ...(file.storeId ? { storeId: file.storeId } : {}) });
        verdicts.set(key, ok);
      }
      if (ok) allowed.add(file.id);
    }
  } catch (err) {
    logger.error({ kind: 'fault', errorName: err instanceof Error ? err.name : typeof err }, 'files: could not check who may open a photo');
    return new Set();
  }
  return allowed;
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
      // A typed refusal, message unchanged: `/files/[fileId]` has to tell "no such file for you" (a 404)
      // from an internal fault (a 500), and a bare Error cannot be told from either.
      throw new FileNotFoundError(`readFileUrl: file ${input.fileId} does not exist in this org.`);
    }
    // ⛔ T-436 (bible row 353): a medical certificate is opened by its OWN rule, never by `PURPOSE_CAPABILITY` (which governs upload).
    // A viewer who may not open it gets the SAME not-found as a missing id (so a guessed id confirms nothing), the attempt is
    // written in a separate transaction so it survives this one rolling back, and the link lasts 60 seconds whatever was asked.
    if (file.purpose === 'leave_document') {
      const verdict = await decideLeaveDocumentRead(trx, actor, file);
      if (!verdict.allowed) {
        await recordLeaveDocumentViewRefused(actor, verdict);
        throw new FileNotFoundError(`readFileUrl: file ${input.fileId} does not exist in this org.`);
      }
      await recordLeaveDocumentViewed(trx, actor, verdict);
      const leaveUrl = await resolveStorageDriver().signedUrl(
        file.storagePath,
        Math.min(input.expiresInSeconds ?? LEAVE_DOCUMENT_LINK_SECONDS, LEAVE_DOCUMENT_LINK_SECONDS),
      );
      return { url: leaveUrl, contentType: file.contentType };
    }
    // ⛔ T-434: a signature goes through its own rule, its own 60 s link and its own audit - never `assertCanRead`.
    if (file.purpose === 'staff_signature') return signatureUrl(trx, actor, file);
    await assertCanRead(trx, actor, file);

    const url = await resolveStorageDriver().signedUrl(
      file.storagePath,
      input.expiresInSeconds ?? 300,
    );
    return { url, contentType: file.contentType };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * T-441 (audit A1/A2) - THE claim of an upload-on-pick file by the record that now owns it. ONE conditional
 * UPDATE in the repo (`claimFile`): the file must be this person's own unlinked upload of this purpose and store,
 * under 24 h old on the database clock, and it is linked in the same statement - so two concurrent Saves cannot
 * both win and the orphan sweep (which deletes only `linked_to IS NULL`) cannot take a claimed file.
 *
 * Every failure - missing, someone else's, another org's, wrong purpose or store, already taken, expired,
 * malformed id - is the SAME sentence, so a probe learns nothing. Call it after the record insert, in the same
 * transaction, for both the upload-first path and the no-JS path.
 */
export async function claimUpload(
  tx: Tx,
  actor: Actor,
  input: { fileId: string; purpose: FilePurpose; storeId: string | null; linkTo: string },
): Promise<void> {
  const unavailable = () => refuse('claimUpload: not claimable', 'That photo is no longer available - pick it again.');
  if (!UUID_SHAPE.test(input.fileId) || !UUID_SHAPE.test(input.linkTo)) throw unavailable();
  const claimed = await filesRepo.claimFile(tx, {
    orgId: actor.orgId,
    id: input.fileId,
    uploadedBy: actor.personId,
    purpose: input.purpose,
    storeId: input.storeId,
    linkedTo: input.linkTo,
  });
  if (!claimed) throw unavailable();
}

/** T-441 ruling: one person may hold at most this many unclaimed uploads younger than 24 h. */
export const UNCLAIMED_UPLOAD_CAP = 30;

/** Thrown by `assertUnclaimedUploadRoom`; the upload route turns exactly this into a 429. */
export class UploadCapError extends RefusalError {
  constructor() {
    super(
      'upload cap reached',
      'You have too many photos waiting to be saved. Save or remove some, then try again.',
    );
    this.name = 'UploadCapError';
  }
}

/** Refuses when this person already holds `UNCLAIMED_UPLOAD_CAP` unclaimed uploads under 24 h old (a flood guard, not a quota). */
export async function assertUnclaimedUploadRoom(tx: Tx, actor: Actor): Promise<void> {
  // The per-person lock is held to COMMIT, so the count and the insert that follows are one step for this person.
  await filesRepo.lockUnclaimedUploads(tx, actor.orgId, actor.personId);
  const held = await filesRepo.countUnclaimedBy(tx, actor.orgId, actor.personId, 24);
  if (held >= UNCLAIMED_UPLOAD_CAP) throw new UploadCapError();
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
 * ⭐ The orphan sweep — bytes nobody can reach, for ONE org.
 *
 * A file uploaded for a draft that was never saved is unreachable by construction: nothing points
 * at it, and nothing ever will. ⚠️ Like T-140's runs, this REPORTS what it did — a sweep that
 * deletes quietly is indistinguishable from one that has stopped running.
 *
 * ⭐ **T-272/DEF-299 — scoped per org, no longer global.** `scheduler_runs.org_id` is `NOT NULL`
 * and cannot represent a global run, so this can only be wired to a nightly timer once it runs
 * once per org. Mechanical, not architectural: `stored_files.org_id` was already `NOT NULL`
 * (`listOrphans` just filters on it now), and the write side moves from the bare
 * `systemTransaction()` this used while genuinely cross-org (DEF-287) to `withSystemOrgPrincipal`,
 * the same principal every other system-kind scheduler job uses. See
 * `docs/tasks/272-def-299-orphan-sweep-timer.md`.
 *
 * ⭐ **T-267/DEF-298 — the row is deleted BEFORE the bytes are removed, deliberately reversed from
 * the original order.** `listOrphans`'s read can go stale: another request may `linkFile` a
 * candidate before this loop reaches it. The database row is the only participant that can decide
 * atomically whether anything still references the file, so it goes first — `deleteFile` now
 * reports whether it actually matched a row (DEF-297), and the bytes are touched only when it did.
 * A file claimed in that window keeps BOTH its row and its bytes; it simply is not an orphan.
 *
 * ⚠️ **The accepted residual, named rather than hidden:** if the row-delete commits and
 * `driver.remove` then fails, the row is gone and the bytes are stranded — wasted storage.
 * ⛔ **DEF-307 — NOT currently detectable or recoverable.** That would need bucket enumeration
 * compared against `stored_files`, and the storage driver interface (`./driver`) has no `list`
 * method at all, so nothing today can find these bytes. Accepted anyway because it is preferred
 * over the alternative (a live row pointing at deleted bytes, which is silent, unrecoverable data
 * loss), and is why the transaction is not held open across the `driver.remove` call to "fix" it —
 * that would trade a benign, if currently unrecoverable, failure for the worse one this task exists
 * to remove.
 */
export async function sweepOrphanedFiles(
  orgId: string,
  olderThanHours = 24,
): Promise<{
  removed: number;
  claimed: number;
  /** How many candidates this run saw, before claimed/failed are subtracted out — DEF-306: the
   *  signal that `listOrphans`'s `.limit(500)` cap was hit (`candidates === 500`), since a capped
   *  run and a fully-drained one are otherwise indistinguishable. */
  candidates: number;
  failed: { path: string; error: string }[];
}> {
  const driver = resolveStorageDriver();
  const orphans = await withSystemOrgPrincipal(orgId, (tx) => filesRepo.listOrphans(tx, orgId, olderThanHours));

  let removed = 0;
  let claimed = 0;
  const failed: { path: string; error: string }[] = [];
  for (const o of orphans) {
    try {
      const deleted = await withSystemOrgPrincipal(orgId, (tx) => filesRepo.deleteFile(tx, orgId, o.id));
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
  return { removed, claimed, candidates: orphans.length, failed };
}
