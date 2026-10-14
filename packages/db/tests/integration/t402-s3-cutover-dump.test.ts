import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-402 S3 - R15 (docs/tasks/402-activity-log.md "S3 contract" C6, Invariant 22c): the cutover purge first dumps
 * `audit_log` (every partition, data only, plus `audit_log_event_keys`) and records the dump's sha256; only then TRUNCATEs;
 * and the `cutover.purge` event is written AFTER the purge, so it is the first row of the production log and is never
 * truncated by it. TESTER, not BUILDER.
 *
 * Contract under test (packages/db/src/cutover/purge.ts):
 *   dumpAuditLog({ databaseUrl, dir, asOf, pgBinDir? }): Promise<{ path, sha256, bytes, rowCount }>
 *   applyPurge(tx, plan, { performedBy, auditDump })   `auditDump` REQUIRED; refused before any write when its sha256 is
 *     not 64 hex, or when count(audit_log) !== auditDump.rowCount (rows were written since the dump), or when it is absent.
 *   applyPurge writes `cutover.purge` per C2-performer org, in the purge transaction, after the purge, with
 *   after { dumpFile (basename), dumpSha256, dumpBytes, auditRowsDumped, purgedRows, tables, asOf }.
 *
 * Mutants guarded: no dump; dump taken after the TRUNCATE (rowCount 0 or a restore list without the partitions);
 * event written BEFORE the purge (it would be truncated: the row would not exist after); sha not checked; stale dump
 * accepted; absolute path stored.
 *
 * ## State at HEAD
 * `dumpAuditLog` does not exist and applyPurge writes no event, so every case is red on that ("dumpAuditLog is not a
 * function" / "expected [] to have a length of 1").
 *
 * Runs on the lane DB. The purge itself is applied inside a transaction that is rolled back (a rehearsal), so the lane
 * database is left as it was.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
const PG_WIN = 'C:/Program Files/PostgreSQL/18/bin';
const pgBinDir = process.env.PG_BIN_DIR ?? (process.platform === 'win32' && existsSync(PG_WIN) ? PG_WIN : undefined);
const exe = (n: string) => (pgBinDir ? join(pgBinDir, process.platform === 'win32' ? `${n}.exe` : n) : n);

import { performersForAllOrgs } from '../../../../tests/integration/t390-real-purge';

const sql = postgres(url, { max: 3, onnotice: () => {} });
const dirs: string[] = [];
const freshDir = (label: string) => {
  const base = mkdtempSync(join(tmpdir(), `t402s3-${label}-`));
  dirs.push(base);
  return join(base, 'dumps'); // does not exist yet: the function creates it
};
afterAll(async () => {
  await sql.end({ timeout: 5 });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
class Rollback extends Error {}

type Dump = { path: string; sha256: string; bytes: number; rowCount: number };
type PurgeMod = {
  planPurge: (sql: unknown, asOf: string) => Promise<unknown>;
  applyPurge: (tx: unknown, plan: unknown, opts: Record<string, unknown>) => Promise<unknown>;
  dumpAuditLog?: (o: { databaseUrl: string; dir: string; asOf: string; pgBinDir?: string }) => Promise<Dump>;
};
const purgeMod = async () => (await import('../../src/cutover/purge')) as unknown as PurgeMod;
async function dump(dir: string, over: Record<string, unknown> = {}): Promise<Dump> {
  const m = await purgeMod();
  expect(typeof m.dumpAuditLog, 'dumpAuditLog is exported from packages/db/src/cutover/purge.ts').toBe('function');
  return m.dumpAuditLog!({ databaseUrl: url!, dir, asOf: '2027-01-01', ...(pgBinDir ? { pgBinDir } : {}), ...over } as never);
}
const sha256File = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from audit_log`)[0]!.n;

let orgId = '';
let personId = '';
beforeAll(async () => {
  const code = `t402s3dump-${Date.now()}`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  orgId = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${code}, 'S') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Performer') returning id`;
  personId = p!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, 'admin')`;
  const at = new Date().toISOString();
  for (const retention of ['r10y', 'r2y'] as const) {
    const [r] = await sql<{ id: string }[]>`
      insert into audit_log (org_id, store_id, actor_person_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
      values (${orgId}, ${s!.id}, ${personId}, ${retention === 'r10y' ? 'set_channel_payout' : 'auth.signin_succeeded'}, ${retention === 'r10y' ? 'sales_channels' : 'persons'},
              ${crypto.randomUUID()}, 'web', ${retention === 'r10y' ? 'money' : 'security'}, ${retention === 'r10y' ? 'high' : 'low'}, ${retention === 'r10y' ? 4 : 6},
              ${retention}, ${at}::timestamptz, ${at}::timestamptz) returning id`;
    await sql`
      insert into audit_log_event_keys (org_id, event_key, payload_sha256, audit_log_id, retention_class, recorded_at)
      values (${orgId}, ${crypto.randomUUID()}, ${'a'.repeat(64)}, ${r!.id}, ${retention}, ${at}::timestamptz)`;
  }
}, 120_000);

describe('dumpAuditLog (R15): a verified, hashed, data-only dump of every audit_log partition', () => {
  it('writes ONE file in the directory it creates, returns its sha256 (matches the file), its size and the audit_log row count at dump time, and a <file>.sha256 beside it', async () => {
    const dir = freshDir('basic');
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(2);
    const d = await dump(dir);
    expect(dirname(d.path).replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'));
    expect(existsSync(d.path)).toBe(true);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.sha256, 'the recorded sha is the file\'s sha (mutant: sha of something else)').toBe(sha256File(d.path));
    expect(d.bytes).toBe(statSync(d.path).size);
    expect(d.bytes).toBeGreaterThan(0);
    expect(d.rowCount, 'rowCount is the live audit_log count (mutant: counted after the TRUNCATE)').toBe(before);
    const side = `${d.path}.sha256`;
    expect(existsSync(side), 'the sha sidecar').toBe(true);
    expect(readFileSync(side, 'utf8')).toContain(d.sha256);
    if (process.platform !== 'win32') {
      expect((statSync(dir).mode & 0o777).toString(8), 'dir 0700').toBe('700');
      expect((statSync(d.path).mode & 0o777).toString(8), 'file 0600').toBe('600');
      expect((statSync(side).mode & 0o777).toString(8), 'sidecar 0600').toBe('600');
    }
  }, 120_000);

  it('the dump holds TABLE DATA for EVERY partition of audit_log and for audit_log_event_keys, and no schema (data only)', async () => {
    const d = await dump(freshDir('contents'));
    const list = spawnSync(exe('pg_restore'), ['--list', d.path], { encoding: 'utf8' });
    expect(list.status, list.stderr).toBe(0);
    const dataLines = list.stdout.split('\n').filter((l) => /TABLE DATA/.test(l));
    const leaves = await sql<{ relname: string }[]>`
      select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.audit_log'::regclass
         or i.inhparent in (select inhrelid from pg_inherits where inhparent = 'public.audit_log'::regclass)`;
    expect(leaves.length, 'the lane DB has partitions to dump').toBeGreaterThanOrEqual(6);
    for (const l of leaves) {
      expect(dataLines.some((x) => x.includes(` ${l.relname} `)), `TABLE DATA entry for partition ${l.relname}`).toBe(true);
    }
    expect(dataLines.some((x) => x.includes(' audit_log_event_keys ')), 'the event keys travel with the log').toBe(true);
    expect(list.stdout.split('\n').filter((l) => /\bTABLE\b(?! DATA)/.test(l) && /audit_log/.test(l)), 'data only: no table definitions').toEqual([]);
  }, 120_000);

  it('the database password is never written into the dump directory, and an unusable pg_dump FAILS the call and leaves no dump file (mutant: reports success without a dump)', async () => {
    const dir = freshDir('nobin');
    await expect(dump(dir, { pgBinDir: join(tmpdir(), 'definitely-not-a-pg-bin-dir') })).rejects.toThrow();
    const leftovers = existsSync(dir) ? readdirSync(dir) : [];
    expect(leftovers, 'no dump file after a failed dump').toEqual([]);
    const pw = decodeURIComponent(new URL(url!).password);
    if (pw) {
      const ok = await dump(freshDir('pw'));
      expect(readFileSync(`${ok.path}.sha256`, 'utf8')).not.toContain(pw);
    }
  }, 120_000);
});

describe('applyPurge (R15): the dump is required, checked, then the purge runs; cutover.purge is written AFTER it', () => {
  async function rehearse(
    auditDump: unknown,
    after?: (tx: postgres.TransactionSql) => Promise<void>,
    opts: Record<string, unknown> = {},
  ): Promise<unknown> {
    const m = await purgeMod();
    const performedBy = await performersForAllOrgs(sql, personId);
    try {
      await sql.begin(async (tx) => {
        const plan = await m.planPurge(tx, '2027-01-01');
        await m.applyPurge(tx, plan, { performedBy, ...(auditDump === undefined ? {} : { auditDump }), ...opts });
        if (after) await after(tx);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) return e;
    }
    return undefined;
  }

  it('with a good dump: after the purge audit_log holds ONLY the cutover.purge row(s); the seeded rows and the event keys are gone, and the event carries the dump\'s basename, sha, size and row count', async () => {
    const d = await dump(freshDir('apply'));
    let seen: { action: string; org_id: string; actor_person_id: string | null; store_id: string | null; sensitivity: string; retention_class: string; after: Record<string, unknown> }[] = [];
    let keys = -1;
    const err = await rehearse(d, async (tx) => {
      seen = await tx`select action, org_id, actor_person_id, store_id, sensitivity, retention_class, after from audit_log` as never;
      keys = (await tx<{ n: number }[]>`select count(*)::int as n from audit_log_event_keys`)[0]!.n;
    });
    expect(err, err instanceof Error ? err.message : String(err)).toBeUndefined();
    expect(seen.length, 'the purge event exists AFTER the TRUNCATE (mutant: written before, so truncated)').toBeGreaterThan(0);
    expect(seen.every((r) => r.action === 'cutover.purge'), 'nothing written before the purge survives it').toBe(true);
    expect(keys, 'event keys purged with their rows').toBe(0);
    const mine = seen.filter((r) => r.org_id === orgId);
    expect(mine, 'one cutover.purge for the org whose C2 performer was named').toHaveLength(1);
    const row = mine[0]!;
    expect(row.actor_person_id).toBe(personId);
    expect(row.store_id, 'org-scoped').toBeNull();
    expect(row.sensitivity).toBe('critical');
    expect(row.retention_class).toBe('r10y');
    expect(row.after.dumpFile, 'basename only, never an absolute path').toBe(basename(d.path));
    expect(String(row.after.dumpFile)).not.toMatch(/[\\/]/);
    expect(row.after.dumpSha256).toBe(d.sha256);
    expect(row.after.dumpBytes).toBe(d.bytes);
    expect(row.after.auditRowsDumped).toBe(d.rowCount);
    expect(row.after.asOf).toBe('2027-01-01');
    expect(typeof row.after.purgedRows).toBe('number');
    expect(row.after.tables).toBeDefined();
  }, 600_000);

  it('the cutover.purge row is the first thing in the log: it is written after the purge\'s own C2 rows (recorded_at is not earlier than the C2 step)', async () => {
    const d = await dump(freshDir('order'));
    let c2: Date | null = null;
    let ev: Date | null = null;
    const err = await rehearse(d, async (tx) => {
      c2 = (await tx<{ t: Date }[]>`select max(completed_at) as t from cutover_steps where org_id = ${orgId} and step_code = 'C2'`)[0]?.t ?? null;
      ev = (await tx<{ t: Date }[]>`select recorded_at as t from audit_log where org_id = ${orgId} and action = 'cutover.purge'`)[0]?.t ?? null;
    });
    expect(err, err instanceof Error ? err.message : String(err)).toBeUndefined();
    expect(ev, 'the event exists').not.toBeNull();
    if (c2 && ev) expect((ev as Date).getTime()).toBeGreaterThanOrEqual((c2 as Date).getTime());
  }, 600_000);

  it('REFUSED before any write: no auditDump at all, a sha that is not 64 hex, and a stale dump (a row was written after it): nothing is truncated, no cutover.purge exists', async () => {
    const good = await dump(freshDir('refuse'));
    const before = await count();
    const noDump = await rehearse(undefined);
    expect(noDump, 'a missing auditDump is refused').toBeInstanceOf(Error);
    const badSha = await rehearse({ ...good, sha256: 'not-a-sha' });
    expect(badSha, 'a malformed sha is refused').toBeInstanceOf(Error);
    const shortSha = await rehearse({ ...good, sha256: good.sha256.slice(0, 63) });
    expect(shortSha, 'a 63-char sha is refused').toBeInstanceOf(Error);

    const stale = await dump(freshDir('stale'));
    await sql`insert into audit_log (org_id, actor_person_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class)
      values (${orgId}, ${personId}, 'set_channel_payout', 'sales_channels', ${crypto.randomUUID()}, 'web', 'money', 'high', 4, 'r10y')`;
    const staleErr = await rehearse(stale);
    expect(staleErr, 'count(audit_log) !== dump.rowCount is refused: the dump is stale').toBeInstanceOf(Error);
    expect(await count(), 'refusals changed nothing').toBe(before + 1);
    expect((await sql`select 1 from audit_log where action = 'cutover.purge'`).length).toBe(0);
  }, 600_000);
});
