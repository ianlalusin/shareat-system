/**
 * `npm run cutover:purge` — ADR-007, docs/tasks/119-data-classification-and-purge.md,
 * docs/tasks/347-def-437-cutover-purge-assets.md.
 *
 * Empties the pilot's operational data on 1 January 2027, leaving configuration intact, so
 * the books open on one balance-sheet entry of counted present-day facts (bible row 106).
 *
 * This runs ONCE, on a day when everyone is busy, against a database that cannot be
 * un-purged without a restore. Every affordance here exists for that reason:
 *
 *   - **dry-run is the DEFAULT.** Deleting requires an explicit flag.
 *   - **The database name must be typed back.** Ceremony is what separates a rehearsal from
 *     an accident.
 *   - **One transaction**, with post-conditions asserted INSIDE it — a violated expectation
 *     rolls the whole thing back rather than leaving a half-purged database.
 *   - **FK order is DERIVED from the live constraint graph**, not hand-listed. A hand-list
 *     rots exactly like the classification would.
 *   - **Never TRUNCATE ... CASCADE.** Cascade follows foreign keys into tables the operator
 *     never named, which is precisely the accident this design prevents.
 *
 * T-347 (DEF-437) moved the actual engine (TRUNCATE, the FK drop/re-add procedure, the shell
 * step, post-conditions) into `packages/db/src/cutover/purge.ts`'s `planPurge`/`applyPurge`, so
 * the test suite runs the SAME code the operator runs. This file is argument parsing, ceremony
 * and the report only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

import { CUTOVER_CLASSIFICATION, type CutoverEntry } from '../packages/db/src/cutover/classification';
import { planPurge, applyPurge, type PurgePlan } from '../packages/db/src/cutover/purge';
import { RefusalError } from '../packages/db/src/refusal';

interface Args {
  confirmDatabase: string | null;
  apply: boolean;
  rehearse: boolean;
  allowNonLocal: boolean;
  asOf: string;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    confirmDatabase: null,
    apply: false,
    rehearse: false,
    allowNonLocal: false,
    asOf: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--confirm-database') a.confirmDatabase = argv[++i] ?? null;
    else if (argv[i] === '--apply') a.apply = true;
    else if (argv[i] === '--rehearse') a.rehearse = true;
    else if (argv[i] === '--yes-really-not-local') a.allowNonLocal = true;
    else if (argv[i] === '--as-of') a.asOf = argv[++i] ?? a.asOf;
  }
  return a;
}

function usage(): void {
  console.log(`
Usage:
  npm run cutover:purge -- --confirm-database <name> [--apply | --rehearse] [--as-of YYYY-MM-DD]

  Without --apply or --rehearse this is a DRY RUN: it reports what it would change and changes
  nothing.
  --confirm-database must match the database you are actually connected to.
  --yes-really-not-local is additionally required if the host is not localhost.
  --rehearse runs the full purge in a transaction and ALWAYS rolls back, reporting pass or the
  exact error — meant for a restored copy of production (ADR-007 §5), never a live database.
  --rehearse and --apply cannot be combined.

  Reads its classification from packages/db/src/cutover/classification.ts. A table with no
  classification is a build failure, not a silent skip — see tests/unit/cutover-classification.test.ts.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.confirmDatabase) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (args.rehearse && args.apply) {
    console.error('REFUSED. --rehearse always rolls back; it cannot be combined with --apply.');
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  const host = new URL(url).hostname;

  if (args.confirmDatabase !== dbName) {
    console.error(
      `REFUSED. You typed "${args.confirmDatabase}" but this connection is to "${dbName}".\n` +
        'Typing the database name back is the ceremony that separates a rehearsal from an accident.',
    );
    process.exitCode = 1;
    return;
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (!isLocal && !args.allowNonLocal) {
    console.error(
      `REFUSED. "${host}" is not localhost. If you genuinely mean to run this against a remote ` +
        'database, pass --yes-really-not-local as well. Two deliberate acts, not one.',
    );
    process.exitCode = 1;
    return;
  }

  const sql = postgres(url, { max: 1 });
  const lines: string[] = [];
  const say = (s: string): void => {
    console.log(s);
    lines.push(s);
  };

  try {
    const mode = args.rehearse ? 'REHEARSE' : args.apply ? 'APPLY' : 'DRY RUN';
    say(`# Cutover purge — ${mode}`);
    say('');
    say(`Database: \`${dbName}\` on \`${host}\` · as-of ${args.asOf}`);
    say('');

    const blocked: string[] = [];
    for (const [table, entry] of Object.entries(CUTOVER_CLASSIFICATION)) {
      const nb = (entry as { notBefore?: string }).notBefore;
      if (nb && args.asOf < nb) blocked.push(`${table} (not before ${nb})`);
    }
    if (blocked.length > 0) {
      say('**Deferred by `notBefore`** — these are the evidence behind the opening balance (ADR-007 §6):');
      say('');
      for (const b of blocked) say(`- ${b}`);
      say('');
    }

    const plan = await planPurge(sql, args.asOf);
    printPlan(say, plan);

    if (!args.apply && !args.rehearse) {
      say('**DRY RUN — nothing was changed.** Re-run with `--apply` to purge, or `--rehearse` to try it and roll back.');
      return;
    }

    const REHEARSAL_ROLLBACK = Symbol('rehearsal rollback');
    try {
      await sql.begin(async (tx) => {
        const txPlan = await planPurge(tx, args.asOf);
        await applyPurge(tx, txPlan);
        if (args.rehearse) throw REHEARSAL_ROLLBACK;
      });
    } catch (err) {
      if (err !== REHEARSAL_ROLLBACK) throw err;
    }

    say('');
    say('## Result');
    say('');
    say(
      args.rehearse
        ? '✅ **Rehearsal passed.** Every step committed inside the transaction, then rolled back — nothing was kept.'
        : '✅ **Purge committed.** All post-conditions passed inside the transaction.',
    );
  } finally {
    const reportDir = process.env.CUTOVER_PURGE_REPORT_DIR ?? join(process.cwd(), 'docs', 'reviews');
    const out = join(reportDir, `cutover-purge-${args.asOf}.md`);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log(`\nReport written: ${out}`);
    await sql.end({ timeout: 5 });
  }
}

/** The dry-run plan table, every kept-child → purged-parent FK (Amendment R1.1), and each
 *  shell/date-scoped table's shape — printed identically whether this run is a dry run, a
 *  rehearsal or an apply, so the operator sees the same plan they are about to commit to. */
