/**
 * `npm run storage-smoke` — proves the private bucket is reachable by this app and by nobody else.
 *
 * ## ⭐ Why this exists rather than a unit test
 *
 * The adapter's unit tests mock `firebase-admin` and prove the SHAPE of every call. They cannot
 * prove the one thing T-141 §8 says must never differ between a scratch bucket and the live one:
 *
 * > *"deny-all plus Admin-SDK-only access. Testing against a permissive bucket would prove the
 * > broker works while proving nothing about whether it is the only way in."*
 *
 * ⛔ **So check 3 below is the point of this script.** A bucket that accepts an unauthenticated GET
 * is the project's DEFAULT bucket (`allow read;`, world-readable) — correct for menu photos, and
 * catastrophic for supplier invoices, which carry suppliers, prices and volumes and are kept for
 * years. If check 3 fails, the bucket name is wrong or its rules are: do not "fix" it by narrowing
 * a rule, because POS already learned that Storage rules OR across matching blocks and a stricter
 * `allow read` accomplishes nothing (bible row 155).
 *
 * ⚠️ Writes and then deletes a single scratch object under `orgs/_smoke/`. It touches nothing an
 * expense could ever reference.
 *
 * ## ⛔ The PRE-FLIGHT block above check 1 — DEF-311, T-280
 *
 * Checks 1-5 all ask "is THE CONFIGURED BUCKET reachable and private?" — none of them asks
 * "is it the RIGHT bucket?" Production ran `FIREBASE_STORAGE_BUCKET=shareat-hub-v2.
 * firebasestorage.app` (v1's bucket) for the deployment's entire life and all five checks
 * passed, every run, because v1's bucket is reachable and private too. The pre-flight block
 * compares the configured value against `.env.example` and `docs/reference/
 * private-bucket-storage-rules.md` BEFORE any network call, so a wrong-but-reachable bucket now
 * fails immediately instead of passing five checks. See `scripts/lib/config-contract.ts`.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { firebaseConfigFromEnv, firebaseStorageDriver } from '@shareat/storage-firebase';
import {
  checkValueAgainstDocs,
  checkValuesDiffer,
  STORAGE_BUCKET_EXPECTATION,
} from './lib/config-contract';

const PATH = `orgs/_smoke/${Date.now()}.txt`;
const BODY = `shareat storage smoke ${new Date().toISOString()}`;

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function bad(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main() {
  const cfg = firebaseConfigFromEnv();
  if (!cfg) {
    console.error(
      'FIREBASE_STORAGE_BUCKET is not set in .env.local. Nothing to smoke-test.\n' +
        'Set it to the PRIVATE bucket — never the same value as NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`bucket: ${cfg.bucket}`);

  // PRE-FLIGHT — configuration vs documentation (DEF-311). Reachability proves nothing about
  // whether this is the RIGHT bucket; v1's bucket was reachable and private too, and every check
  // below went green against it for the deployment's entire life.
  const bucketCheck = checkValueAgainstDocs(cfg.bucket, STORAGE_BUCKET_EXPECTATION);
  if (!bucketCheck.ok) bad(bucketCheck.message);
  ok(`FIREBASE_STORAGE_BUCKET matches documentation (${cfg.bucket})`);

  const differCheck = checkValuesDiffer(
    { envVar: 'FIREBASE_STORAGE_BUCKET', value: cfg.bucket },
    {
      envVar: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      value: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim() || undefined,
    },
    '.env.example:56,71-73',
  );
  if (!differCheck.ok) bad(differCheck.message);
  ok('FIREBASE_STORAGE_BUCKET is not the public default bucket');

  const driver = firebaseStorageDriver(cfg);

  // 1 — write
  await driver.put({
    path: PATH,
    bytes: new TextEncoder().encode(BODY),
    contentType: 'text/plain',
  });
  ok(`wrote ${PATH}`);

  // 2 — read it back through the Admin SDK
  const back = new TextDecoder().decode(await driver.get(PATH));
  if (back !== BODY) bad(`read back wrong bytes: ${JSON.stringify(back).slice(0, 80)}`);
  ok('read it back through the Admin SDK');

  // 3 — ⭐ THE ONE THAT MATTERS: an unauthenticated GET must be refused.
  const publicUrl = `https://storage.googleapis.com/${cfg.bucket}/${PATH}`;
  const anon = await fetch(publicUrl);
  if (anon.ok) {
    bad(
      `THE BUCKET IS PUBLIC. An unauthenticated GET of ${publicUrl} returned ${anon.status}.\n` +
        '    This is the world-readable default bucket, or its rules allow anonymous reads.\n' +
        '    Accounting documents must NOT go here. Point FIREBASE_STORAGE_BUCKET at a private\n' +
        '    bucket and set deny-all by hand (bible row 155). Do not narrow a rule to fix it.',
    );
  }
  ok(`unauthenticated read refused (HTTP ${anon.status}) — the bucket is private`);

  // 4 — a signed URL works, and only for a few minutes
  const signed = await driver.signedUrl(PATH, 120);
  if (/X-Goog-Expires=(\d+)/.exec(signed)?.[1] !== '120') {
    bad(`signed URL does not expire in 120s: ${signed.slice(0, 120)}`);
  }
  const viaSigned = await fetch(signed);
  if (!viaSigned.ok) bad(`signed URL was refused: HTTP ${viaSigned.status}`);
  if ((await viaSigned.text()) !== BODY) bad('signed URL returned the wrong bytes');
  ok('a signed URL reads it, and expires in 120s');

  // 5 — clean up, and prove it is gone
  await driver.remove(PATH);
  let stillThere = true;
  try {
    await driver.get(PATH);
  } catch {
    stillThere = false;
  }
  if (stillThere) bad('delete did not remove the object');
  ok('deleted');

  console.log('\nStorage is wired correctly: reachable by this app, by nobody else.');
}

main().catch((err) => {
  // ⚠️ Never print the error object wholesale — a firebase-admin auth failure can carry credential
  // fragments in its payload.
  if (process.exitCode !== 1) {
    console.error(`\nstorage-smoke failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
});
