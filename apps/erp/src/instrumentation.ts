/**
 * Server startup. Runs once per Next.js server instance, before any request is served.
 *
 * ⭐ **This is where the storage driver is installed, and it has to be here rather than in a route.**
 * `resolveStorageDriver()` throws if no driver has been installed and the process is in production
 * (bucket set or not) — deliberately, because falling back to the in-memory driver on a server would
 * accept a receipt, report success, and lose it when the process restarts. In production `register()`
 * itself throws when `FIREBASE_STORAGE_BUCKET` is missing or blank (T-495 S1). Installing from a request handler
 * would make that failure depend on which page happened to be visited first.
 *
 * ⚠️ `register()` must complete before the server accepts requests, so a misconfigured bucket fails
 * at boot rather than at the first upload — which is the difference between a deploy that never goes
 * live and one that silently cannot store evidence.
 */
export async function register(): Promise<void> {
  // ⚠️ Node-runtime only. The edge runtime has no `firebase-admin`, and importing it there fails the
  // build rather than at run time.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const [{ setStorageDriver }, { firebaseConfigFromEnv, firebaseStorageDriver }] = await Promise.all([
    import('@shareat/domain'),
    import('@shareat/storage-firebase'),
  ]);

  // Null means no usable bucket is configured (absent, empty or whitespace-only). Development and
  // tests keep the in-memory driver; production refuses to boot (T-495 S1, DEF-791).
  const config = firebaseConfigFromEnv();
  if (!config) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'storage: FIREBASE_STORAGE_BUCKET is not set. Production refuses volatile memory storage - uploads would be lost on restart. ' +
          'Set FIREBASE_STORAGE_BUCKET to the private bucket (docs/ops/README.md).',
      );
    }
    console.log('[storage] no FIREBASE_STORAGE_BUCKET - using the in-memory driver (dev/test only).');
    return;
  }

  setStorageDriver(firebaseStorageDriver(config));
  // ⭐ Say so. A driver that fails to install is otherwise invisible until someone tries to upload
  // a receipt and gets a 500 — which is exactly how this was found (browser smoketest, 2026-08-28).
  // T-140's scheduler follows the same rule: a step that reports nothing cannot be distinguished
  // from one that never ran.
  console.log(`[storage] Firebase driver installed for bucket ${config.bucket}.`);
}
