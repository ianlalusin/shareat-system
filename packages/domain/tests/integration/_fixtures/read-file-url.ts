import type { Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { authorizeFileRead, signFileRead } from '@shareat/domain';

/** Authorize and sign in one call. Production reads in two halves (the route signs after its transaction, DEF-554); a test that holds one transaction wants both. */
export async function readFileUrl(
  tx: Tx,
  actor: Actor,
  input: { fileId: string; expiresInSeconds?: number },
): Promise<{ url: string; contentType: string }> {
  return signFileRead(await authorizeFileRead(tx, actor, input));
}
