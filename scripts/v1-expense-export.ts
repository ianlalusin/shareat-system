/**
 * T-502 step 1 - read-only export of v1 expenses. Ian's machine only.
 *   npm run v1-expense-export -- --from YYYY-MM-DD --through YYYY-MM-DD --out <dir> [--stores <v1 ids, comma separated>]
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const V1_ENV = 'C:/Users/ianla/webapps/ERP-rebuild/.env.local';
const USAGE = 'usage: npm run v1-expense-export -- --from YYYY-MM-DD --through YYYY-MM-DD --out <dir> [--stores <v1 store ids, comma separated>]';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<number> {
  if (process.env.NODE_ENV === 'production') {
    fail('v1-expense-export refuses to run under NODE_ENV=production: production holds no v1 credentials. Run it on the owner machine.');
  }
  const from = arg('--from');
  const through = arg('--through');
  const out = arg('--out');
  if (!from || !through || !out) fail(`Pass --from, --through and --out.\n${USAGE}`);
  const si = process.argv.indexOf('--stores');
  if (si >= 0 && (!process.argv[si + 1] || process.argv[si + 1]!.startsWith('--'))) fail(`--stores needs a value.\n${USAGE}`);
  const { assertSheetsOutsideRepo } = await import('../packages/etl/src/master-data/sheets');
  assertSheetsOutsideRepo(out, REPO_ROOT); // real purchase data: never in the work tree
  const { makeReadOnlyV1Client, parseServiceAccountKey } = await import('../packages/etl/src/master-data/snapshot');
  const { runV1ExpenseExport } = await import('./lib/v1-expense-export');

  const rawKey = readFileSync(V1_ENV, 'utf8').match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.*)/)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!rawKey) fail(`FIREBASE_SERVICE_ACCOUNT_KEY not found in ${V1_ENV}.`);
  const sa = parseServiceAccountKey(rawKey);
  const { default: admin } = await import('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(sa as never) });
  const result = await runV1ExpenseExport(makeReadOnlyV1Client(admin.firestore()), {
    from, through, outDir: resolve(out),
    stores: arg('--stores')?.split(',').map((s) => s.trim()).filter(Boolean),
    env: process.env,
  });
  console.log(result.summary);
  console.log(`Wrote ${result.expensesPath}, ${result.entriesPath}, ${result.summaryPath}, ${result.readmePath}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
