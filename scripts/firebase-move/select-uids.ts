/**
 * T-625 step 1. Lists the Firebase uids that live `person_credentials` rows point at (kind firebase, not revoked),
 * so only those accounts are imported into the new project.
 *
 *   npx tsx scripts/firebase-move/select-uids.ts                            dry run: prints the count, writes nothing
 *   npx tsx scripts/firebase-move/select-uids.ts --confirm --out=uids.txt   writes one uid per line
 *
 * Read-only on Postgres. Prints a count, never a uid or an email. The output file holds uids: keep it off git and delete it after the move.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { existsSync, writeFileSync } from 'node:fs';
import { MoveArgError, parseMode, requiredArg, safeMessage } from './lib';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { confirm } = parseMode(argv);
  const out = confirm ? requiredArg('out', argv) : undefined;
  if (out && existsSync(out)) throw new MoveArgError('The --out file already exists. Pick a new name or delete it first; this script never overwrites.');

  const { requireSystemUrl, readLiveFirebaseUids } = await import('./db');
  requireSystemUrl();
  const uids = await readLiveFirebaseUids();
  console.log(`select-uids: ${confirm ? 'CONFIRM' : 'DRY RUN (nothing is written)'} - ${uids.length} live firebase credential(s)`);
  if (uids.length === 0) {
    console.error('select-uids: zero credentials found. That is a wrong database or a wrong connection, not an empty system. Nothing written.');
    return 1;
  }
  if (out) {
    writeFileSync(out, uids.join('\n') + '\n', { flag: 'wx' });
    console.log(`select-uids: wrote ${uids.length} uid(s) to ${out}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('select-uids FAILED:', safeMessage(e));
    process.exit(1);
  });
