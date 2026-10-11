/**
 * T-391 - the production master-data load. docs/tasks/391-production-master-data-load.md.
 *
 *   npm run master-data -- extract --out <dir>            Ian's machine only. Reads v1 (read-only) and writes the
 *                                                         snapshot, its sha256, stores.csv and the LOCAL-ONLY rates file.
 *   npm run master-data -- run --snapshot <file> --map <stores.csv> --org <uuid> --org-code <code>
 *                          --sheets <dir> [--stores LIPA,MLVR] [--actor <person uuid> --apply]
 *                                                         DRY RUN of the item planner (S2): reads v2, writes nothing to
 *                                                         the database, rewrites the item sheets. Exit 0 nothing held,
 *                                                         2 rows held for Ian, 1 error or refusal.
 *
 * `extract` refuses under NODE_ENV=production BEFORE it reads a credential, opens Firestore or touches the disk (R1).
 * `run --apply` (S3) writes the items as --actor through the domain functions. Suppliers and customers (S4), positions and
 * staff (S5) follow in R3 order; `--only positions|items|suppliers|customers|staff` (repeatable) limits the run.
 *
 *   npm run master-data -- validate-hr --roster <staff-roster.csv> --rates <v1-staff-rates.local.csv>
 *                                                         Ian's machine only, pure: no database, no network. Merges the local
 *                                                         pay rates, validates the four statutory ids, writes the merged roster
 *                                                         beside its input and prints "N of M complete" (S7, R15).
 */
