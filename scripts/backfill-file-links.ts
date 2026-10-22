/**
 * `npm run backfill-file-links` - T-442 S1 (DEF-672 backfill). Links every file a row already points at but that still
 * has `stored_files.linked_to IS NULL`, so the nightly orphan sweep stops treating in-use files as candidates.
 *
 *   npm run backfill-file-links                        dry run: prints what would be linked, writes nothing
 *   npm run backfill-file-links -- --confirm           links them
 *   npm run backfill-file-links -- --check             read-only census; exit 1 while a linkable referenced file is unlinked
 *   add --org=<uuid> to any of these to run one organisation only
 *
 * Nothing is deleted and no bytes are touched. Shared files link once to the lowest owner id; other references are reported.
 * Mismatched, cross-org and wrong-purpose references are never changed. Files read through a guarded rule (staff photo, staff signature,
 * leave document) are printed as COUNTS ONLY, never an id (audit A2); no path, name or URL is ever printed.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): { confirm: boolean; check: boolean; org: string | null } {
  let confirm = false;
  let check = false;
  let org: string | null = null;
  for (const arg of argv) {
    if (arg === '--confirm') confirm = true;
    else if (arg === '--check') check = true;
    else if (arg.startsWith('--org=')) {
      const v = arg.slice('--org='.length);
      if (!UUID_EXACT.test(v)) throw new Error(`backfill-file-links: --org must be a uuid, got "${v}".`);
      org = v;
    } else {
      throw new Error(`backfill-file-links: unrecognised argument "${arg}". Accepted: --confirm, --check, --org=<uuid>.`);
    }
  }
  if (confirm && check) throw new Error('backfill-file-links: --check is read-only and cannot be combined with --confirm.');
  return { confirm, check, org };
}

interface Problem {
  fileId: string;
  ownerId: string;
  source: string;
  purpose: string | null;
  guarded: boolean;
}

function printProblems(title: string, list: readonly Problem[]): void {
  console.log(`  ${title}: ${list.length}`);
  const guarded = list.filter((p) => p.guarded);
  for (const p of list.filter((x) => !x.guarded)) {
    console.log(`    file ${p.fileId}  source ${p.source}  owner ${p.ownerId}`);
  }
  if (guarded.length > 0) console.log(`    (${guarded.length} guarded file(s): counts only, not listed)`);
}

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

async function main(): Promise<number> {
  const { confirm, check, org } = parseArgs(process.argv.slice(2));
  const { closeDb, schedulerRepo, transaction } = await import('@shareat/db');
  const { backfillFileLinks } = await import('@shareat/domain');
  try {
    // A bare `transaction`, as backfill-store-attendance-config.ts: `organizations` has no org_id to scope against.
    const orgs = await transaction((tx) => schedulerRepo.listOrgsToRun(tx, org ?? undefined));
    if (orgs.length === 0) {
      console.log(org ? `No organization ${org} exists. Nothing processed.` : 'No organizations exist. Nothing processed.');
      return 1;
    }
    const write = confirm && !check;
    console.log('');
    console.log(`backfill-file-links - ${write ? 'CONFIRM (writing)' : check ? 'CHECK (read-only)' : 'DRY RUN (nothing is written)'}`);
    console.log('-------------------------------------------------------------');

    let failed = 0;
    let stillUnlinked = 0;
    for (const o of orgs) {
      try {
        const r = await backfillFileLinks(o.id, { confirm: write, readOnly: check });
        console.log(`${o.name} (${o.id})`);
        const verb = write ? 'linked' : 'would link';
        console.log(`  ${verb}: ${sum(r.linked)}`);
        for (const [k, n] of Object.entries(r.linked)) console.log(`    by purpose ${k}: ${n}`);
        for (const [k, n] of Object.entries(r.bySource)) console.log(`    by source  ${k}: ${n}`);
        printProblems('shared (one file, several rows; linked to the lowest owner id)', r.shared);
        printProblems('mismatched (file already linked to a different id)', r.mismatched);
        printProblems('referenced but not in this organization', r.crossOrg);
        printProblems('wrong purpose for the row that references it (not linked)', r.wrongPurpose);
        console.log(`  unreferenced and unlinked (the sweep removes the old ones): ${sum(r.unreferenced)}`);
        for (const [k, n] of Object.entries(r.unreferenced)) console.log(`    ${k}: ${n}`);
        // Only a LINKABLE referenced file fails the census. Wrong-purpose, cross-org and mismatched references are printed
        // above but do not change the exit code (ruling, T-442).
        stillUnlinked += write ? 0 : sum(r.linked);
      } catch (err) {
        failed++;
        console.log(`${o.name} (${o.id}) FAILED - ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log('-------------------------------------------------------------');
    console.log(`  organizations processed ${orgs.length - failed}, failed ${failed}`);
    if (check) console.log(`  referenced files still unlinked: ${stillUnlinked}`);
    if (!confirm && !check) console.log('DRY RUN - nothing was written. Re-run with --confirm to link.');
    if (failed > 0) return 1;
    if (check && stillUnlinked > 0) return 1;
    return 0;
  } finally {
    await closeDb();
  }
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
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('backfill-file-links FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
