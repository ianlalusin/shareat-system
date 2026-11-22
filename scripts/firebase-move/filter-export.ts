/**
 * T-625 step 2. Cuts a `firebase auth:export` file down to the uids in the uid file, ready for `firebase auth:import`
 * into the new project.
 *
 *   npx tsx scripts/firebase-move/filter-export.ts --in=<export.json> --uids=<uids.txt>
 *       dry run: prints counts, writes nothing
 *   npx tsx scripts/firebase-move/filter-export.ts --in=<export.json> --uids=<uids.txt> --confirm --out=<filtered.json>
 *   add --allow-missing to write even when some listed uids are not in the export
 *
 * The export holds password hashes: treat both files as secrets, keep them off git, delete them after the move. Prints counts only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { filterAuthExport, MoveArgError, parseAuthExport, parseMode, parseUidList, requiredArg, safeMessage } from './lib';

function main(): number {
  const argv = process.argv.slice(2);
  const { confirm } = parseMode(argv);
  const inFile = requiredArg('in', argv);
  const uidFile = requiredArg('uids', argv);
  const out = confirm ? requiredArg('out', argv) : undefined;
  if (out && existsSync(out)) throw new MoveArgError('The --out file already exists. Pick a new name or delete it first; this script never overwrites.');

  const uids = parseUidList(readFileSync(uidFile, 'utf8'));
  if (uids.length === 0) throw new MoveArgError('The uid file lists no uids.');
  const exp = parseAuthExport(readFileSync(inFile, 'utf8'));
  const { filtered, kept, missing, extraDropped } = filterAuthExport(exp, uids);

  console.log(`filter-export: ${confirm ? 'CONFIRM' : 'DRY RUN (nothing is written)'}`);
  console.log(`  uids wanted: ${uids.length} | users in export: ${exp.users.length} | kept: ${kept} | left out: ${extraDropped} | wanted but NOT in export: ${missing}`);
  if (missing > 0 && !argv.includes('--allow-missing')) {
    console.error('filter-export: some listed uids are not in the export (an account the old project no longer has?). Nothing written. Look into it, or add --allow-missing.');
    return 1;
  }
  if (out) {
    writeFileSync(out, JSON.stringify(filtered), { flag: 'wx' });
    console.log(`filter-export: wrote ${kept} user(s) to ${out}`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error('filter-export FAILED:', safeMessage(e));
  process.exit(1);
}
