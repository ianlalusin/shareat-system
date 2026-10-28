/**
 * T-272/DEF-308 — installs the real storage driver for a STANDALONE SCRIPT.
 *
 * `resolveStorageDriver()` (`packages/domain/src/files/driver.ts`) refuses to fall back to the
 * in-memory driver when `FIREBASE_STORAGE_BUCKET` is set — deliberately, because that would accept
 * a receipt and then lose it. The Next.js app installs the real driver once, at server boot
 * (`apps/erp/src/instrumentation.ts`). A script run by a systemd timer is a separate process that
 * never executes that hook, so it has to do the same install itself, on the same rule.
 *
 * ⛔ Found the hard way (T-272): `scripts/orphan-file-sweep.ts` shipped, passed every gate, and
 * FAILED OUTRIGHT on every organisation the first time it ran end to end, because nothing had ever
 * installed a driver for a standalone process before — no earlier scheduled job touches storage.
 * `resolveStorageDriver()`'s own refusal message now names this file; `tests/unit/
 * scripts-install-storage-driver.test.ts` (T-277) is the guard that makes forgetting it a build
 * failure instead of a night-one crash.
 *
 * ⚠️ `apps/erp/src/instrumentation.ts` cannot use this: it dynamically `import()`s to dodge edge-
 * runtime bundling, gates on `NEXT_RUNTIME`, and never calls `dotenv.config()` because Next.js
 * loads its own env. Those constraints are the server's, not a script's — this file is for
 * `scripts/*.ts` only.
 */
import { setStorageDriver } from '@shareat/domain';
import { firebaseConfigFromEnv, firebaseStorageDriver } from '@shareat/storage-firebase';

/**
 * Call once, before the first domain function that touches storage. `scriptName` prefixes the log
 * line so the host's per-job log file still says which job installed what.
 */
export function installScriptStorageDriver(scriptName: string): void {
  const config = firebaseConfigFromEnv();
  if (config) {
    setStorageDriver(firebaseStorageDriver(config));
    console.log(`${scriptName}: Firebase storage driver installed for bucket ${config.bucket}.`);
    return;
  }
  // Null means no bucket configured — development and tests, where the in-memory default
  // `resolveStorageDriver()` supplies on its own is correct, the same rule instrumentation.ts uses.
  console.log(
    `${scriptName}: no FIREBASE_STORAGE_BUCKET — the in-memory driver is for dev/test only; with NODE_ENV=production the first storage call is refused (T-495).`,
  );
}
