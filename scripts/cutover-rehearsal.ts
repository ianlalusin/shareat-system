/**
 * `npm run cutover:rehearse` - T-394 S1: the opening rehearsal on a restored COPY of production.
 * docs/tasks/394-purge-and-opening-rehearsal.md s5.1.
 *
 *   start | migrate | predump | purge --by <personId> | mark <step> start|end [--by] | app-env-check --env-file <path> |
 *   rollback-check --against <ENV_NAME>        (verify / report arrive with S2)
 *
 * Every subcommand except app-env-check re-runs the target guards (R3) BEFORE the first write; `start` and `purge` also require that
 * no other session is connected. The tool has no purge SQL: `purge` runs the real scripts/cutover-purge.ts three times.
 * Exit codes: 0 pass, 1 a check failed (named), 2 refused by a guard. Nothing printed here carries a connection string.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

import { computeFingerprint, type Fingerprint } from './lib/backup/fingerprint';
import { checkAppEnvText } from './lib/rehearsal/app-env';
import {
  checkBypassRls,
  checkFiscalCoverage,
  checkLiveness,
  checkPostPurge,
  checkRollback,
  snapshotStart,
} from './lib/rehearsal/checks';
import { KEEP_FROM, realSpawn, runMigrateChild, runPredumpChild, runPurgeChildren, type ChildrenResult } from './lib/rehearsal/children';
import { checkTargetGuards, databaseRefusals, resolveTargetUrl } from './lib/rehearsal/guards';
import {
  durationOf,
  markEnd,
  markStart,
  newJournal,
  newestManifest,
  readJournal,
  rehearsalDir,
  writeJournal,
  type Journal,
} from './lib/rehearsal/journal';

const env = process.env;

class Exit extends Error {
  constructor(
    readonly code: 0 | 1 | 2,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (m: string): never => {
  throw new Exit(2, `REFUSED. ${m}`);
};
const fail = (m: string): never => {
  throw new Exit(1, `FAILED. ${m}`);
};

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Guards (a)-(d). Returns the target URL and database name, or throws Exit(2). */
function targetOf(argv: string[]): { url: string; database: string } {
  const url = resolveTargetUrl(env);
  const g = checkTargetGuards({ url, confirmDatabase: flagValue(argv, '--confirm-database'), env });
  if (!g.ok || !url || !g.database) return refuse(g.refusals.join('; '));
  return { url, database: g.database };
}

/** Guard (f): connect to the target and require a bypass-RLS role. */
async function connect(url: string): Promise<postgres.Sql> {
  const sql = postgres(url, { max: 1, onnotice: () => {}, connection: { application_name: 'cutover-rehearsal' } });
  try {
    const f = await checkBypassRls(sql);
    if (!f.ok) {
      await sql.end({ timeout: 5 });
      return refuse(f.message);
    }
  } catch (e) {
    await sql.end({ timeout: 5 }).catch(() => {});
    if (e instanceof Exit) throw e;
    return fail(`could not connect to the target: ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>') : 'error'}`);
  }
  return sql;
}

function childVerdict(r: ChildrenResult, what: string): void {
  if (r.code === 2) refuse(r.message ?? what);
  if (!r.ok) fail(`${what}: ${r.message ?? 'child failed'}`);
}

function requireJournal(dir: string, database: string): Journal {
  const j = readJournal(dir, database);
  if (!j || !j.start) return fail(`no journal for ${database}: run "start" first`);
  return j;
}

async function runTimed(dir: string, database: string, code: string, body: () => Promise<void>): Promise<void> {
  const j = readJournal(dir, database) ?? newJournal(database, new Date());
  markStart(j, code, new Date());
  writeJournal(dir, j);
  let result = 'pass';
  try {
    await body();
  } catch (e) {
    result = e instanceof Exit && e.code === 2 ? 'refused' : 'fail';
    throw e;
  } finally {
    const j2 = readJournal(dir, database) ?? j;
    markEnd(j2, code, new Date(), result);
    writeJournal(dir, j2);
  }
}

