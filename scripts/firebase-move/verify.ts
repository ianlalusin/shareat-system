/**
 * T-625 step 6. Checks the NEW project holds everything Postgres points at: every live firebase credential uid exists as a
 * user, and every stored file exists in the new bucket at the recorded size. Exit 1 on any gap or when nothing was checked.
 *
 *   npx tsx scripts/firebase-move/verify.ts --key=<new.json> --bucket=<new>             dry run: database counts only, no call to Google
 *   npx tsx scripts/firebase-move/verify.ts --key=<new.json> --bucket=<new> --confirm   runs the checks (read-only on Google)
 *
 * Read-only everywhere. The key is given by PATH and never printed. Prints counts only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { checkValueAgainstDocs, NEW_STORAGE_BUCKET, STORAGE_BUCKET_EXPECTATION } from '../lib/config-contract';
import { bucketOf, closeApp, countMissingUids, openApp, readKeyFile } from './admin';
import { chunk, fileGap, MoveArgError, NEW_PROJECT_ID, parseMode, requiredArg, summariseVerify } from './lib';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { confirm } = parseMode(argv);
  const key = readKeyFile(requiredArg('key', argv));
  const bucket = requiredArg('bucket', argv);
  if (key.projectId !== NEW_PROJECT_ID) throw new MoveArgError(`--key must be a key of project ${NEW_PROJECT_ID}.`);
  if (!checkValueAgainstDocs(bucket, STORAGE_BUCKET_EXPECTATION).ok) throw new MoveArgError(`--bucket must be ${NEW_STORAGE_BUCKET}.`);

  const { requireSystemUrl, readLiveFirebaseUids, readStoredFiles } = await import('./db');
  requireSystemUrl();
  const uids = await readLiveFirebaseUids();
  const files = await readStoredFiles();
  console.log(`verify: ${confirm ? 'CONFIRM (checking)' : 'DRY RUN (database counts only)'} - ${uids.length} live credential(s), ${files.length} stored file row(s)`);
  if (!confirm) return uids.length > 0 ? 0 : 1;

  const app = openApp('move-verify', key);
  try {
    let uidsMissing = 0;
    for (const batch of chunk(uids, 100)) uidsMissing += await countMissingUids(app, batch);
    const b = bucketOf(app, bucket);
    let filesMissing = 0;
    let filesWrongSize = 0;
    for (const f of files) {
      const gap = fileGap(f, await b.stat(f.path));
      if (gap === 'missing') filesMissing++;
      else if (gap === 'size') filesWrongSize++;
    }
    const r = summariseVerify({ uidsChecked: uids.length, uidsMissing, filesChecked: files.length, filesMissing, filesWrongSize });
    console.log(`  accounts: ${r.uidsChecked} checked, ${r.uidsMissing} missing | files: ${r.filesChecked} checked, ${r.filesMissing} missing, ${r.filesWrongSize} wrong size`);
    console.log(r.ok ? 'verify: OK - the new project holds every account and file.' : 'verify: GAPS FOUND (or nothing was checked). Do not switch over.');
    return r.ok ? 0 : 1;
  } finally {
    await closeApp(app);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('verify FAILED:', e instanceof Error ? e.message : 'unknown error');
    process.exit(1);
  });
