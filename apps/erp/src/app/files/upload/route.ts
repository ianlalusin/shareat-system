/**
 * `POST /files/upload?purpose=..&storeId=..` - upload-on-pick for the photo-upload control. T-441 S1.
 *
 * The browser sends the raw file (so `XMLHttpRequest` can report real byte progress); this route runs the SAME
 * `uploadFile` every other path uses (capability gate, 1 MB image ceiling, EXIF strip, store-derived path), leaves
 * the row unlinked, and answers `{ fileId, contentType, byteSize }`. The record's Save claims it (`claimUpload`);
 * an abandoned one is removed by the nightly orphan sweep after 24 h.
 *
 * Route handlers get no server-action origin check, so this one does its own, in this order:
 *   401 no session (JSON - never a redirect, which an XHR would follow to a 200 sign-in page) -> 403 Origin missing or
 *   foreign -> 400 purpose / store -> 415 type -> 411 no Content-Length -> 413 too big (all decided BEFORE the body is
 *   read) -> 403 capability (non-logging) -> body read with a hard byte cap -> 415 magic bytes -> 429 too many unclaimed -> uploadFile.
 * Faults answer a generic 500 and log only their kind: an error text can name a path or a signed URL.
 */
import { AuthorizationError } from '@shareat/auth';
import { UUID_SHAPE, type FilePurpose } from '@shareat/db';
import {
  assertUnclaimedUploadRoom,
  canUploadFile,
  fileBytesMatchType,
  isImageContentType,
  MAX_IMAGE_BYTES,
  PURPOSE_LIMITS,
  UploadCapError,
  uploadFile,
} from '@shareat/domain';
import { logger } from '@shareat/core/logger';
import { withOrgPrincipal } from '../../expenses/lib';
import { currentSession } from '../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Purposes that have a screen which claims them. A dormant purpose joins when its screen ships; a signature never does. */
const CONTROL_PURPOSES: readonly FilePurpose[] = ['receipt_photo', 'staff_photo', 'leave_document'];

const NO_STORE = 'private, no-store';
function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
  });
}
const refusal = (status: number, error: string) => reply(status, { error });

/** Origin must be present and its host must equal `x-forwarded-host ?? host` (the app sits behind a proxy). */
function sameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return false;
  const expected = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '').split(',')[0]?.trim().toLowerCase();
  if (!expected) return false;
  try {
    return new URL(origin).host.toLowerCase() === expected;
  } catch {
    return false;
  }
}

/** Reads the body, stopping (and cancelling) the moment it passes `cap` bytes. Returns null when it did. */
async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await currentSession();
    if (!session) return refusal(401, 'Your session ended - sign in again, then Retry.');
    const actor = session.actor;

    if (!sameOrigin(request.headers)) return refusal(403, 'This upload was not accepted.');

    const params = new URL(request.url).searchParams;
    const purpose = params.get('purpose') as FilePurpose | null;
    if (!purpose || !CONTROL_PURPOSES.includes(purpose)) return refusal(400, 'That kind of upload is not supported here.');
    const storeId = params.get('storeId');
    if (storeId !== null && !UUID_SHAPE.test(storeId)) return refusal(400, 'Choose a store first.');

    const limits = PURPOSE_LIMITS[purpose];
    const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!limits.types.includes(contentType)) return refusal(415, 'That file type is not accepted here.');

    const lengthHeader = request.headers.get('content-length');
    if (lengthHeader === null) return refusal(411, 'The upload did not say how big it is.');
    if (!/^\d{1,12}$/.test(lengthHeader)) return refusal(400, 'The upload size was not understood.');
    const declared = Number(lengthHeader);
    const cap = isImageContentType(contentType) ? Math.min(limits.maxBytes, MAX_IMAGE_BYTES) : limits.maxBytes;
    // "declared is over the cap", spelled without a relational operator on a string-derived number (the T-371 numeric guard).
    if (Math.max(declared, cap) !== cap) return refusal(413, 'That file is too big.');
    if (declared === 0) return refusal(400, 'That file is empty.');

    // The capability, asked WITHOUT logging and BEFORE the body is pulled: a person who may not upload this here costs us no bytes.
    // (uploadFile authorizes again below - this is the early exit, not the gate.)
    const allowed = await withOrgPrincipal(actor.orgId, (tx) => canUploadFile(tx, actor, purpose, storeId));
    if (!allowed) return refusal(403, 'You are not allowed to upload this here.');

    const bytes = await readCapped(request, cap);
    if (bytes === null) return refusal(413, 'That file is too big.');
    if (bytes.length === 0) return refusal(400, 'That file is empty.');
    if (!fileBytesMatchType(contentType, bytes)) return refusal(415, 'That file does not look like the type it says it is.');

    const uploaded = await withOrgPrincipal(actor.orgId, async (tx) => {
      await assertUnclaimedUploadRoom(tx, actor);
      return uploadFile(tx, actor, { purpose, storeId, contentType, bytes });
    });
    return reply(200, { fileId: uploaded.fileId, contentType, byteSize: uploaded.byteSize });
  } catch (err) {
    if (err instanceof UploadCapError) return refusal(429, err.userMessage);
    if (err instanceof AuthorizationError) return refusal(403, 'You are not allowed to upload this here.');
    logger.error({ kind: 'fault', errorName: err instanceof Error ? err.name : typeof err }, 'files: could not store an upload');
    return refusal(500, 'Something went wrong with the upload. Try again in a moment.');
  }
}
