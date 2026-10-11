/**
 * T-393 R1-R3, R6, R7 — the nightly backup. Order is fixed (spec I1):
 *
 *   heartbeat start -> port check -> privilege check -> client version check -> free-disk check ->
 *   snapshot tx + isolation assert -> fingerprint (refuse if empty) -> pg_dump --snapshot -> commit ->
 *   pg_dumpall --roles-only -> pg_restore --list + full read -> streamed sha256 -> put dump + roles ->
 *   head verify -> put manifest (LAST) -> planPrune + delete -> heartbeat ok -> remove temp files.
 *
 * On any throw: heartbeat fail, temp files removed, the (redacted) error rethrown. Nothing is pruned on a failed night.
 * A heartbeat that cannot be delivered never changes the outcome (I8).
 */
import { createHash } from 'node:crypto';
import { createReadStream, statfsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { computeFingerprint, emptyLedgerReason, type Fingerprint } from './fingerprint';
import type { Heartbeat } from './heartbeat';
import { BACKUP_PREFIX, type ObjectStore } from './object-store';
import {
  NULL_DEVICE,
  assertClientMatchesServer,
  assertDirectPort,
  buildPgArgs,
  redact,
  resolvePgBin,
  runTool,
  secretsOf,
  type PgTool,
} from './pg-tools';
import { DAILY_KEY_RE, planPrune } from './retention';

export interface BackupDeps {
  store: ObjectStore;
  sourceUrl: string;
  heartbeat: Heartbeat;
  now: () => Date;
  tmpDir: string;
  /** Tests only. */
  hooks?: { afterFingerprint?: () => Promise<void>; afterDump?: (file: string) => Promise<void> };
}

export interface BackupResult {
  dumpKey: string;
  rolesKey: string;
  manifestKey: string;
  size: number;
  sha256: string;
  dumpMs: number;
  pruned: string[];
}

export const MANIFEST_VERSION = 1;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Manila is UTC+8 all year (no DST). */
export function manilaDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export async function sha256OfFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const log = (s: string) => console.log(`[db-backup] ${s}`);

export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const { store, sourceUrl, heartbeat, tmpDir } = deps;
  const secrets = secretsOf(sourceUrl);
  const clean = (s: string) => redact(s, secrets);
  const safeBeat = async (what: 'start' | 'ok' | 'fail', reason?: string) => {
    try {
      if (what === 'fail') await heartbeat.fail(reason ?? 'failed');
      else await heartbeat[what]();
    } catch (e) {
      log(clean(`heartbeat ${what} not delivered: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  const now = deps.now();
  const date = manilaDate(now);
  const stemName = `shareat-${utcStamp(now)}`;
  const stem = `${BACKUP_PREFIX}daily/${date}/${stemName}`;
  const keys = { dump: `${stem}.dump`, roles: `${stem}.roles.sql`, manifest: `${stem}.manifest.json` };
  const local = {
    dump: path.join(tmpDir, `${stemName}.dump`),
    roles: path.join(tmpDir, `${stemName}.roles.sql`),
    manifest: path.join(tmpDir, `${stemName}.manifest.json`),
  };

  await safeBeat('start');
  let sql: postgres.Sql | undefined;
  try {
    assertDirectPort(sourceUrl);
    await mkdir(tmpDir, { recursive: true });
    sql = postgres(sourceUrl, { max: 1, onnotice: () => {}, connect_timeout: 30 });

    // R1: only a role that sees every row can produce a full dump.
    const [info] = await sql<{ ok: boolean; ver: number; bytes: string; version: string }[]>`
      select (r.rolbypassrls or r.rolsuper) as ok,
             current_setting('server_version_num')::int as ver,
             pg_database_size(current_database())::text as bytes,
             version() as version
      from pg_roles r where r.rolname = current_user`;
    if (!info?.ok) {
      throw new Error('refusing to back up: current_user has neither rolbypassrls nor rolsuper, so the dump would be hollow (R1)');
    }
    for (const t of ['pg_dump', 'pg_restore', 'pg_dumpall'] as PgTool[]) await assertClientMatchesServer(resolvePgBin(t), info.ver);

    // R6: free-disk pre-check.
    const need = Number(info.bytes) * 1.5;
    const fs = statfsSync(tmpDir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < need) throw new Error(`not enough free disk in ${tmpDir}: ${Math.floor(free)} bytes free, ${Math.ceil(need)} needed (1.5 x database size)`);

    // R2: fingerprint and dump from ONE exported snapshot; the session stays open until pg_dump has exited.
    let fingerprint!: Fingerprint;
    const t0 = Date.now();
    await sql.begin('isolation level repeatable read read only', async (tx) => {
      const [iso] = await tx<{ transaction_isolation: string }[]>`show transaction_isolation`;
      if (iso?.transaction_isolation !== 'repeatable read') {
        throw new Error(`snapshot transaction is "${String(iso?.transaction_isolation)}", expected repeatable read`);
      }
      const [snap] = await tx<{ id: string }[]>`select pg_export_snapshot() as id`;
      if (!snap?.id) throw new Error('pg_export_snapshot returned nothing');
      fingerprint = await computeFingerprint(tx as unknown as postgres.Sql);
      const empty = emptyLedgerReason(fingerprint);
      if (empty) throw new Error(`refusing to write a manifest: ${empty}`);
      await deps.hooks?.afterFingerprint?.();
      const { argv, env } = buildPgArgs(sourceUrl, ['-Fc', `--snapshot=${snap.id}`, '-f', local.dump]);
      const r = await runTool(resolvePgBin('pg_dump'), argv, env);
      if (r.code !== 0) throw new Error(`pg_dump exited ${String(r.code)}: ${r.stderr.trim().slice(0, 500)}`);
    });
    const dumpMs = Date.now() - t0;
    log(`pg_dump done in ${dumpMs} ms`);
    await deps.hooks?.afterDump?.(local.dump);

    // Roles (no password hashes): pg_dump carries none, and a restore into a new cluster needs them.
    {
      const { argv, env } = buildPgArgs(sourceUrl, ['--roles-only', '--no-role-passwords', '-f', local.roles]);
      const r = await runTool(resolvePgBin('pg_dumpall'), argv, env);
      if (r.code !== 0) throw new Error(`pg_dumpall exited ${String(r.code)}: ${r.stderr.trim().slice(0, 500)}`);
    }

    // R6: three-step verification. --list reads only the TOC; the full read decodes every data block.
    {
      const bin = resolvePgBin('pg_restore');
      const list = await runTool(bin, ['--list', local.dump], {});
      const entries = list.stdout.split('\n').filter((l) => l.trim() !== '' && !l.startsWith(';'));
      if (list.code !== 0 || entries.length === 0) throw new Error(`pg_restore --list failed or found no entries (exit ${String(list.code)})`);
      const full = await runTool(bin, ['-f', NULL_DEVICE, local.dump], {});
      if (full.code !== 0) throw new Error(`the dump failed a full read (exit ${String(full.code)}): ${full.stderr.trim().slice(0, 300)}`);
    }

    const size = (await stat(local.dump)).size;
    const sha = await sha256OfFile(local.dump);
    const rolesSize = (await stat(local.roles)).size;
    const rolesSha = await sha256OfFile(local.roles);

    await store.put(keys.dump, local.dump, { sha256: sha });
    await store.put(keys.roles, local.roles, { sha256: rolesSha });
    for (const [key, bytes, hash] of [[keys.dump, size, sha], [keys.roles, rolesSize, rolesSha]] as const) {
      const h = await store.head(key);
      if (!h || h.size !== bytes || h.meta.sha256 !== hash) throw new Error(`upload verification failed for ${key}`);
    }

    const toolVersion = (await runTool(resolvePgBin('pg_dump'), ['--version'], {})).stdout.trim();
    const manifest = {
      version: MANIFEST_VERSION,
      createdAt: now.toISOString(),
      manilaDate: date,
      sourceServerVersion: info.version,
      sourceServerVersionNum: info.ver,
      sourceDatabaseBytes: Number(info.bytes),
      pgDumpVersion: toolVersion,
      dumpKey: keys.dump,
      size,
      sha256: sha,
      dumpMs,
      rolesKey: keys.roles,
      rolesSize,
      rolesSha256: rolesSha,
      fingerprint,
    };
    await writeFile(local.manifest, JSON.stringify(manifest, null, 2));
    // R3: the manifest goes LAST, so "manifest exists" means "the upload finished".
    await store.put(keys.manifest, local.manifest, { sha256: await sha256OfFile(local.manifest) });
    const mh = await store.head(keys.manifest);
    if (!mh) throw new Error(`upload verification failed for ${keys.manifest}`);

    // R5, I3: prune only now that tonight's dump and manifest are verified in the store.
    const all = (await store.list(`${BACKUP_PREFIX}daily/`)).map((o) => o.key);
    const plan = planPrune(all, date);
    const doomed = plan.delete.filter((k) => DAILY_KEY_RE.test(k) && !k.startsWith(`${stem}.`));
    let pruned = doomed;
    if (doomed.length > 0) {
      try {
        await store.delete(doomed);
      } catch (e) {
        // The backup is already verified in the store; a failed prune only delays retention to the next night.
        pruned = [];
        log(clean(`WARNING: prune failed after a verified upload (retention retried tomorrow): ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    log(`ok: ${keys.dump} ${size} bytes sha256 ${sha.slice(0, 12)}; pruned ${pruned.length} object(s)`);

    await safeBeat('ok');
    return { dumpKey: keys.dump, rolesKey: keys.roles, manifestKey: keys.manifest, size, sha256: sha, dumpMs, pruned };
  } catch (e) {
    const msg = clean(e instanceof Error ? e.message : String(e));
    log(`FAILED: ${msg}`);
    await safeBeat('fail', msg);
    throw new Error(msg);
  } finally {
    for (const f of Object.values(local)) await rm(f, { force: true }).catch(() => {});
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** Reads a manifest from a local file (for the drill and tooling). */
export async function readManifestFile(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}
