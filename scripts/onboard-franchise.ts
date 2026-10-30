/**
 * `npm run onboard-franchise -- --file <path> --by <person id> [--map <stores.csv>] [--confirm]`
 *
 * T-398 S7b (docs/tasks/398-s7/S7-REFRESH.md s5): sets up a franchise company (Padre Garcia) from the onboarding data file: its company, store, Ian's person there,
 * the owner, the staff and the franchise agreement, in one transaction. Without --confirm it prints the plan and writes nothing. A second run with the same file says
 * "already onboarded" and writes nothing.
 *
 * --by is Ian's person id in the FRANCHISOR company (an owner / super-admin there). It is required and has no default: it is the person the act is recorded against.
 *
 * Checks that need no database run first, before any connection: the file's shape, the mock-versus-production guard, a real file kept outside the repo, and (with --map)
 * the file agreeing with the T-391 store map. Run by a person, never by a request.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: '.env.local' });

import { closeDb } from '../packages/db/src/client';
import { assertFileMatchesStoreMap, assertOnboardingFileAllowed, parseOnboardingFile } from '../packages/domain/src/organizations/onboarding-file';
import { onboardFranchiseOrganization } from '../packages/domain/src/organizations';
import { parseStoreMap } from '../packages/etl/src/master-data/store-map';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
Usage:
  npm run onboard-franchise -- --file <path> --by <person id> [--map <stores.csv>] [--confirm]

--file and --by are REQUIRED; nothing has a default. Without --confirm the script prints the plan and writes nothing.
`;

function parseArgs(argv: readonly string[]): { file: string; by: string; map?: string; confirm: boolean } {
  const values = new Map<string, string>();
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--confirm') {
      confirm = true;
      continue;
    }
    if (a === '--file' || a === '--by' || a === '--map') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`onboard-franchise: ${a} needs a value.\n${USAGE}`);
      values.set(a.slice(2), v);
      i++;
      continue;
    }
    throw new Error(`onboard-franchise: unrecognised argument "${a}".\n${USAGE}`);
  }
  const file = values.get('file')?.trim();
  const by = values.get('by')?.trim();
  if (!file) throw new Error(`onboard-franchise: --file is required and has no default.\n${USAGE}`);
  if (!by) throw new Error(`onboard-franchise: --by is required and has no default.\n${USAGE}`);
  const map = values.get('map')?.trim();
  return { file, by, ...(map ? { map } : {}), confirm };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.file);

  const file = parseOnboardingFile(JSON.parse(readFileSync(path, 'utf8')));
  assertOnboardingFileAllowed(file, { path, repoRoot, env: process.env });
  if (args.map) assertFileMatchesStoreMap(file, parseStoreMap(readFileSync(resolve(args.map), 'utf8')));

  const result = await onboardFranchiseOrganization({ file, byPersonId: args.by }, { dryRun: !args.confirm });

  if (result.status === 'already-onboarded') {
    console.log(`already onboarded: ${result.orgCode}`);
    return;
  }
  console.log('');
  console.log(`onboard-franchise - ${result.status === 'dry-run' ? 'the plan' : 'DONE'}`);
  console.log('─────────────────────────────────────────────────────────────');
  for (const line of result.plan) console.log(`  ${line}`);
  console.log('─────────────────────────────────────────────────────────────');
  if (result.status === 'dry-run') {
    console.log('(dry run: nothing written) Re-run with --confirm to do it.');
    return;
  }
  console.log(`  company id          : ${result.orgId}`);
  console.log(`  store id            : ${result.storeId}`);
  console.log(`  franchisor person id: ${result.adminPersonId}`);
  console.log(`  owner person id     : ${result.ownerPersonId}`);
  console.log(`  staff               : ${result.staffCount}`);
  console.log('Next: the customer/supplier side and item mirror (S7c), the master-data dry run, provision-terminal --org, and the POS link on the day it starts.');
}

main()
  .catch((err) => {
    console.error('');
    console.error('REFUSED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
