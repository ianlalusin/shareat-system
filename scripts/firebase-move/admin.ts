/**
 * T-625 - the Google side of the move scripts: load a service-account key FROM A FILE PATH, open a named firebase-admin
 * app, stat and stream objects. This is the only file in scripts/firebase-move that talks to Google.
 *
 * - The key is read from the path given on the command line. Its contents are never printed, copied or put in an env var.
 * - Errors are reduced to a fixed message plus a numeric status code: a firebase-admin auth failure can carry credential fragments.
 * - There is no delete here, on purpose. The old bucket keeps every object until Ian deletes them himself (rollback path).
 */
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { GoogleCallError, MoveArgError, type ObjMeta } from './lib';

export interface Key {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export function readKeyFile(path: string): Key {
  let parsed: { type?: string; project_id?: string; client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new MoveArgError('A key file could not be read or is not JSON. Check the path. (Its contents are never shown.)');
  }
  if (parsed.type !== 'service_account' || !parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new MoveArgError('A key file is not a service-account key (type, project_id, client_email or private_key is missing).');
  }
  return { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

export function openApp(name: string, key: Key): App {
  return initializeApp(
    { credential: cert({ projectId: key.projectId, clientEmail: key.clientEmail, privateKey: key.privateKey }), projectId: key.projectId },
    name,
  );
}

export const closeApp = (app: App): Promise<void> => deleteApp(app);

/** Status code of a Google error, or 0. Never the message. */
export function statusOf(e: unknown): number {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : 0;
}

export function bucketOf(app: App, bucket: string) {
  const b = getStorage(app).bucket(bucket);
  return {
    async stat(path: string): Promise<ObjMeta | null> {
      try {
        const [m] = await b.file(path).getMetadata();
        return { md5: typeof m.md5Hash === 'string' ? m.md5Hash : '', size: Number(m.size ?? -1) };
      } catch (e) {
        if (statusOf(e) === 404) return null;
        throw new GoogleCallError(`Google answered with status ${statusOf(e) || 'unknown'} while reading object details.`);
      }
    },
    file: (path: string) => b.file(path),
  };
}

/** Streams one object from `src` bucket to `dst` bucket, keeping its content type. Throws on any failure. Never deletes. */
export async function streamCopy(src: ReturnType<typeof bucketOf>, dst: ReturnType<typeof bucketOf>, path: string): Promise<void> {
  const [m] = await src.file(path).getMetadata();
  await pipeline(
    src.file(path).createReadStream(),
    dst.file(path).createWriteStream({ resumable: false, contentType: typeof m.contentType === 'string' ? m.contentType : undefined }),
  );
}

/** How many of these uids does the project NOT have? (getUsers takes at most 100 per call; the caller chunks.) */
export async function countMissingUids(app: App, uids: readonly string[]): Promise<number> {
  try {
    const r = await getAuth(app).getUsers(uids.map((uid) => ({ uid })));
    return r.notFound.length;
  } catch (e) {
    const s = e as { code?: unknown; errorInfo?: { code?: unknown } } | null;
    const code = typeof s?.code === 'string' ? s.code : typeof s?.errorInfo?.code === 'string' ? s.errorInfo.code : 'unknown';
    throw new GoogleCallError(`Google answered with error ${code.replace(/[^a-z0-9/_-]/gi, '').slice(0, 60)} while checking accounts.`);
  }
}
