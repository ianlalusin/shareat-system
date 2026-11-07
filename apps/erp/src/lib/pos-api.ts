/**
 * T-525 R1 - the thin glue the three POS v2 doors (apps/erp/src/app/api/pos/{events,snapshot,state}/route.ts) share: JSON replies, the capped body reader,
 * and the one place a typed domain refusal becomes a status. No SQL and no business rule here. Every reply is private to one device: never cached
 * (the snapshot overrides that with `private, no-cache` and an ETag, R7).
 */
import { logger } from '@shareat/core/logger';
import { AuthorizationError, resolvePosTablet, type PosTabletIdentity } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { readPosTabletToken } from '@/lib/session';

export const POS_UNPAIRED = 'This tablet is not paired. Ask a manager to pair it again.';
const MAX_BODY_BYTES = 512 * 1024;

export function json(status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}
export const fail = (status: number, error: string): Response => json(status, { ok: false, error });

/** A 304 has no body. (A named constant: the T-342 guard reads a literal `null` first argument as a null transaction.) */
const NO_BODY = null;
export const notModified = (headers: Record<string, string>): Response => new Response(NO_BODY, { status: 304, headers });

class BodyTooLarge extends Error {}

/** The body as text, capped on ACTUAL bytes (content-length is not trusted). */
export async function readCappedText(req: Request): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The pairing the tablet cookie names, or null (no cookie, forged, revoked, or unused for 30 days). The store and pairing come from here, never from a request. */
export async function tabletPairing(): Promise<PosTabletIdentity | null> {
  return resolvePosTablet(null, await readPosTabletToken());
}

/** Runs a handler; a body that is too large is 413, a typed refusal is 409 (its own sentence), anything else a logged plain 500. */
export async function guarded(route: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BodyTooLarge) return fail(413, 'That request is too large.');
    if (err instanceof RefusalError) return fail(409, err.userMessage);
    if (err instanceof AuthorizationError && err.userMessage) return fail(403, err.userMessage);
    logger.error({ route, code: (err as { code?: string } | null)?.code }, 'pos api: unexpected failure');
    return fail(500, 'Something went wrong on the server. Try again in a moment.');
  }
}
