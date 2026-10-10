/**
 * T-391 - the production master-data load. docs/tasks/391-production-master-data-load.md.
 *
 *   npm run master-data -- extract --out <dir>            Ian's machine only. Reads v1 (read-only) and writes the
 *                                                         snapshot, its sha256, stores.csv and the LOCAL-ONLY rates file.
 *   npm run master-data -- run --snapshot <file> --map <stores.csv> --org <uuid> --org-code <code>
 *                          --sheets <dir> [--stores LIPA,MLVR]
 *                                                         DRY RUN of the item planner (S2): reads v2, writes nothing to
 *                                                         the database, rewrites the item sheets. Exit 0 nothing held,
 *                                                         2 rows held for Ian, 1 error or refusal.
 *
 * `extract` refuses under NODE_ENV=production BEFORE it reads a credential, opens Firestore or touches the disk (R1).
 * Applying (`run --apply`), suppliers, customers, staff and `validate-hr` arrive with S3 to S5.
 */
import { config } from 'dotenv';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const V1_ENV = 'C:/Users/ianla/webapps/ERP-rebuild/.env.local';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function extract(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    fail('extract refuses to run under NODE_ENV=production: production holds no v1 credentials (R1). Run it on the owner machine.');
  }
  const out = arg('--out');
  if (!out) fail('Pass --out <dir>.');
  const { assertSheetsOutsideRepo } = await import('../packages/etl/src/master-data/sheets');
  assertSheetsOutsideRepo(out, REPO_ROOT); // the snapshot holds names: never in the work tree
  const ratesDir = resolve(arg('--rates-out') ?? `${resolve(out)}-rates`);
  assertSheetsOutsideRepo(ratesDir, REPO_ROOT); // pay rates: outside every checkout, and never under --out
  const { makeReadOnlyV1Client, parseServiceAccountKey, runExtract } = await import('../packages/etl/src/master-data/snapshot');

  const raw = readFileSync(V1_ENV, 'utf8').match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.*)/)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!raw) fail(`FIREBASE_SERVICE_ACCOUNT_KEY not found in ${V1_ENV}.`);
  const sa = parseServiceAccountKey(raw);
  const { default: admin } = await import('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(sa as never) });
  const { storeCount } = await runExtract(makeReadOnlyV1Client(admin.firestore()), { outDir: resolve(out), ratesDir, env: process.env });
  console.log(`Extracted ${storeCount} v1 stores to ${resolve(out)}.`);
  console.log(`Fill org_code and store_code in stores.csv. The pay rates are in ${ratesDir} and never leave this machine.`);
}

async function run(): Promise<number> {
  const snapshotPath = arg('--snapshot');
  const mapPath = arg('--map');
  const orgId = arg('--org');
  const orgCode = arg('--org-code');
  const sheetsDir = arg('--sheets');
  if (!snapshotPath || !mapPath || !orgId || !orgCode || !sheetsDir) {
    fail('Pass --snapshot <file> --map <stores.csv> --org <uuid> --org-code <code> --sheets <dir>.');
  }
  if (process.argv.includes('--apply')) fail('--apply is not available yet: this slice is the dry run of the item planner.');
  const { assertSheetsOutsideRepo, parseCsv, toCsv } = await import('../packages/etl/src/master-data/sheets');
  assertSheetsOutsideRepo(sheetsDir, REPO_ROOT);
  const { assertRunTarget, parseStoreMap } = await import('../packages/etl/src/master-data/store-map');
  const { verifySnapshotSha } = await import('../packages/etl/src/master-data/snapshot');
  const { planItems, staleAnswersCsv, ITEM_SHEETS, ITEM_SHEET_COLUMNS } = await import('../packages/etl/src/master-data/items-plan');
  const { closeDb, itemsRepo, masterLinksRepo, organizationsRepo, withOrgPrincipal } = await import('@shareat/db');

  const sha = verifySnapshotSha(snapshotPath); // refuses a snapshot that no longer matches its .sha256
  console.log(`Snapshot sha256 ${sha}`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const map = parseStoreMap(readFileSync(mapPath, 'utf8'));
  const orgRowCode = await withOrgPrincipal(orgId, async (tx) => (await organizationsRepo.identityOf(tx, orgId))?.code ?? '');
  assertRunTarget(map, { orgCode, orgRowCode }); // the --org row must be the org --org-code names
  const storeCodes = arg('--stores')?.split(',').map((s) => s.trim()).filter(Boolean);

  const answers: Record<string, Record<string, string>[]> = {};
  for (const s of ITEM_SHEETS) {
    const p = join(sheetsDir, `${s}.csv`);
    if (existsSync(p)) answers[s] = parseCsv(readFileSync(p, 'utf8'));
  }

  const { existing, links } = await withOrgPrincipal(orgId, async (tx) => ({
    existing: (await itemsRepo.listItems(tx, orgId, { includeInactive: true })).map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status as 'active' | 'inactive' | 'merged',
      baseUnit: i.baseUnit,
      kind: i.kind,
      purchaseUnit: i.purchaseUnit,
      purchaseFactor: i.purchaseFactor,
      // ItemRow does not declare merged_into_id, but listItems selects the whole row, so it is there at runtime
      mergedIntoId: (i as { mergedIntoId?: string | null }).mergedIntoId ?? null,
    })),
    links: (await masterLinksRepo.linksFor(tx, orgId, 'item')).map((l) => ({
      entity: l.entity as string,
      v1StoreId: l.v1StoreId,
      v1Id: l.v1Id,
      v2Id: l.v2Id,
      v1Unit: l.v1Unit,
      factorToBase: l.factorToBase,
    })),
  }));

  const plan = planItems({ snapshot, map, orgCode, storeCodes, existing, links, answers });

  mkdirSync(sheetsDir, { recursive: true });
  if (plan.stale.length > 0) {
    // written and printed BEFORE the sheets are rewritten: a stale answer is never lost
    const stalePath = join(sheetsDir, 'items-stale.csv');
    writeFileSync(stalePath, staleAnswersCsv(plan.stale), { mode: 0o600 });
    console.log(`STALE ANSWERS (v1 changed under them; kept in ${stalePath}):`);
    for (const x of plan.stale) console.log(`  ${x.sheet} ${x.row_key} ${x.item}`);
  }
  for (const s of ITEM_SHEETS) {
    const p = join(sheetsDir, `${s}.csv`);
    writeFileSync(p, toCsv(ITEM_SHEET_COLUMNS[s], plan.sheets[s]), { mode: 0o600 });
    chmodSync(p, 0o600);
  }
  const creates = plan.writes.filter((w) => w.op === 'create').length;
  const linkOps = plan.writes.filter((w) => w.op === 'link').length;
  console.log(`DRY RUN (nothing written to the database): ${creates} items to create, ${linkOps} existing items to link.`);
  console.log(`Held for Ian: ${plan.held}. Stale answers: ${plan.stale.length}. Sheets written to ${resolve(sheetsDir)}.`);
  await closeDb();
  return plan.held > 0 ? 2 : 0;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'extract') return extract();
  if (cmd === 'run') process.exit(await run());
  fail('Usage: npm run master-data -- extract --out <dir> | run --snapshot <file> --map <stores.csv> --org <uuid> --org-code <code> --sheets <dir>');
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('master-data FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
