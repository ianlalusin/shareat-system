/**
 * The Firebase Storage adapter. T-141 §9, bible row 155.
 *
 * ## ⭐ Why this is its own package
 *
 * `packages/domain` owns the `StorageDriver` interface and must not own a cloud SDK — the same
 * isolation `@shareat/etl-firestore` exists for. Domain code depends on the shape; exactly one
 * package depends on `firebase-admin`, and swapping buckets or providers touches only this file.
 *
 * ## ⛔ What this adapter deliberately cannot do
 *
 * There is **no public-URL method**, and that is the point of the task. v1 uploads client-side and
 * calls `getDownloadURL()`, minting a permanent unguarded link; T-141 §2 records what its own rules
 * file admits — *"any signed-in user can read every file in the bucket"*, across every store and
 * every org. A URL that never expires is a credential that can be forwarded, logged, and pasted
 * into a ticket. So reads are brokered too: `signedUrl` mints one good for minutes, per request,
 * after `authorize()` has already run.
 *
 * ⚠️ **`makePublic()` is never called here and must never be added.** The bucket is deny-all and the
 * Admin SDK bypasses rules; a single `makePublic()` would quietly undo that for one object with no
 * error and no trace.
 */
import { readFileSync } from 'node:fs';
import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import type { StorageDriver, PutInput } from '@shareat/domain';

/** Fixed name so a second call in the same process reuses the app — `initializeApp` is a
 *  singleton-per-name API and throws "app already exists" otherwise. */
const APP_NAME = 'shareat-storage';

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * ⚠️ The parse error's own message is never echoed. Some engines include a snippet of the offending
 * text in `SyntaxError.message`, and a service-account key is exactly the content that must never
 * reach a log — the same rule `etl-firestore/client.ts` follows for the capture credential.
 */
function parseServiceAccount(raw: string): ServiceAccountJson {
  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(raw) as ServiceAccountJson;
  } catch {
    throw new Error(
      'storage: FIREBASE_SERVICE_ACCOUNT_KEY does not parse as JSON. Paste the whole key file ' +
        'as one line, or point at it with a file-based loader — do not paste a fragment.',
    );
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      'storage: FIREBASE_SERVICE_ACCOUNT_KEY parsed but is missing project_id, client_email or ' +
        'private_key. That is a truncated or wrong-shaped key file.',
    );
  }
  return parsed;
}

export interface FirebaseDriverConfig {
  /** The PRIVATE bucket. ⛔ Never the project's default bucket — that one is world-readable
   *  (`allow read;`) and correct only for menu photos. Bible row 155. */
  bucket: string;
  /** The service-account key file's CONTENTS, as JSON text — not a path. `firebaseConfigFromEnv`
   *  resolves the file form before it gets here. */
  serviceAccountKey: string;
}

/**
 * Reads the configuration from the environment, or returns null when storage is not configured.
 *
 * ⭐ **Returning null rather than throwing is deliberate.** Development and tests run with no
 * bucket, and `resolveStorageDriver()` already refuses to fall back to memory when a bucket IS set
 * — so the loud failure lives there, once, instead of in every entry point that calls this.
 */
export type FileReader = (path: string) => string;
const defaultFileReader: FileReader = (path) => readFileSync(path, 'utf8');

export function firebaseConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readFile: FileReader = defaultFileReader,
): FirebaseDriverConfig | null {
  const bucket = env.FIREBASE_STORAGE_BUCKET?.trim();
  if (!bucket) return null;

  const inline = env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim();
  const path = env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE?.trim();

  // ⛔ BOTH forms set is rejected, not silently resolved — `capture.ts` set this precedent and gave
  // the reason: a precedence rule is a rule nobody remembers under pressure, and *"which key did it
  // actually use"* is the worst question to have to ask about a production credential.
  if (inline && path) {
    throw new Error(
      'storage: FIREBASE_SERVICE_ACCOUNT_KEY and FIREBASE_SERVICE_ACCOUNT_KEY_FILE are BOTH set. ' +
        'Pick one — this refuses to guess which credential you meant.',
    );
  }

  if (path) {
    let contents: string;
    try {
      contents = readFile(path);
    } catch {
      // ⚠️ The underlying error is not echoed: a read failure can include the resolved path, and a
      // path is the one part of a credential worth keeping out of a log.
      throw new Error(
        `storage: FIREBASE_SERVICE_ACCOUNT_KEY_FILE points at a file that cannot be read. Check ` +
          `the path is relative to the repo root and the file exists.`,
      );
    }
    return { bucket, serviceAccountKey: contents.trim() };
  }

  if (!inline) {
    throw new Error(
      'storage: FIREBASE_STORAGE_BUCKET is set but no credential is. Set ' +
        'FIREBASE_SERVICE_ACCOUNT_KEY_FILE=./secrets/<name>.json (preferred — the key never enters ' +
        'an env var, a shell history, or a process listing) or FIREBASE_SERVICE_ACCOUNT_KEY as one ' +
        'line. The bucket is deny-all and only the Admin SDK reaches it, so without a credential ' +
        'nothing can read or write it — and a half-configured bucket accepts an upload and loses it.',
    );
  }
  return { bucket, serviceAccountKey: inline };
}

function appFor(serviceAccountKey: string): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return existing;
  const raw = parseServiceAccount(serviceAccountKey);
  return initializeApp(
    {
      // firebase-admin's cert() wants camelCase; the key file is snake_case.
      credential: cert({
        projectId: raw.project_id,
        clientEmail: raw.client_email,
        privateKey: raw.private_key,
      }),
      projectId: raw.project_id,
    },
    APP_NAME,
  );
}

/**
 * ⚠️ **The bucket is trusted from configuration and the PATH is not.** `storagePathFor()` in the
 * domain derives every path from the org and a generated id, and `stored_files.storage_path` carries
 * a CHECK that it starts `orgs/<uuid>/`. This adapter never builds a path and never accepts one from
 * a request — it moves bytes to a path the domain already vouched for.
 */
export function firebaseStorageDriver(config: FirebaseDriverConfig): StorageDriver {
  const bucket = getStorage(appFor(config.serviceAccountKey)).bucket(config.bucket);

  return {
    name: `firebase:${config.bucket}`,

    async put({ path, bytes, contentType }: PutInput): Promise<void> {
      await bucket.file(path).save(Buffer.from(bytes), {
        contentType,
        // ⛔ `resumable: false` because a resumable session URL is itself a write credential with a
        // week-long life. A receipt photo is small; a single request is the whole upload.
        resumable: false,
        metadata: {
          contentType,
          // ⚠️ Private caching only. A shared cache holding an accounting document is a copy of it
          // outside the bucket's deny-all, which is the hole this task exists to close.
          cacheControl: 'private, max-age=0, no-store',
        },
      });
    },

    async signedUrl(path: string, expiresInSeconds: number): Promise<string> {
      // ⭐ v4 signing, minutes not years. ⛔ Never stored and never logged — the caller mints one per
      // request AFTER authorize(), so the link's lifetime is the only thing standing between a
      // forwarded URL and an unauthenticated read.
      const [url] = await bucket.file(path).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresInSeconds * 1000,
      });
      return url;
    },

    async get(path: string): Promise<Uint8Array> {
      const [buf] = await bucket.file(path).download();
      return new Uint8Array(buf);
    },

    async remove(path: string): Promise<void> {
      // ⚠️ `ignoreNotFound` so a retry of a failed cleanup is not itself a failure. Deleting a file
      // that is already gone is the outcome the caller wanted.
      await bucket.file(path).delete({ ignoreNotFound: true });
    },
  };
}
