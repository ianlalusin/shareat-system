/**
 * Server startup. Runs once per Next.js server instance, before any request is served.
 *
 * ⭐ **This is where the storage driver is installed, and it has to be here rather than in a route.**
 * `resolveStorageDriver()` throws if `FIREBASE_STORAGE_BUCKET` is set and no driver has been
 * installed — deliberately, because falling back to the in-memory driver on a server would accept a
 * receipt, report success, and lose it when the process restarts. Installing from a request handler
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

  // Null means no bucket is configured — development and tests, where the in-memory driver is
  // correct and `resolveStorageDriver()` supplies it on its own.
  const config = firebaseConfigFromEnv();
  if (!config) return;

  setStorageDriver(firebaseStorageDriver(config));
}
