/**
 * T-625 step 4. Copies every object a `stored_files` row points at from the OLD bucket to the NEW one, then checks
 * each landed object's size and MD5 against the old one. Objects already in the new bucket with the same MD5 are skipped,
 * so it is safe to run again after an interruption.
 *
 *   npx tsx scripts/firebase-move/copy-files.ts --from-key=<old.json> --to-key=<new.json> --from-bucket=<old> --to-bucket=<new>
 *       dry run: reads object details only (no bytes move), prints counts
 *   ...same arguments plus --confirm       copies
 *
 * It NEVER deletes from either bucket. The key files are given by PATH and never printed. Prints counts; row ids only for
 * problem files that are not guarded (staff photos, signatures and leave documents are counted, never listed).
 * Exit 1 when any source object is missing or any copy failed.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { checkValueAgainstDocs, NEW_STORAGE_BUCKET, STORAGE_BUCKET_EXPECTATION } from '../lib/config-contract';
import { bucketOf, closeApp, openApp, readKeyFile, streamCopy } from './admin';
import { MoveArgError, NEW_PROJECT_ID, parseMode, requiredArg, runCopy } from './lib';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { confirm } = parseMode(argv);
  const fromKey = readKeyFile(requiredArg('from-key', argv));
  const toKey = readKeyFile(requiredArg('to-key', argv));
  const fromBucket = requiredArg('from-bucket', argv);
  const toBucket = requiredArg('to-bucket', argv);

  // The arguments cannot be swapped by accident: the destination must be the new project and the documented new bucket.
  if (toKey.projectId !== NEW_PROJECT_ID) throw new MoveArgError(`--to-key must be a key of project ${NEW_PROJECT_ID}. Nothing was copied.`);
  if (fromKey.projectId === toKey.projectId) throw new MoveArgError('--from-key and --to-key are the same project. Nothing was copied.');
  const bucketCheck = checkValueAgainstDocs(toBucket, STORAGE_BUCKET_EXPECTATION);
  if (!bucketCheck.ok) throw new MoveArgError(`--to-bucket must be ${NEW_STORAGE_BUCKET}. Nothing was copied.`);
  if (fromBucket === toBucket) throw new MoveArgError('--from-bucket and --to-bucket are the same. Nothing was copied.');

  const { requireSystemUrl, readStoredFiles } = await import('./db');
  requireSystemUrl();
  const files = await readStoredFiles();
  console.log(`copy-files: ${confirm ? 'CONFIRM (copying)' : 'DRY RUN (no bytes move)'} - ${files.length} stored file row(s)`);
  if (files.length === 0) {
    console.log('copy-files: no stored files, nothing to copy.');
    return 0;
  }

  const fromApp = openApp('move-from', fromKey);
  const toApp = openApp('move-to', toKey);
  try {
    const src = bucketOf(fromApp, fromBucket);
    const dst = bucketOf(toApp, toBucket);
    const r = await runCopy(
      files,
      { statSrc: (p) => src.stat(p), statDst: (p) => dst.stat(p), copyObject: (p) => streamCopy(src, dst, p) },
      confirm,
    );
    console.log(
      `  total ${r.total} | copied ${r.copied} | would copy ${r.wouldCopy} | already there (same MD5) ${r.skipped} | MISSING in old bucket ${r.missingSource} | failed ${r.failed}`,
    );
    if (r.problemIds.length > 0) console.log(`  problem file row ids (first 20): ${r.problemIds.slice(0, 20).join(', ')}`);
    if (r.missingSource > 0 || r.failed > 0) {
      console.error('copy-files: NOT clean. Do not carry on to the switch-over until this is explained.');
      return 1;
    }
    console.log(confirm ? 'copy-files: done. Next: verify.' : 'copy-files: dry run clean. Run again with --confirm to copy.');
    return 0;
  } finally {
    await closeApp(fromApp);
    await closeApp(toApp);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('copy-files FAILED:', e instanceof Error ? e.message : 'unknown error');
    process.exit(1);
  });
