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

/**
 * ⛔ **Held on `globalThis`, not in a module variable, and that is not paranoia.**
 *
 * A plain `let` here was installed correctly at boot and still invisible at upload time. Next
 * compiles `instrumentation.ts` and a server action into SEPARATE module graphs, so a
 * transpiled workspace package like this one is instantiated twice in one process: `register()`
 * set the driver on its copy, `uploadFile()` read `null` from the other, and the upload failed
 * with "no driver is installed" while the boot log said it had been.
 *
 * ⚠️ Found by uploading a receipt in a browser (2026-08-28). Every gate was green — typecheck,
 * 602 unit, 1055 integration, build — because the integration tests install the in-memory driver
 * directly and therefore only ever touch ONE instance. This class of bug is invisible to a test
 * suite that does not cross a bundler boundary.
 *
 * `Symbol.for` uses the process-wide symbol registry, so every instance resolves the same slot.
 */
const DRIVER_SLOT = Symbol.for('shareat.storage.driver');

interface DriverHolder {
  [DRIVER_SLOT]?: StorageDriver | null;
}

function holder(): DriverHolder {
  return globalThis as unknown as DriverHolder;
}

/** Installs the driver process-wide. Called at server startup, and by tests. */
export function setStorageDriver(driver: StorageDriver | null): void {
  holder()[DRIVER_SLOT] = driver;
}

/**
 * ⛔ Refuses to guess. If a bucket is configured, a driver for it must be installed — falling back
 * to memory would mean a receipt "uploaded" successfully and then vanishing with the process.
 */
export function resolveStorageDriver(): StorageDriver {
  const configured = holder()[DRIVER_SLOT];
  if (configured) return configured;
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error(
      'storage: FIREBASE_STORAGE_BUCKET is set but no driver is installed. Call ' +
        'setStorageDriver() with the Firebase adapter at startup — falling back to memory here ' +
        'would accept a receipt and then lose it. A standalone script must install its own, since ' +
        "it never runs the app's boot hook (apps/erp/src/instrumentation.ts) — call " +
        'installScriptStorageDriver() from scripts/lib/storage-bootstrap.ts, as ' +
        'scripts/orphan-file-sweep.ts does (DEF-308).',
    );
  }
  // ⛔ T-495 S1 (DEF-791): the memory driver is for development and tests ONLY. A production process that reaches here has no bucket
  // configured (or blank) and no installed driver; serving memory would acknowledge a receipt and lose it with the process. Refuse.
  // The check lives here, not in env(): env() also runs at build time, which must not need production settings.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'storage: FIREBASE_STORAGE_BUCKET is not set and no driver is installed, so a production process would keep uploads in ' +
        'volatile memory and lose them on restart. Set FIREBASE_STORAGE_BUCKET to the private bucket (docs/ops/README.md) so the ' +
        'boot hook (apps/erp/src/instrumentation.ts) installs the Firebase driver.',
    );
  }
  const memory = inMemoryDriver();
  holder()[DRIVER_SLOT] = memory;
  return memory;
}