function printPlan(say: (s: string) => void, plan: PurgePlan): void {
  say('## Plan');
  say('');
  say('| Table | Class | Rows now | After |');
  say('|---|---|---:|---:|');
  for (const t of plan.purgeOrder) say(`| \`${t}\` | purge | ${plan.purgeRowsNow.get(t)} | 0 |`);
  for (const p of plan.datePlans) {
    say(`| \`${p.table}\` | date-scoped | ${p.rowsNow} | rows from ${p.entry.keepFrom} |`);
  }
  for (const p of plan.shellPlans) {
    const dropped = p.droppedCount > 0 ? ` dropped (status=disposed): ${p.droppedCount},` : '';
    say(`| \`${p.table}\` | keep-shell | ${p.rowsNow} |${dropped} ${p.rowsNow - p.droppedCount} (columns cleared) |`);
  }
  for (const t of plan.keepTables) {
    say(`| \`${t}\` | keep | unchanged | unchanged |`);
  }
  say('');
  say(`Purge order (derived from the live FK graph): ${plan.purgeOrder.map((t) => `\`${t}\``).join(' → ')}`);
  say('');

  if (plan.foreignKeys.length > 0) {
    say('**Kept-child → purged-parent foreign keys** (Amendment R1.1) — dropped before TRUNCATE, re-added validated after the shell step clears the column:');
    say('');
    for (const fk of plan.foreignKeys) {
      say(`- \`${fk.childTable}.${fk.childColumns.join(', ')} → ${fk.parentTable}\``);
    }
    say('');
  }
}

main().catch((e: unknown) => {
  // ⭐ A RefusalError's `.message` is the raw diagnostic (for logs/tests); `.userMessage` is the
  // sanitised sentence an operator should actually read. Print the one meant for them.
  console.error(e instanceof RefusalError ? e.userMessage : e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
