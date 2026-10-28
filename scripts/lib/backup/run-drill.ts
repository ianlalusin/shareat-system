/**
 * T-393 R8-R10, R13, I6, I7 — the weekly restore drill.
 *
 *   heartbeat start -> target guards (name pattern, never the source's name; NO connection yet) ->
 *   newest COMPLETE dump (manifest present) -> free-disk check -> download + sha256 check ->
 *   drop/create scratch database -> pg_restore --no-owner --no-acl --exit-on-error --single-transaction ->
 *   log pg_database_size -> tie check + sequence check -> report to postgres/drills/<date>.json ->
 *   drop the scratch database (always) -> heartbeat ok / fail.
 *
 * `sourceUrl` is only PARSED (to compare database names); the drill never connects to it.
 * A failed check resolves `{ ok: false, mismatches }`; an operational failure rejects. Both ping the heartbeat fail.
 */
import { statfsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { compareFingerprints, computeFingerprint, type Fingerprint } from './fingerprint';
import type { Heartbeat } from './heartbeat';
import { BACKUP_PREFIX, type ObjectStore } from './object-store';
import { buildPgArgs, redact, resolvePgBin, runTool, secretsOf } from './pg-tools';
import { manilaDate, readManifestFile, sha256OfFile } from './run-backup';

/** R10: the only databases the drill may create or drop. */
export const DRILL_DB_RE = /^shareat_(restore_drill|test_drill_[a-z0-9]+)$/;

export interface DrillDeps {
  store: ObjectStore;
  /** Connection string of the scratch database (its pathname is the scratch name). */
  targetUrl: string;
  /** The database the drill connects to for CREATE/DROP (`defaultdb` on DO, `postgres` locally). */
  maintenanceDb: string;
  /** Parsed for its database name only. Never connected to. */
  sourceUrl: string;
  heartbeat: Heartbeat;
  tmpDir: string;
  now?: () => Date;
  /** Tests only. */
  hooks?: { afterRestore?: (db: string) => Promise<void>; checkUrl?: (db: string) => string };
}

export interface DrillResult {
  ok: boolean;
  dumpKey: string | null;
  reportKey: string | null;
  mismatches: string[];
  restoredBytes: number | null;
  durations: { downloadMs: number; restoreMs: number; checkMs: number };
  /** Set when the run failed for a reason other than a data mismatch (DEF-795: the report could not be saved). */
  error?: string;
}

/** DEF-795: the drill report is a required output (T-393 R8/R14); the exit code follows `ok`. */
export const drillExitCode = (r: Pick<DrillResult, 'ok'>): number => (r.ok ? 0 : 1);

const log = (s: string) => console.log(`[restore-drill] ${s}`);
const dbNameOf = (url: string): string => decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** R10, pure: throws before anything is opened. */
export function assertDrillTarget(targetUrl: string, sourceUrl: string, maintenanceDb: string): string {
  const target = dbNameOf(targetUrl);
  if (!DRILL_DB_RE.test(target)) {
    throw new Error(`refusing: target database "${target}" does not match ${String(DRILL_DB_RE)} (R10)`);
  }
  const source = dbNameOf(sourceUrl);
  if (target === source) throw new Error(`refusing: target database "${target}" has the same name as the source database (R10)`);
  if (maintenanceDb === source || maintenanceDb === target) {
    throw new Error(`refusing: the maintenance database "${maintenanceDb}" must be neither the source nor the target (R10)`);
  }
  return target;
}

class RefusedError extends Error {}

export async function runDrill(deps: DrillDeps): Promise<DrillResult> {
  const { store, targetUrl, maintenanceDb, sourceUrl, heartbeat, tmpDir } = deps;
  const secrets = [...secretsOf(targetUrl), ...secretsOf(sourceUrl)];
  const clean = (s: string) => redact(s, secrets);
  const safeBeat = async (what: 'start' | 'ok' | 'fail', reason?: string) => {
    try {
      if (what === 'fail') await heartbeat.fail(reason ?? 'failed');
      else await heartbeat[what]();
    } catch (e) {
      log(clean(`heartbeat ${what} not delivered: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  const now = (deps.now ?? (() => new Date()))();
  const date = manilaDate(now);
  const reportKey = `${BACKUP_PREFIX}drills/${date}.json`;
  const durations = { downloadMs: 0, restoreMs: 0, checkMs: 0 };
  const files: string[] = [];
  let dumpKey: string | null = null;
  let restoredBytes: number | null = null;
  let created: string | null = null;
  let target = '';
  let maint: postgres.Sql | undefined;
  let refusedUpFront = false;

  await safeBeat('start');
  /** Resolves to the failure reason, or null when the report was saved (DEF-795: a failed save fails the run). */
  const writeReport = async (ok: boolean, mismatches: string[], error?: string): Promise<string | null> => {
    try {
      const local = path.join(tmpDir, `drill-report-${date}.json`);
      files.push(local);
      const body = clean(JSON.stringify({ ok, date, dumpKey, restoredBytes, durations, mismatches, ...(error ? { error } : {}) }, null, 2));
      await writeFile(local, body);
      await store.put(reportKey, local, {});
      return null;
    } catch (e) {
      const why = clean(e instanceof Error ? e.message : String(e));
      log(`report not written: ${why}`);
      return why;
    }
  };
  const dropScratch = async (): Promise<void> => {
    if (created === null || !DRILL_DB_RE.test(created) || !maint) return;
    const name = created;
    await maint.unsafe(`drop database if exists ${q(name)} with (force)`);
    created = null;
  };
  // A killed run (systemd stop, Ctrl-C) must not leave the scratch database behind.
  const onSignal = (sig: NodeJS.Signals) => {
    log(`${sig} received: dropping the scratch database`);
    void dropScratch()
      .catch(() => {})
      .finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  let result: DrillResult | undefined;
  let failure: Error | undefined;
  try {
    target = assertDrillTarget(targetUrl, sourceUrl, maintenanceDb); // before ANY connection
    await mkdir(tmpDir, { recursive: true });

    // Overlap guard, up front: one drill per target at a time, held on the maintenance connection for the whole run.
    const mu = new URL(targetUrl);
    mu.pathname = `/${maintenanceDb}`;
    maint = postgres(mu.toString(), { max: 1, onnotice: () => {}, connect_timeout: 30 });
    const [lock] = await maint<{ got: boolean }[]>`select pg_try_advisory_lock(hashtext(${`shareat-restore-drill:${target}`})) as got`;
    if (!lock?.got) {
      refusedUpFront = true;
      throw new RefusedError(`refusing: another restore drill is already running against ${target} (advisory lock held); nothing was touched`);
    }

    // Newest COMPLETE dump: a manifest exists (it is uploaded last) and its dump is in the store.
    const all = await store.list(`${BACKUP_PREFIX}daily/`);
    const keys = new Set(all.map((o) => o.key));
    const manifests = all
      .map((o) => o.key)
      .filter((k) => k.endsWith('.manifest.json') && keys.has(k.replace(/\.manifest\.json$/, '.dump')))
      .sort();
    const manifestKey = manifests[manifests.length - 1];
    if (!manifestKey) throw new Error('no complete dump in the store (a dump counts only when its manifest exists)');

    const tDl = Date.now();
    const manifestFile = path.join(tmpDir, 'drill-manifest.json');
    files.push(manifestFile);
    await store.get(manifestKey, manifestFile);
    const manifest = await readManifestFile(manifestFile);
    const wantSha = manifest.sha256;
    const fingerprint = manifest.fingerprint as Partial<Fingerprint> | undefined;
    dumpKey = typeof manifest.dumpKey === 'string' ? manifest.dumpKey : manifestKey.replace(/\.manifest\.json$/, '.dump');
    const missing: string[] = [];
    if (typeof wantSha !== 'string') missing.push('sha256');
    if (!Array.isArray(fingerprint?.trialBalance)) missing.push('trialBalance');
    if (!Array.isArray(fingerprint?.orgTotals)) missing.push('orgTotals');
    if (typeof fingerprint?.rowCounts !== 'object' || fingerprint.rowCounts === null) missing.push('rowCounts');
    if (missing.length > 0) throw new Error(`manifest is incomplete: ${manifestKey} lacks ${missing.join(', ')}`);
    const expectedBytes = manifest.sourceDatabaseBytes;
    if (typeof expectedBytes !== 'number' || !Number.isFinite(expectedBytes) || expectedBytes <= 0) {
      throw new Error(`manifest ${manifestKey} has no sourceDatabaseBytes, so the expected restored size is unknown; refusing`);
    }
    const expectedFingerprint = fingerprint as Fingerprint;

    // R6: free-disk pre-check (the restore itself runs on the cluster, so only the dump lands here).
    const need = Number(manifest.size ?? 0) * 1.5;
    const fs = statfsSync(tmpDir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < need) throw new Error(`not enough free disk in ${tmpDir}: ${Math.floor(free)} bytes free, ${Math.ceil(need)} needed (1.5 x dump size)`);

    const dumpFile = path.join(tmpDir, 'drill.dump');
    files.push(dumpFile);
    await store.get(dumpKey, dumpFile);
    const gotSha = await sha256OfFile(dumpFile);
    durations.downloadMs = Date.now() - tDl;
    if (gotSha !== wantSha) {
      throw new Error(`sha256 mismatch for ${dumpKey}: stored ${gotSha.slice(0, 12)}..., manifest ${String(wantSha).slice(0, 12)}...; not restoring`);
    }
    log(`dump ${dumpKey} verified (sha256 ${gotSha.slice(0, 12)}), download ${durations.downloadMs} ms`);
    log(`expected restored size ${expectedBytes} bytes (manifest sourceDatabaseBytes); restoring into ${target}`);

    // Scratch database: the only CREATE/DROP, both guarded by DRILL_DB_RE above.
    await maint.unsafe(`drop database if exists ${q(target)} with (force)`);
    await maint.unsafe(`create database ${q(target)}`);
    created = target;

    const tRs = Date.now();
    const { argv, env } = buildPgArgs(targetUrl, ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', dumpFile]);
    const r = await runTool(resolvePgBin('pg_restore'), argv, env);
    durations.restoreMs = Date.now() - tRs;
    if (r.code !== 0) throw new Error(`pg_restore exited ${String(r.code)}: ${r.stderr.trim().slice(0, 500)}`);

    const admin = postgres(targetUrl, { max: 1, onnotice: () => {}, connect_timeout: 30 });
    const mismatches: string[] = [];
    try {
      const [sz] = await admin<{ bytes: string }[]>`select pg_database_size(current_database())::text as bytes`;
      restoredBytes = Number(sz?.bytes ?? 0);
      log(`restored in ${durations.restoreMs} ms; pg_database_size ${restoredBytes} bytes (expected about ${expectedBytes})`);

      await deps.hooks?.afterRestore?.(target);

      const tCk = Date.now();
      // Tie check (R9): exact, and empty is a failure. Through checkUrl when a test needs a different role.
      const checkUrl = deps.hooks?.checkUrl?.(target) ?? targetUrl;
      const checker = checkUrl === targetUrl ? admin : postgres(checkUrl, { max: 1, onnotice: () => {}, connect_timeout: 30 });
      try {
        const restored = await computeFingerprint(checker);
        mismatches.push(...compareFingerprints(expectedFingerprint, restored).mismatches);
      } catch (e) {
        mismatches.push(`tie check could not read the restored database (empty is not a tie): ${clean(e instanceof Error ? e.message : String(e))}`);
      } finally {
        if (checker !== admin) await checker.end({ timeout: 5 }).catch(() => {});
      }
      mismatches.push(...(await sequenceMismatches(admin)));
      durations.checkMs = Date.now() - tCk;
    } finally {
      await admin.end({ timeout: 5 }).catch(() => {});
    }
    result = { ok: mismatches.length === 0, dumpKey, reportKey: null, mismatches: mismatches.map(clean), restoredBytes, durations };
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  }

  // Cleanup. A scratch database that cannot be dropped is a FAILED run, never an ok with a warning.
  try {
    await dropScratch();
  } catch (e) {
    const msg = clean(`could not drop scratch database ${created ?? target}: ${e instanceof Error ? e.message : String(e)}`);
    log(`ERROR: ${msg}`);
    if (result) result = { ...result, ok: false, mismatches: [...result.mismatches, msg] };
    else failure = new Error(`${failure ? `${clean(failure.message)}; ` : ''}${msg}`);
  }
  if (maint) await maint.end({ timeout: 5 }).catch(() => {}); // releases the advisory lock
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);

  return settleDrill({ result, failure, target, refusedUpFront, reportKey, dumpKey, durations, files, writeReport, safeBeat, clean, log });
}

export interface SettleInput {
  result: DrillResult | undefined;
  failure: Error | undefined;
  target: string;
  refusedUpFront: boolean;
  reportKey: string;
  dumpKey: string | null;
  durations: DrillResult['durations'];
  files: string[];
  /** Resolves to the failure reason, or null when the report was saved. */
  writeReport: (ok: boolean, mismatches: string[], error?: string) => Promise<string | null>;
  safeBeat: (what: 'start' | 'ok' | 'fail', reason?: string) => Promise<void>;
  clean: (s: string) => string;
  log: (s: string) => void;
}

/**
 * DEF-795: save the required report, then signal. A report that cannot be saved FAILS the run (`ok:false`, failure
 * heartbeat, reason in `error`), while the data-check outcome (`mismatches`, timings) is kept. Heartbeat delivery
 * stays best-effort (`safeBeat`). Exported so the unit tests need no Postgres.
 */
export async function settleDrill(i: SettleInput): Promise<DrillResult> {
  const { result, failure, clean, log, safeBeat } = i;
  try {
    if (result) {
      const reportError = await i.writeReport(result.ok, result.mismatches);
      if (reportError === null) result.reportKey = i.reportKey;
      else {
        result.reportKey = null;
        result.ok = false;
        result.error = clean(`${result.mismatches.length === 0 ? 'restore checks passed but the' : 'restore check failed and the'} drill report could not be saved: ${reportError}`);
      }
      if (result.ok) {
        log(`ok: ${i.dumpKey} restored and ties; download ${i.durations.downloadMs} ms, restore ${i.durations.restoreMs} ms, check ${i.durations.checkMs} ms`);
        await safeBeat('ok');
      } else {
        const m = result.mismatches;
        const checkMsg = m.length > 0 ? clean(`restore check failed: ${m.slice(0, 5).join('; ')}${m.length > 5 ? ` (+${m.length - 5} more)` : ''}`) : '';
        const msg = reportError === null ? checkMsg : m.length > 0 ? `${checkMsg}; ${result.error}` : (result.error as string);
        log(`FAILED: ${msg}`);
        await safeBeat('fail', msg);
      }
      return result;
    }
    const msg = clean(failure?.message ?? 'unknown failure');
    log(`FAILED: ${msg}`);
    // Not for a refused target or a refused overlap: nothing ran, and the other run owns today's report.
    const reportError = i.target !== '' && !i.refusedUpFront ? await i.writeReport(false, [], msg) : null;
    const full = reportError === null ? msg : `${msg}; the drill report could not be saved: ${reportError}`;
    await safeBeat('fail', full);
    throw new Error(full);
  } finally {
    for (const f of i.files) await rm(f, { force: true }).catch(() => {});
  }
}

/** R8: every sequence owned by a column in public/drizzle must be at or beyond max() of that column (>=, not ==). */
export async function sequenceMismatches(sql: postgres.Sql): Promise<string[]> {
  const owned = await sql<{ ss: string; sn: string; ts: string; tn: string; col: string }[]>`
    select sn.nspname as ss, s.relname as sn, tn.nspname as ts, t.relname as tn, a.attname as col
    from pg_class s
    join pg_namespace sn on sn.oid = s.relnamespace
    join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass
                    and d.deptype in ('a', 'i')
    join pg_class t on t.oid = d.refobjid
    join pg_namespace tn on tn.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where s.relkind = 'S' and tn.nspname in ('public', 'drizzle')
    order by 1, 2`;
  const bad: string[] = [];
  for (const o of owned) {
    const [seq] = await sql.unsafe<{ last: string; called: boolean }[]>(
      `select last_value::text as last, is_called as called from ${q(o.ss)}.${q(o.sn)}`,
    );
    const [mx] = await sql.unsafe<{ m: string | null }[]>(`select max(${q(o.col)})::text as m from ${q(o.ts)}.${q(o.tn)}`);
    if (!seq || mx?.m == null) continue;
    const handedOut = BigInt(seq.last) - (seq.called ? 0n : 1n); // highest value already issued
    if (handedOut < BigInt(mx.m)) {
      bad.push(`sequence ${o.ss}.${o.sn}: last_value ${seq.last} is below max(${o.tn}.${o.col}) ${mx.m}`);
    }
  }
  return bad;
}
