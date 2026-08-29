/**
 * `npm run cutover:purge` — ADR-007, docs/tasks/119-data-classification-and-purge.md.
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
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

import {
  CUTOVER_CLASSIFICATION,
  tablesInClass,
  type CutoverEntry,
} from '../packages/db/src/cutover/classification';

interface Args {
  confirmDatabase: string | null;
  apply: boolean;
  allowNonLocal: boolean;
  asOf: string;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { confirmDatabase: null, apply: false, allowNonLocal: false, asOf: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--confirm-database') a.confirmDatabase = argv[++i] ?? null;
    else if (argv[i] === '--apply') a.apply = true;
    else if (argv[i] === '--yes-really-not-local') a.allowNonLocal = true;
    else if (argv[i] === '--as-of') a.asOf = argv[++i] ?? a.asOf;
  }
  return a;
}

function usage(): void {
  console.log(`
Usage:
  npm run cutover:purge -- --confirm-database <name> [--apply] [--as-of YYYY-MM-DD]

  Without --apply this is a DRY RUN: it reports what it would delete and changes nothing.
  --confirm-database must match the database you are actually connected to.
  --yes-really-not-local is additionally required if the host is not localhost.

  Reads its classification from packages/db/src/cutover/classification.ts. A table with no
  classification is a build failure, not a silent skip — see tests/unit/cutover-classification.test.ts.
`);
}

/** Topologically order the purge set so children are deleted before parents. */
async function derivePurgeOrder(sql: postgres.Sql, tables: readonly string[]): Promise<string[]> {
  const set = new Set(tables);
  const edges = await sql<{ child: string; parent: string }[]>`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c
    where c.contype = 'f'
  `;
  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const e of edges) {
    // Only edges INSIDE the purge set matter; a FK to a keep-class table (e.g. accounts) is
    // irrelevant because that parent is never deleted.
    if (set.has(e.child) && set.has(e.parent) && e.child !== e.parent) {
      deps.get(e.parent)!.add(e.child); // parent must wait for child
    }
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, trail: Set<string>): void => {
    if (seen.has(t)) return;
    if (trail.has(t)) {
      // A genuine FK cycle. Refuse rather than guess an order — a wrong order fails loudly
      // at the FK anyway, but guessing here would hide which cycle caused it.
      throw new Error(`Foreign-key cycle involving ${t}; purge order cannot be derived automatically.`);
    }
    trail.add(t);
    for (const child of deps.get(t) ?? []) visit(child, trail);
    trail.delete(t);
    seen.add(t);
    ordered.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return ordered;
}

