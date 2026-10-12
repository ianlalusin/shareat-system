/**
 * T-392 - the dual-run comparator, v1 vs v2, per store per week. docs/tasks/392-dual-run-comparator.md Contract section 1.
 *
 *   npm run dual-run -- extract --from 2026-10-19 --through 2026-10-25 --out <dir> [--stores <v1 ids>]
 *       Ian's machine only. Reads v1 (read-only) and writes the snapshot, its .sha256 and dual-run-keys.csv.
 *   npm run dual-run -- compare --snapshot <file> --keys <dual-run-keys.csv> --org <uuid> --actor <person uuid> [--stores LIPA] [--apply]
 *       The droplet: `sudo -u shareat env NODE_ENV=production npm run dual-run -- compare ...` (DEF-634). Without --apply
 *       it prints the per-store-week verdicts and the line table and writes nothing. With --apply it writes one report
 *       version per store-week, one audit row, and deletes the snapshot. Exit 0 all tie / explained / no_data, 2 some
 *       week is open (not a failure), 1 error or refusal.
 *
 * Those are the only two subcommands. Anything else is a usage error. Recording a disposition is not a command line
 * act (R10): it is done on screen by a holder of run_cutover.
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const V1_ENV = 'C:/Users/ianla/webapps/ERP-rebuild/.env.local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = [
  'usage:',
  '  npm run dual-run -- extract --from YYYY-MM-DD --through YYYY-MM-DD --out <dir> [--stores <v1 store ids, comma separated>]',
  '  npm run dual-run -- compare --snapshot <file> --keys <dual-run-keys.csv> --org <uuid> --actor <person uuid> [--stores LIPA,MLVR] [--apply]',
].join('\n');

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const pesos = (centavos: number): string => (centavos / 100).toFixed(2);
const list = (flag: string): string[] | undefined => arg(flag)?.split(',').map((s) => s.trim()).filter(Boolean);

async function extract(): Promise<number> {
  // Before a credential is read, Firestore is opened or the disk is touched.
  if (process.env.NODE_ENV === 'production') {
    fail('extract refuses to run under NODE_ENV=production: production holds no v1 credentials (R3). Run it on the owner machine.');
  }
  const from = arg('--from');
  const through = arg('--through');
  const out = arg('--out');
  if (!from || !through || !out) fail(`Pass --from, --through and --out.\n${USAGE}`);
  const { assertSheetsOutsideRepo } = await import('../packages/etl/src/master-data/sheets');
  assertSheetsOutsideRepo(out, REPO_ROOT); // the snapshot holds names and amounts: never in the work tree
  const { makeReadOnlyV1Client, parseServiceAccountKey } = await import('../packages/etl/src/master-data/snapshot');
  const { runDualRunExtract } = await import('./lib/dual-run-extract');

  const rawKey = readFileSync(V1_ENV, 'utf8').match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.*)/)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!rawKey) fail(`FIREBASE_SERVICE_ACCOUNT_KEY not found in ${V1_ENV}.`);
  const sa = parseServiceAccountKey(rawKey);
  const { default: admin } = await import('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(sa as never) });
  const result = await runDualRunExtract(makeReadOnlyV1Client(admin.firestore()), {
    from,
    through,
    outDir: resolve(out),
    stores: list('--stores'),
    env: process.env,
  });
  console.log(result.summary);
  console.log('Tick the store, money and category rows in dual-run-keys.csv, copy the files to the droplet (chmod 600), then run compare.');
  return 0;
}

async function compare(): Promise<number> {
  const snapshotPath = arg('--snapshot');
  const keysPath = arg('--keys');
  const orgId = arg('--org');
  const actorId = arg('--actor');
  if (!snapshotPath || !keysPath || !orgId || !actorId) fail(`Pass --snapshot, --keys, --org and --actor.\n${USAGE}`);
  if (!UUID.test(orgId)) fail('--org must be an organisation UUID.');
  if (!UUID.test(actorId)) fail('--actor must be a person UUID (the persons.id of a holder of run_cutover).');
  const apply = process.argv.includes('--apply');
  const { loadSnapshotFile, removeSnapshotFile } = await import('./lib/dual-run-extract');
  const { snapshot, sha } = loadSnapshotFile(resolve(snapshotPath)); // sha, mode and owner are checked here
  const keysText = readFileSync(resolve(keysPath), 'utf8');
  const { closeDb } = await import('@shareat/db');
  const { runDualRun } = await import('@shareat/domain');

  try {
    const outcome = await runDualRun(null, { orgId, personId: actorId }, { snapshot, snapshotSha: sha, keysText, storeCodes: list('--stores'), apply });
    console.log(`${apply ? 'APPLY' : 'DRY RUN (nothing written)'}  snapshot sha256 ${outcome.snapshotSha}  keys sha256 ${outcome.keysSha}`);
    if (outcome.excluded.length > 0) {
      console.log(`Excluded (named): ${outcome.excluded.map((e) => `${e.name} - ${e.reason}`).join('; ')}`);
    }
    for (const w of outcome.weeks) {
      console.log(`\n${w.storeCode}  week ${w.weekStart} through ${w.through}  ${w.verdict.toUpperCase()}  compared days ${w.comparedDays}  lines ${w.lineCount}  [${w.status}]`);
      for (const l of w.lines) {
        console.log(`  ${l.kind.padEnd(16)} ${l.key.padEnd(40)} v1 ${pesos(l.v1).padStart(12)}  v2 ${pesos(l.v2).padStart(12)}  delta ${pesos(l.delta).padStart(12)}  ${l.class}${l.paired ? ' (paired)' : ''}`);
      }
    }
    if (apply) {
      removeSnapshotFile(resolve(snapshotPath));
      console.log(`\nSnapshot deleted (sha256 ${outcome.snapshotSha} kept on the reports).`);
    }
    return outcome.exitCode;
  } finally {
    await closeDb();
  }
}

async function main(): Promise<number> {
  const sub = process.argv[2];
  if (sub === 'extract') return extract();
  if (sub === 'compare') return compare();
  console.error(`${sub ? `unknown subcommand ${JSON.stringify(sub)}\n` : ''}${USAGE}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