import { config } from 'dotenv';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
  const { storeCount, rateConflicts } = await runExtract(makeReadOnlyV1Client(admin.firestore()), { outDir: resolve(out), ratesDir, env: process.env });
  console.log(`Extracted ${storeCount} v1 stores to ${resolve(out)}.`);
  for (const n of rateConflicts) console.log(`PAY CONFLICT: ${n}'s v1 records (one person, several stores) carry different pay; HR decides which row is right.`);
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
  const doApply = process.argv.includes('--apply');
  const actorId = arg('--actor');
  if (actorId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId)) {
    fail('--actor must be a person UUID (the persons.id of the actor who holds approve_item).');
  }
  if (doApply && !actorId) fail('--apply needs --actor <person uuid>: the load writes as a named person who holds approve_item (R8).');
  const { assertSheetsOutsideRepo, parseCsv, toCsv } = await import('../packages/etl/src/master-data/sheets');
  assertSheetsOutsideRepo(sheetsDir, REPO_ROOT);
  const { assertRunTarget, parseStoreMap } = await import('../packages/etl/src/master-data/store-map');
  const { verifySnapshotSha } = await import('../packages/etl/src/master-data/snapshot');
  const { planItems, staleAnswersCsv, ITEM_SHEETS, ITEM_SHEET_COLUMNS } = await import('../packages/etl/src/master-data/items-plan');
  const { closeDb, organizationsRepo, withOrgPrincipal } = await import('@shareat/db');
  const { PARTY_SHEETS, PARTY_SHEET_COLUMNS, planParties } = await import('../packages/etl/src/master-data/parties-plan');
  const { STAFF_SHEETS, STAFF_SHEET_COLUMNS, mergeAccessToGrant, planStaff } = await import('../packages/etl/src/master-data/staff-plan');
  const { applyMasterData, HeldError, loadItemState, loadPartyState, loadStaffState } = await import('./lib/master-data-apply');

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

  for (const s of PARTY_SHEETS) {
    const p = join(sheetsDir, `${s}.csv`);
    if (existsSync(p)) answers[s] = parseCsv(readFileSync(p, 'utf8'));
  }

  for (const s of STAFF_SHEETS) {
    const p = join(sheetsDir, `${s}.csv`);
    if (existsSync(p)) answers[s] = parseCsv(readFileSync(p, 'utf8'));
  }

  const only = process.argv.flatMap((a, i) => (a === '--only' && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
  const known = ['positions', 'items', 'suppliers', 'customers', 'staff'];
  for (const o of only) if (!known.includes(o)) fail(`--only ${o}: must be one of ${known.join(', ')}.`);
  const wants = (e: string): boolean => only.length === 0 || only.includes(e);

  const { existing, links } = await withOrgPrincipal(orgId, (tx) => loadItemState(tx, orgId));
  const partyState = await withOrgPrincipal(orgId, async (tx) => ({
    sup: await loadPartyState(tx, orgId, 'supplier'),
    cus: await loadPartyState(tx, orgId, 'customer'),
  }));

  const plan = planItems({ snapshot, map, orgCode, storeCodes, existing, links, answers });
  const parties = planParties({
    snapshot,
    map,
    orgCode,
    storeCodes,
    existingSuppliers: partyState.sup.existing,
    existingCustomers: partyState.cus.existing,
    links: [...partyState.sup.links, ...partyState.cus.links],
    answers,
  });
  const staffState = await withOrgPrincipal(orgId, (tx) => loadStaffState(tx, orgId));
  const staff = planStaff({ snapshot, map, orgCode, storeCodes, ...staffState, answers });
  const totalHeld =
    (wants('items') ? plan.held : 0) +
    (wants('suppliers') || wants('customers') ? parties.held : 0) +
    (wants('positions') || wants('staff') ? staff.held : 0);

  const actor = actorId ? { orgId, personId: actorId } : undefined;
  const common = { snapshot, snapshotSha: sha, map, orgId, orgCode, storeCodes, answers, actor, only: only.length ? only : undefined };
  const writeSheets = (): void => {
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
    for (const s of PARTY_SHEETS) {
      const p = join(sheetsDir, `${s}.csv`);
      writeFileSync(p, toCsv(PARTY_SHEET_COLUMNS[s], parties.sheets[s]), { mode: 0o600 });
      chmodSync(p, 0o600);
    }
    for (const s of STAFF_SHEETS) {
      const p = join(sheetsDir, `${s}.csv`);
      let rows = staff.sheets[s];
      if (s === 'access-to-grant' && existsSync(p)) rows = mergeAccessToGrant(parseCsv(readFileSync(p, 'utf8')), rows); // never drop who Ian has to grant by hand
      if (s === 'staff-roster' && existsSync(p)) {
        // HR fills the statutory and pay columns in this file: carry them over by row_key, never drop them on a re-run
        const keep = ['sss_no', 'philhealth_no', 'pagibig_no', 'tin', 'pay_basis', 'rate', 'rate_effective_from', 'hr_note'];
        const old = new Map(parseCsv(readFileSync(p, 'utf8')).map((r) => [r.row_key ?? '', r] as const));
        rows = rows.map((r) => ({ ...r, ...Object.fromEntries(keep.map((c) => [c, old.get(r.row_key!)?.[c] ?? ''])) }));
      }
      writeFileSync(p, toCsv(STAFF_SHEET_COLUMNS[s], rows), { mode: 0o600 });
      chmodSync(p, 0o600);
    }
    for (const x of staff.listed) console.log(`LISTED: ${x.note}`);
    for (const x of staff.stale) console.log(`STALE ANSWER (ignored): ${x.sheet} ${x.row_key} ${x.item}`);
    for (const d of staff.drift) console.log(`DRIFT (reported, not written): ${d.entity} ${d.v1Id} ${d.field}: v1 "${d.v1}" v2 "${d.v2}"`);
    for (const x of parties.listed) console.log(`LISTED: ${x.note}`);
    for (const x of parties.stale) console.log(`STALE ANSWER (ignored): ${x.sheet} ${x.row_key} ${x.item}`);
    for (const d of parties.drift) console.log(`DRIFT (reported, not written): ${d.entity} ${d.v1Id} ${d.field}: v1 "${d.v1}" v2 "${d.v2}"`);
  };

  try {
    if (doApply) {
      if (totalHeld > 0) {
        writeSheets(); // the sheets still show Ian what is open
        console.error(`--apply refused: ${totalHeld} row(s) are held for Ian. Nothing was written. Sheets written to ${resolve(sheetsDir)}.`);
        return 2;
      }
      // no sheet rewrite and no "dry run" text on the way: the apply is the run
      const all = await applyMasterData({ ...common, apply: true });
      for (const [name, r] of Object.entries(all)) console.log(`APPLIED: ${r.created} ${name} created, ${r.linked} links written.`);
      return 0;
    }

    writeSheets();
    if (actor && totalHeld === 0) {
      const all = await applyMasterData({ ...common, apply: false }); // the real writes, rolled back
      for (const [name, r] of Object.entries(all)) console.log(`DRY RUN (rolled back, nothing committed): ${r.created} ${name} created, ${r.linked} links written.`);
    } else {
      const creates = plan.writes.filter((w) => w.op === 'create').length;
      const linkOps = plan.writes.filter((w) => w.op === 'link').length;
      const hires = staff.writes.flatMap((w) => (w.entity === 'person' ? w.employments : [])).length;
      console.log(
        `DRY RUN (plan only; add --actor to run the writes rolled back): ${creates} items to create, ${linkOps} existing items to link, ${hires} employments to create.`,
      );
    }
    console.log(`Held for Ian: ${totalHeld}. Stale answers: ${plan.stale.length + parties.stale.length + staff.stale.length}. Sheets written to ${resolve(sheetsDir)}.`);
  } catch (e) {
    if (e instanceof HeldError) {
      console.error(`${e.message} (the plan changed while waiting for the org lock)`);
      return 2;
    }
    throw e;
  } finally {
    await closeDb();
  }
  return totalHeld > 0 ? 2 : 0;
}

/** S7 / R15: pure, on Ian's machine. The merged roster goes beside its input; no id or rate is printed in full. */
async function validateHr(): Promise<number> {
  if (process.env.NODE_ENV === 'production') fail('validate-hr refuses to run under NODE_ENV=production: the filled HR sheet never goes to the server (R15).');
  const rosterArg = arg('--roster');
  const ratesArg = arg('--rates');
  if (!rosterArg || !ratesArg) fail('Pass --roster <staff-roster.csv> --rates <v1-staff-rates.local.csv>.');
  const rosterPath = resolve(rosterArg);
  const ratesPath = resolve(ratesArg);
  const { assertSheetsOutsideRepo, parseCsv, toCsv } = await import('../packages/etl/src/master-data/sheets');
  const { validateHr: validate } = await import('../packages/etl/src/master-data/hr-sheet');
  const { STAFF_SHEET_COLUMNS } = await import('../packages/etl/src/master-data/staff-plan');
  assertSheetsOutsideRepo(dirname(rosterPath), REPO_ROOT); // the filled sheet holds statutory ids: never in a checkout
  const result = validate({ roster: parseCsv(readFileSync(rosterPath, 'utf8')), rates: parseCsv(readFileSync(ratesPath, 'utf8')) });
  const out = join(dirname(rosterPath), `${basename(rosterPath, '.csv')}.merged.csv`);
  writeFileSync(out, toCsv(STAFF_SHEET_COLUMNS['staff-roster'], result.rows), { mode: 0o600 });
  chmodSync(out, 0o600);
  for (const e of result.errors) console.log(`${e.person} / ${e.column}: ${e.message}`);
  console.log(result.summary);
  console.log(`Merged roster written to ${out}`);
  return result.errors.length > 0 ? 2 : 0;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'extract') return extract();
  if (cmd === 'run') process.exit(await run());
  if (cmd === 'validate-hr') process.exit(await validateHr());
  fail(
    'Usage: npm run master-data -- extract --out <dir> | run --snapshot <file> --map <stores.csv> --org <uuid> --org-code <code> --sheets <dir> | validate-hr --roster <file> --rates <file>',
  );
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
