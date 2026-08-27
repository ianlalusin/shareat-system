/**
 * Where the bytes actually go. T-141, bible row 155.
 *
 * ## ⭐ An interface, because the bucket is a replaceable detail
 *
 * ADR-002's rule — *"Postgres stores the path, never the bytes"* — only pays off if the thing
 * holding the bytes can be swapped. So the broker talks to this, and the bucket is configuration.
 *
 * > **Ian, 2026-08-27:** *"if we needed to test something that will require us to connect to a
 * > storage, just temporarily create a new one on Google Firebase, then we just repoint it soon
 * > when we're going live."*
 *
 * ⚠️ **The one thing that must NOT differ between a scratch bucket and the live one is
 * deny-all plus Admin-SDK-only access.** Testing against a permissive bucket would prove the broker
 * works while proving nothing about whether it is the only way in.
 */

export interface PutInput {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface StorageDriver {
  readonly name: string;
  put(input: PutInput): Promise<void>;
  /** A URL good for MINUTES, minted per request. ⛔ Never stored, never logged. */
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
  get(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
}

/**
 * ⭐ The default, and deliberately not Firebase.
 *
 * Development and tests need no credentials and no network, and a broker that only works when a
 * cloud bucket is reachable is a broker nobody can test. ⛔ **Never selected in production** —
 * `resolveStorageDriver` refuses to fall back to it when `FIREBASE_STORAGE_BUCKET` is set, because
 * silently writing a receipt to local disk on a server is worse than failing.
 */
export function inMemoryDriver(): StorageDriver & { readonly files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    name: 'in-memory',
    files,
    async put({ path, bytes }) {
      files.set(path, bytes);
    },
    async signedUrl(path, expiresInSeconds) {
      if (!files.has(path)) throw new Error(`storage: ${path} does not exist`);
      // Shaped like the real thing — expiring, opaque — so a caller that wrongly stored one
      // would break here too rather than only in production.
      return `memory://${path}?expires=${Date.now() + expiresInSeconds * 1000}`;
    },
    async get(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`storage: ${path} does not exist`);
      return bytes;
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

let configured: StorageDriver | null = null;

/** Test seam — lets an integration test install the in-memory driver. */
export function setStorageDriver(driver: StorageDriver | null): void {
  configured = driver;
}

/**
 * ⛔ Refuses to guess. If a bucket is configured, a driver for it must be installed — falling back
 * to memory would mean a receipt "uploaded" successfully and then vanishing with the process.
 */
export function resolveStorageDriver(): StorageDriver {
  if (configured) return configured;
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error(
      'storage: FIREBASE_STORAGE_BUCKET is set but no driver is installed. Call ' +
        'setStorageDriver() with the Firebase adapter at startup — falling back to memory here ' +
        'would accept a receipt and then lose it.',
    );
  }
  configured = inMemoryDriver();
  return configured;
}
