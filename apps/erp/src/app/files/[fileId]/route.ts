/**
 * `GET /files/[fileId]` - view an attached photo. T-369 S2 (DEF-198).
 *
 * Mints a short-lived signed URL PER CLICK through `readFileUrl` (which checks the file's own org and the
 * capability that governs its purpose) and redirects to it. Nothing is stored and nothing is logged:
 * a stored URL is a permanent unauthenticated grant, which is what v1's `getDownloadURL()` handed out.
 *
 * ⭐ ONE uniform 404 for every refusal - no grant, another store, another org, no such file, a malformed
 * id - byte for byte the same, so a probe cannot learn whether a file exists (T-364 Q1 (a)). A
 * non-uuid never reaches the database. Anything ELSE (a storage fault) is a 500 with a generic body:
 * "not available to you" would be a lie, and the body and the log carry no id, path or URL.
 *
 * This route returns its own `Response`, never `notFound()`: the framework page is not the uniform body.
 */
import { AuthorizationError } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { FileNotFoundError, readFileUrl } from '@shareat/domain';
import { logger } from '@shareat/core/logger';
import { withOrgPrincipal } from '../../expenses/lib';
import { requireActor } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = 'private, no-store';

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE } });
}
const unavailable = () => text(404, "This photo isn't available to you.");

export async function GET(_request: Request, { params }: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const { fileId } = await params;
  const actor = await requireActor();
  if (!UUID_SHAPE.test(fileId)) return unavailable();

  try {
    const { url } = await withOrgPrincipal(actor.orgId, (tx) => readFileUrl(tx, actor, { fileId }));
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': NO_STORE } });
  } catch (err) {
    // ONLY "no such file for you" and "not allowed" are the uniform 404; any other refusal or fault is not
    // "not available to you" and is not disguised as it.
    if (err instanceof AuthorizationError || err instanceof FileNotFoundError) return unavailable();
    // The error's own text may name the path or the URL, so only its KIND is logged - enough to tell a
    // configuration fault from a refusal, never an id, path or URL.
    const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : undefined;
    logger.error(
      { kind: err instanceof RefusalError ? 'refusal' : 'fault', errorName: err instanceof Error ? err.name : typeof err, ...(code ? { code } : {}) },
      'files: could not open a photo',
    );
    return text(500, 'Something went wrong opening this photo. Try again in a moment.');
  }
}
