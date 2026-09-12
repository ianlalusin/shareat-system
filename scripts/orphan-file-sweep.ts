/**
 * `npm run orphan-file-sweep` — T-272's nightly orphaned-upload sweep (DEF-299).
 *
 * Invoked by the host's systemd timer, daily:
 *
 *   docs/ops/shareat-orphan-file-sweep.timer  (OnCalendar=*-*-* 03:00 Asia/Manila)
 *
 * ## ⭐ What it is for
 *
 * A file uploaded for a draft that was never saved is bytes nothing will ever point at.
 * `sweepOrphanedFiles` (`@shareat/domain`) collects unclaimed uploads past a day old, per org.
 *
 * ⛔ **Registering the domain function was not the finish line. This script existing and its timer
 * being armed is.** DEF-299: the function shipped with T-141, was documented in two places as a
 * running cron, and had no caller anywhere until this file — the same DEF-186 shape a fourth time.
 * See `docs/ops/README.md`.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is — and DEF-044 is precisely what happens when nothing speaks up.
 *
 * ## ⭐ The storage driver has to be installed HERE too
 *
 * `sweepOrphanedFiles` reaches the storage driver through `resolveStorageDriver()`, which refuses
 * to fall back to the in-memory driver when `FIREBASE_STORAGE_BUCKET` is set — deliberately,
 * because that would delete evidence of a delete without actually removing the bytes. The app
 * installs its driver once at server boot (`apps/erp/src/instrumentation.ts`); a standalone script
 * is a separate process that never runs that hook, so it has to do the same install itself, on the
 * same rule (`null` config ⇒ no bucket configured ⇒ the in-memory default is correct, dev/test).
 * Found by smoketesting this exact script (T-272) — no other job script touches storage, so this
 * gap could not have been hit by any of the six that shipped before it.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runOrphanFileSweep, setStorageDriver } from '@shareat/domain';
import { firebaseConfigFromEnv, firebaseStorageDriver } from '@shareat/storage-firebase';

config({ path: '.env.local' });

const storageConfig = firebaseConfigFromEnv();
if (storageConfig) {
  setStorageDriver(firebaseStorageDriver(storageConfig));
  console.log(`orphan-file-sweep: Firebase storage driver installed for bucket ${storageConfig.bucket}.`);
} else {
  console.log('orphan-file-sweep: no FIREBASE_STORAGE_BUCKET — using the in-memory driver (dev/test).');
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

async function main(): Promise<number> {
  const orgId = arg('org');
  // ⭐ `manual` when a human typed it. "Nobody has run it since March" and "the cron died in March
  // and someone has been running it by hand" are different problems with different fixes.
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`orphan-file-sweep: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runOrphanFileSweep({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
    }
    console.log(`${head}: removed ${o.posted}, claimed ${o.skipped}, failed ${o.failed}`);
    if (o.detail) console.log(`${head}: ${o.detail}`);
    for (const f of o.failures) {
      console.error(`      ⛔ ${f.subjectName}: ${f.reason}`);
    }
  }

  if (result.hadFailures) {
    console.error('orphan-file-sweep: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. An empty run means no orgs were found, which is a configuration problem
    // wearing the costume of a quiet night — the same distinction every other job in this file
    // family draws, for the same reason (bible §13 row 181's sweep-control landmine).
    console.error('orphan-file-sweep: no orgs were processed — nothing to sweep?');
    return 1;
  }
  // ⚠️ Counts, never a bare "done" (bible §15.6). `posted` here is files actually REMOVED.
  const removed = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`orphan-file-sweep: ok — removed ${removed} · ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('orphan-file-sweep: crashed —', err);
    await closeDb();
    process.exit(1);
  });