async function main(argv: string[]): Promise<void> {
  const sub = argv[0];
  const say = (s: string): void => console.log(s);

  if (sub === 'app-env-check') {
    const file = flagValue(argv, '--env-file');
    if (!file) return fail('app-env-check needs --env-file <path>');
    const r = checkAppEnvText(readFileSync(file, 'utf8'));
    if (!r.ok) return refuse(`the app env sets variables that could write the edge or the POS: ${r.offending.join(', ')}`);
    say('app-env-check: pass (Firebase for sign-in only)');
    return;
  }
  if (!['start', 'migrate', 'predump', 'purge', 'mark', 'rollback-check'].includes(sub ?? '')) {
    return fail('usage: cutover-rehearsal <start|migrate|predump|purge --by <id>|mark <step> start|end|app-env-check --env-file <p>|rollback-check --against <ENV>> --confirm-database <db>');
  }

  const { url, database } = targetOf(argv);
  let dir: string;
  try {
    dir = rehearsalDir(env);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'bad REHEARSAL_DIR');
  }

  if (sub === 'start') {
    const sql = await connect(url);
    try {
      const live = await checkLiveness(sql);
      if (!live.ok) return refuse(live.message);
      const runAt = new Date();
      const cov = await checkFiscalCoverage(sql, { runAt, conversionDate: KEEP_FROM });
      const snapshot = await snapshotStart(sql);
      let migrationCount: number | null = null;
      try {
        const [m] = await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
        migrationCount = m?.n ?? null;
      } catch {
        migrationCount = null;
      }
      const j = newJournal(database, runAt);
      j.start = { at: runAt.toISOString(), snapshot, migrationCount, coverageOk: cov.ok };
      writeJournal(dir, j);
      say(`start: ${database}; migrations applied ${migrationCount ?? 'unknown'}; kept rows ${JSON.stringify(snapshot.keepCounts)}`);
      if (!cov.ok) {
        for (const f of cov.failures) say(`DEF-585: ${f.reason}`);
        return fail('fiscal-period coverage is missing (DEF-585, R6)');
      }
      say('start: pass (guards, no other session, fiscal periods cover the opening and the seed horizon)');
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }

  if (sub === 'migrate') {
    await (await connect(url)).end({ timeout: 5 });
    await runTimed(dir, database, 'migrate', async () => {
      childVerdict(await runMigrateChild({ env, confirmDatabase: database, spawn: realSpawn }), 'migrate');
    });
    say('migrate: pass');
    return;
  }

  if (sub === 'predump') {
    const sql = await connect(url);
    await sql.end({ timeout: 5 });
    const dumpDir = path.join(dir, `${database}-predump`);
    await runTimed(dir, database, 'predump', async () => {
      childVerdict(await runPredumpChild({ env, confirmDatabase: database, dir: dumpDir, spawn: realSpawn }), 'predump');
    });
    const manifestPath = newestManifest(dumpDir);
    if (!manifestPath) return fail('predump left no manifest');
    const j = readJournal(dir, database) ?? newJournal(database, new Date());
    j.predump = { dir: dumpDir, manifestPath };
    writeJournal(dir, j);
    say('predump: pass (dump and manifest written)');
    return;
  }

  if (sub === 'purge') {
    const by = flagValue(argv, '--by');
    if (!by) return fail('purge needs --by <personId>');
    const sql = await connect(url);
    try {
      const live0 = await checkLiveness(sql);
      if (!live0.ok) return refuse(live0.message);
      const j0 = requireJournal(dir, database);
      if (j0.start?.coverageOk === false) return refuse('the last start failed the fiscal-period coverage check (DEF-585): fix the periods and run start again');
      const start = (j0.start as NonNullable<Journal['start']>).snapshot;
      await runTimed(dir, database, 'purge', async () => {
        const r = await runPurgeChildren({
          env,
          confirmDatabase: database,
          by,
          reportDir: dir,
          spawn: realSpawn,
          liveness: async () => {
            const l = await checkLiveness(sql);
            return { ok: l.ok, message: l.message };
          },
        });
        childVerdict(r, 'purge');
      });
      const j = readJournal(dir, database) ?? j0;
      j.purgeCommittedAt = new Date().toISOString();
      writeJournal(dir, j);
      const post = await checkPostPurge(sql, start, { conversionDate: KEEP_FROM });
      const noC2 = await sql<{ id: string }[]>`
        select o.id::text as id from organizations o
        where not exists (select 1 from cutover_steps c where c.org_id = o.id and c.step_code = 'C2')`;
      for (const f of post.failures) say(`post-purge ${f.check}: ${f.detail}`);
      if (noC2.length > 0) say(`post-purge c2_recorded: no C2 row for organisation(s) ${noC2.map((o) => o.id).join(', ')}`);
      if (!post.ok || noC2.length > 0) return fail('post-purge checks failed');
      say('purge: pass (dry run, rehearse, apply; post-conditions hold)');
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }

  if (sub === 'mark') {
    const step = argv[1];
    const phase = argv[2];
    if (!step || step.startsWith('--') || (phase !== 'start' && phase !== 'end')) return fail('usage: mark <step> start|end [--by <personId>]');
    const by = flagValue(argv, '--by');
    const sql = await connect(url);
    try {
      if (by) {
        const [p] = await sql<{ id: string }[]>`select id::text as id from persons where id::text = ${by}`;
        if (!p) return fail('--by is not a person on the copy');
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    const j = readJournal(dir, database) ?? newJournal(database, new Date());
    if (phase === 'start') markStart(j, step, new Date(), by);
    else if (!markEnd(j, step, new Date(), 'done', by)) return fail(`step ${step} has no start mark`);
    writeJournal(dir, j);
    const s = j.steps.find((x) => x.code === step);
    say(`mark ${step} ${phase}: ${s ? String(durationOf(s)) : ''}`);
    return;
  }

  // rollback-check
  const envName = flagValue(argv, '--against');
  const againstUrl = envName ? env[envName] : undefined;
  if (!envName) return fail('rollback-check needs --against <ENV_NAME> (the environment variable that holds the restored database URL)');
  const ref = databaseRefusals(againstUrl, env, '--against', [url]).refusals;
  if (ref.length > 0) return refuse(ref.join('; '));
  const target = await connect(url);
  await target.end({ timeout: 5 });
  const j = requireJournal(dir, database);
  if (!j.predump) return fail('no predump recorded: run "predump" first');
  const manifest = JSON.parse(readFileSync(j.predump.manifestPath, 'utf8')) as { fingerprint: Fingerprint };
  const against = postgres(againstUrl as string, { max: 1, onnotice: () => {} });
  let restored: Fingerprint;
  try {
    restored = await computeFingerprint(against);
  } finally {
    await against.end({ timeout: 5 });
  }
  const r = checkRollback({ manifest: manifest.fingerprint, restored, targetUrl: url, againstUrl, confirmDatabase: database, env });
  if (!r.ok) {
    for (const f of r.failures) say(`rollback-check: ${f}`);
    return fail('the restored predump does not tie to its manifest');
  }
  say('rollback-check: pass (restored fingerprint equals the dump manifest)');
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e: unknown) => {
    if (e instanceof Exit) {
      console.error(e.message);
      process.exit(e.code);
    }
    console.error(`FAILED. ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>') : String(e)}`);
    process.exit(1);
  },
);