async function countRows(sql: postgres.Sql, table: string): Promise<number> {
  const [row] = await sql<{ c: number }[]>`select count(*)::int c from ${sql(table)}`;
  return row?.c ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.confirmDatabase) {
    usage();
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
      `REFUSED. "${host}" is not localhost. If you genuinely mean to purge a remote database, ` +
        'pass --yes-really-not-local as well. Two deliberate acts, not one.',
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
    say(`# Cutover purge — ${args.apply ? 'APPLY' : 'DRY RUN'}`);
    say('');
    say(`Database: \`${dbName}\` on \`${host}\` · as-of ${args.asOf}`);
    say('');

    // ---- notBefore: the ETL tables are evidence and must survive 1 January ---------------
    const blocked: string[] = [];
    for (const [table, entry] of Object.entries(CUTOVER_CLASSIFICATION)) {
      const nb = (entry as { notBefore?: string }).notBefore;
      if (nb && args.asOf < nb) blocked.push(`${table} (not before ${nb})`);
    }
    if (blocked.length > 0) {
      say(`**Deferred by \`notBefore\`** — these are the evidence behind the opening balance (ADR-007 §6):`);
      say('');
      for (const b of blocked) say(`- ${b}`);
      say('');
    }

    const purgeTables = tablesInClass('purge').filter((t) => {
      const nb = (CUTOVER_CLASSIFICATION[t] as { notBefore?: string }).notBefore;
      return !nb || args.asOf >= nb;
    });
    const keepTables = tablesInClass('keep');
    const shellTables = tablesInClass('keep_shell');
    const dateTables = tablesInClass('date_scoped');

    const order = await derivePurgeOrder(sql, purgeTables);

    // ---- before ------------------------------------------------------------------------
    const before = new Map<string, number>();
    for (const t of [...purgeTables, ...keepTables, ...shellTables, ...dateTables]) {
      before.set(t, await countRows(sql, t));
    }

    say('## Plan');
    say('');
    say('| Table | Class | Rows now | After |');
    say('|---|---|---:|---:|');
    for (const t of order) say(`| \`${t}\` | purge | ${before.get(t)} | 0 |`);
    for (const t of dateTables) {
      const e = CUTOVER_CLASSIFICATION[t] as Extract<CutoverEntry, { class: 'date_scoped' }>;
      say(`| \`${t}\` | date-scoped | ${before.get(t)} | rows from ${e.keepFrom} |`);
    }
    for (const t of shellTables) say(`| \`${t}\` | keep-shell | ${before.get(t)} | ${before.get(t)} (columns cleared) |`);
    for (const t of keepTables) say(`| \`${t}\` | keep | ${before.get(t)} | ${before.get(t)} |`);
    say('');
    say(`Purge order (derived from the live FK graph): ${order.map((t) => `\`${t}\``).join(' → ')}`);
    say('');

    if (!args.apply) {
      say('**DRY RUN — nothing was changed.** Re-run with `--apply` to purge.');
      return;
    }

    // ---- apply, in ONE transaction with post-conditions inside it -----------------------
    await sql.begin(async (tx) => {
      // ⛔ TRUNCATE, not DELETE — DEF-079. `journal_entries` carries a BEFORE DELETE trigger that
      // raises on any POSTED row ("posted journal entry % cannot be deleted", bible invariant 5),
      // so a DELETE here fails on the first real ledger row and rolls the whole purge back. This
      // script could never have run against real data, and nothing caught it because no test ever
      // ran the purge against a POSTED ledger.
      //
      // ⭐ TRUNCATE does not fire row-level DELETE triggers. That is DEFINED behaviour, not a
      // loophole: the invariant stays fully armed for every ordinary write path, and the one
      // operation allowed to empty the ledger can do so. Chosen over a GUC exemption inside the
      // trigger (a flag a code path can forget to unset) and over session_replication_role =
      // 'replica' (which disables FK enforcement too — far more than this needs).
      //
      // ⚠️ Safe because EVERY table referencing the ledger is itself purge-class, verified against
      // pg_constraint: ap_payments, ar_charges, ar_collections, ar_write_offs, channel_settlements,
      // expenses, money_transfers, sales_days, trade_orders. No kept row can be orphaned.
      //
      // One statement, so the FK graph is satisfied simultaneously rather than in an order that
      // has to be right. TRUNCATE is transactional, so the post-conditions below still guard it.
      if (order.length > 0) {
        await tx.unsafe(`truncate table ${order.map((t) => `"${t}"`).join(', ')}`);
      }

      for (const t of dateTables) {
        const e = CUTOVER_CLASSIFICATION[t] as Extract<CutoverEntry, { class: 'date_scoped' }>;
        await tx`delete from ${tx(t)} where ${tx(e.dateColumn)} < ${e.keepFrom}`;
      }

      for (const t of shellTables) {
        const e = CUTOVER_CLASSIFICATION[t] as Extract<CutoverEntry, { class: 'keep_shell' }>;
        for (const col of e.clearColumns) {
          await tx`update ${tx(t)} set ${tx(col)} = null`;
        }
      }

      // ---- post-conditions. Asserted, never eyeballed. A violation rolls everything back.
      const problems: string[] = [];

      for (const t of order) {
        const [r] = await tx<{ c: number }[]>`select count(*)::int c from ${tx(t)}`;
        if ((r?.c ?? -1) !== 0) problems.push(`${t} still has ${r?.c} row(s)`);
      }

      for (const t of keepTables) {
        const [r] = await tx<{ c: number }[]>`select count(*)::int c from ${tx(t)}`;
        if ((r?.c ?? -1) !== before.get(t)) {
          problems.push(`${t} changed from ${before.get(t)} to ${r?.c} — a KEEP table must be untouched`);
        }
      }

      for (const t of shellTables) {
        const [r] = await tx<{ c: number }[]>`select count(*)::int c from ${tx(t)}`;
        if ((r?.c ?? -1) !== before.get(t)) problems.push(`${t} lost rows — keep_shell keeps the row`);
      }

      // The chart of accounts must survive byte-identical: the opening entry references
      // these ids, and a re-seed that changed one would be catastrophic and silent.
      const [acc] = await tx<{ c: number }[]>`select count(*)::int c from accounts`;
      if ((acc?.c ?? -1) !== before.get('accounts')) {
        problems.push(`accounts changed from ${before.get('accounts')} to ${acc?.c} — the opening entry references these ids`);
      }

      // With the books empty, the trial balance ties at zero.
      const [tb] = await tx<{ d: string; c: string }[]>`
        select coalesce(sum(debit),0)::text d, coalesce(sum(credit),0)::text c from journal_lines
      `;
      if (Number(tb?.d ?? 0) !== 0 || Number(tb?.c ?? 0) !== 0) {
        problems.push(`journal_lines is not empty — debits ${tb?.d}, credits ${tb?.c}`);
      }

      if (problems.length > 0) {
        throw new Error(
          'POST-CONDITION FAILED — rolling back, the database is unchanged:\n  ' + problems.join('\n  '),
        );
      }
    });

    // Sequences restart so 2027 document numbers begin at 1. A 2027 receipt numbered 4,812
    // invites the question "where are the first 4,811?"
    const seqs = await sql<{ seq: string }[]>`
      select sequencename as seq from pg_sequences where schemaname = 'public'
    `;
    for (const s of seqs) await sql`alter sequence ${sql(s.seq)} restart with 1`;
    say(`Reset ${seqs.length} sequence(s) to 1.`);
    say('');
    say('## Result');
    say('');
    say('✅ **Purge committed.** All post-conditions passed inside the transaction.');
  } finally {
    const out = join(process.cwd(), 'docs', 'reviews', `cutover-purge-${args.asOf}.md`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log(`\nReport written: ${out}`);
    await sql.end({ timeout: 5 });
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
