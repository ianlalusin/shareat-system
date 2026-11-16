/**
 * `GET /documents/signature/[signatureId]` - the image of one signature ON ONE ISSUED DOCUMENT. T-584 S4 (docs/tasks/584-documents.md s7).
 *
 * Anyone who may view that document (`view_documents` at its store) may see the signature image printed on it: an explicit, narrow exception to
 * the staff-signature viewing rule (bible row 353), because the signer's own Employee ID and PIN put it there. The route serves only a signature ROW of a document,
 * never a person's saved signature and never a file id, so it opens nothing else.
 *
 * ⭐ ONE uniform 404 for every refusal - no capability, another store, another organisation, no such signature, a malformed id - byte for byte the same, so
 * a probe cannot learn whether a signature exists (the pattern of `/files/[fileId]`). Anything else is a generic 500: "not available to you" would be a
 * lie, and neither the body nor the log carries an id, path or URL. The bytes are never cached.
 */
import { AuthorizationError } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { documentSignatureImage } from '@shareat/domain';
import { logger } from '@shareat/core/logger';
import { withOrgPrincipal } from '../../lib';
import { requireActor } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = 'private, no-store';

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE } });
}
const unavailable = () => text(404, "This signature isn't available to you.");

export async function GET(_request: Request, { params }: { params: Promise<{ signatureId: string }> }): Promise<Response> {
  const { signatureId } = await params;
  const actor = await requireActor();
  if (!UUID_SHAPE.test(signatureId)) return unavailable();
  try {
    const { bytes, contentType } = await withOrgPrincipal(actor.orgId, (tx) => documentSignatureImage(tx, actor, signatureId));
    return new Response(Buffer.from(bytes), { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': NO_STORE, 'X-Content-Type-Options': 'nosniff' } });
  } catch (err) {
    // "Not allowed" and "no such signature" are the uniform 404; any other refusal or fault is not disguised as one.
    if (err instanceof AuthorizationError || (err instanceof RefusalError && err.userMessage.toLowerCase().includes('does not exist'))) return unavailable();
    logger.error({ kind: err instanceof RefusalError ? 'refusal' : 'fault', errorName: err instanceof Error ? err.name : typeof err }, 'documents: could not open a signature');
    return text(500, 'Something went wrong opening this signature. Try again in a moment.');
  }
}
