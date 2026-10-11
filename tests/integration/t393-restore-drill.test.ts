import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * T-393 S2 - weekly restore drill. `docs/tasks/393-nightly-backup-and-restore.md` R8-R10, R13, I6, I7, tests 16-23
 * (with 22b, 23a). Written TESTER-FIRST: red with "Cannot find module scripts/lib/backup/run-drill" until the builder
 * lands it.
 *
 * Real Postgres, real pg_dump / pg_restore, `fsStore(tmpdir)` for Spaces, a recording fake heartbeat. The backup is
 * made by S1's real `runBackup`. Drill targets are `shareat_test_drill_<random>`, all dropped in afterAll.
 *
 * ## Contract choices the spec leaves open (flagged in the hand-back)
 *  - `runDrill` is called as in the spec, plus OPTIONAL test-only `hooks` (as `runBackup` has):
 *      `hooks.afterRestore(dbName)`   - after pg_restore, BEFORE the tie and sequence checks, target still present;
 *      `hooks.checkUrl(dbName)`       - connection string the checks run through (default: the target URL).
 *    Test 19 (empty is not a tie) needs the check to run as a non-BYPASSRLS role; 23 and 23a need a window on the
 *    restored database before it is dropped.
 *  - A failed check RESOLVES `{ ok: false, mismatches: string[], ... }` or REJECTS; this file accepts either, via
 *    `drill()`, and asserts on the combined text. A passing drill MUST resolve `{ ok: true }`.
 *  - The report at `postgres/drills/YYYY-MM-DD.json` is JSON holding the dump key (any field) and three numeric
 *    durations whose field names match /download/i, /restore/i and /check/i (top level or one level down).
 *  - The drill uses the heartbeat as the backup does: `start` then `ok`, or `start` then `fail`.
 *  - `sourceUrl` is deliberately NOT reachable (host source.invalid) except where a guard case needs the real source:
 *    a drill that only PARSES it passes, a drill that connects to it fails.
 */

config({ path: '.env.local' });

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(adminUrl)) {
  throw new Error(`Refusing to run against ${adminUrl.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { closeDb, withOrgPrincipal } from '@shareat/db';
import { postEntry } from '@shareat/domain';
import { seedChartOfAccounts } from '../../packages/db/seed/chart-of-accounts';
import { WORKED_EXAMPLES, type FixtureLine, type WorkedExample } from '../worked-examples/fixtures';
import { RESTRICTED_TEST_PASSWORD, RESTRICTED_TEST_ROLE } from './setup';
import { leaksPassword } from './t393-no-leak';
import { fsStore, type ObjectStore } from '../../scripts/lib/backup/object-store';
import { runBackup } from '../../scripts/lib/backup/run-backup';
import { runDrill } from '../../scripts/lib/backup/run-drill';
import type { Heartbeat } from '../../scripts/lib/backup/heartbeat';

const sql = postgres(adminUrl, { max: 4, onnotice: () => {} });
const sourceDbName = decodeURIComponent(new URL(adminUrl).pathname.slice(1));
const adminPassword = decodeURIComponent(new URL(adminUrl).password);

// ---------------------------------------------------------------------------------------------- helpers

const urlFor = (db: string, user?: { name: string; password: string }): string => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};

/**
 * A second spelling of the SAME server, used only by the drill under test. The test's own pools and helpers use the
 * host from TEST_DATABASE_URL, so any connection the spy sees to ALTHOST came from the drill and from nothing else
 * (a pooled connection of the test reconnecting cannot be mistaken for it).
 */
const OWN_HOST = new URL(adminUrl).hostname;
const ALT_HOST = OWN_HOST === '127.0.0.1' ? 'localhost' : '127.0.0.1';
const altUrlFor = (db: string): string => {
  const u = new URL(urlFor(db));
  u.hostname = ALT_HOST;
  return u.toString();
};

const PG_WIN = 'C:/Program Files/PostgreSQL/18/bin';
function pgBin(name: 'pg_dump' | 'pg_restore' | 'pg_dumpall'): string {
  const dir = process.env.PG_BIN_DIR;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return dir ? path.join(dir, exe) : exe;
}

const dirs: string[] = [];
const freshDir = (label: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `t393d-${label}-`));
  dirs.push(d);
  return d;
};

type Call = { name: 'start' | 'ok' | 'fail'; arg?: string };
function fakeHeartbeat(): Heartbeat & { calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: Call['name']) => async (arg?: string) => {
    calls.push({ name, arg });
  };
  return { calls, start: rec('start'), ok: rec('ok'), fail: rec('fail') } as Heartbeat & { calls: Call[] };
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<{ out: string; result: { ok: true; value: T } | { ok: false; error: unknown } }> {
  let out = '';
  const so = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => ((out += String(c)), true)) as never);
  const se = vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => ((out += String(c)), true)) as never);
  try {
    const value = await fn();
    return { out, result: { ok: true, value } };
  } catch (error) {
    return { out, result: { ok: false, error } };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

/** Every outbound TCP connection this process opens while `fn` runs (postgres.js and any other in-process client). */
async function withConnectSpy<T>(fn: () => Promise<T>): Promise<{ value: T; connects: { host: string; port: number }[] }> {
  const connects: { host: string; port: number }[] = [];
  const orig = net.Socket.prototype.connect;
  const spy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const a = args[0];
    if (a && typeof a === 'object') {
      const o = a as { host?: string; port?: number | string };
      connects.push({ host: String(o.host ?? ''), port: Number(o.port) });
    } else if (typeof a === 'number' || typeof a === 'string') {
      connects.push({ host: typeof args[1] === 'string' ? (args[1] as string) : 'localhost', port: Number(a) });
    }
    return (orig as (...x: unknown[]) => net.Socket).apply(this, args);
  } as never);
  try {
    return { value: await fn(), connects };
  } finally {
    spy.mockRestore();
  }
}

const DRILL_NAME = /^shareat_(restore_drill|test_drill_[a-z0-9]+)$/;
const scratchDbs: string[] = [];
const decoyDbs: string[] = [];
const newTargetName = (label: string): string => {
  const name = `shareat_test_drill_${label}${randomBytes(3).toString('hex')}`;
  expect(name).toMatch(DRILL_NAME);
  scratchDbs.push(name);
  return name;
};
async function withAdmin<T>(fn: (a: postgres.Sql) => Promise<T>): Promise<T> {
  const a = postgres(urlFor('postgres'), { max: 1, onnotice: () => {} });
  try {
    return await fn(a);
  } finally {
    await a.end({ timeout: 5 });
  }
}
const dbExists = (name: string) => withAdmin(async (a) => (await a`select 1 from pg_database where datname = ${name}`).length > 0);

/** Copies every object of `from` into a new fs store, so a test can tamper without touching the shared backup. */
async function cloneStore(from: ObjectStore): Promise<ObjectStore> {
  const to = fsStore(freshDir('clone'));
  const tmp = freshDir('clonetmp');
  for (const o of await from.list('postgres/')) {
    const f = path.join(tmp, createHash('sha256').update(o.key).digest('hex'));
    await from.get(o.key, f);
    await to.put(o.key, f, {});
  }
  return to;
}
const keyOf = async (store: ObjectStore, suffix: string) =>
  (await store.list('postgres/daily/')).map((o) => o.key).find((k) => k.endsWith(suffix))!;
async function editManifest(store: ObjectStore, edit: (m: Record<string, any>) => void): Promise<void> {
  const key = await keyOf(store, '.manifest.json');
  const f = path.join(freshDir('mf'), 'm.json');
  await store.get(key, f);
  const m = JSON.parse(readFileSync(f, 'utf8'));
  edit(m);
  writeFileSync(f, JSON.stringify(m));
  await store.put(key, f, {});
}

type DrillOver = {
  store: ObjectStore;
  targetUrl: string;
  sourceUrl?: string;
  hooks?: { afterRestore?: (db: string) => Promise<void>; checkUrl?: (db: string) => string };
};
const UNREACHABLE_SOURCE = 'postgresql://src:srcpw@source.invalid:25060/shareat_prod_unreachable?sslmode=require';

interface Outcome {
  ok: boolean;
  text: string;
  result: Record<string, any> | null;
  error: unknown;
  out: string;
  hb: Call[];
  connects: { host: string; port: number }[];
  tmpDir: string;
}
/** Runs the drill; a rejection and a resolved `{ ok: false }` both mean "the drill failed". */
async function drill(over: DrillOver): Promise<Outcome> {
  const hb = fakeHeartbeat();
  const tmpDir = freshDir('dtmp');
  const { value, connects } = await withConnectSpy(() =>
    captureOutput(() =>
      runDrill({
        store: over.store,
        targetUrl: over.targetUrl,
        maintenanceDb: 'postgres',
        sourceUrl: over.sourceUrl ?? UNREACHABLE_SOURCE,
        heartbeat: hb,
        tmpDir,
        ...(over.hooks ? { hooks: over.hooks } : {}),
      } as Parameters<typeof runDrill>[0]),
    ),
  );
  const result = value.result.ok ? ((value.result.value as unknown as Record<string, any>) ?? null) : null;
  const error = value.result.ok ? null : value.result.error;
  const ok = value.result.ok && result?.ok === true;
  const text = [error ? String((error as Error)?.message ?? error) : '', result ? JSON.stringify(result) : ''].join('\n');
  return { ok, text, result, error, out: value.out, hb: hb.calls, connects, tmpDir };
}

// ---------------------------------------------------------------------------------------------- seeding

let orgA = '';
let orgB = '';
let baseStore: ObjectStore;
const NOW = new Date('2026-10-10T20:30:00Z');

function postAsOrg(orgId: string, input: Omit<Parameters<typeof postEntry>[1], 'orgId'>) {
  return withOrgPrincipal(orgId, (tx) => postEntry(tx, { ...input, orgId } as Parameters<typeof postEntry>[1]));
}
const toLine = (l: FixtureLine) => ({
  accountCode: l.accountCode,
  debit: l.debit,
  credit: l.credit,
  partyType: l.party?.type ?? null,
  partyId: l.party?.id ?? null,
  storeId: null,
  channelId: l.channelId ?? null,
  lineMemo: l.lineMemo ?? null,
});
async function postFixture(orgId: string, id: string, tag: string) {
  const fx: WorkedExample | undefined = WORKED_EXAMPLES.find((w) => w.id === id);
  if (!fx) throw new Error(`fixture ${id} not found`);
  await postAsOrg(orgId, {
    entryDate: fx.entryDate,
    sourceType: fx.sourceType,
    sourceId: `${fx.id}:${tag}`,
    idempotencyKey: `t393d:${tag}:${fx.id}`,
    memo: fx.title,
    lines: fx.expect.map(toLine),
  });
}

beforeAll(async () => {
  if (!process.env.PG_BIN_DIR && process.platform === 'win32' && existsSync(PG_WIN)) process.env.PG_BIN_DIR = PG_WIN;
  for (const bin of ['pg_dump', 'pg_restore', 'pg_dumpall'] as const) {
    const r = spawnSync(pgBin(bin), ['--version'], { encoding: 'utf8' });
    if (r.status !== 0 || !/ 18\./.test(r.stdout)) {
      throw new Error(
        `${bin} (PostgreSQL 18 client) is not usable: set PG_BIN_DIR to the PG18 bin directory. ` +
          `Got status ${String(r.status)} ${r.stdout}${r.stderr}${r.error ? String(r.error) : ''}`,
      );
    }
  }
  await sql`
    truncate table journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations restart identity cascade`;
  const mkOrg = async (code: string) => {
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`T393D ${code}`}, ${code}) returning id`;
    await seedChartOfAccounts(sql, o!.id);
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      select ${o!.id}, m::date, (m + interval '1 month - 1 day')::date, 'open'
      from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;
    return o!.id;
  };
  orgA = await mkOrg('t393d-org-a');
  orgB = await mkOrg('t393d-org-b');
  await postFixture(orgA, 'expense.cash.simple', 'a');
  await postFixture(orgA, 'expense.split.cash-online', 'a');
  await postFixture(orgA, 'expense.credit.ap', 'a');
  await postFixture(orgB, 'expense.cash.simple', 'b');
  await postFixture(orgB, 'expense.split.cash-online', 'b');

  // One real backup, made by S1's runBackup, that the drill tests restore from (a test that tampers clones it first).
  baseStore = fsStore(freshDir('base'));
  await runBackup({ store: baseStore, sourceUrl: adminUrl, heartbeat: fakeHeartbeat(), now: () => NOW, tmpDir: freshDir('btmp') });
}, 180_000);

afterAll(async () => {
  await withAdmin(async (a) => {
    for (const name of [...scratchDbs, ...decoyDbs]) await a.unsafe(`drop database if exists ${name} with (force)`).catch(() => {});
  }).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** Row counts of the live source, to prove a refused drill touched nothing. */
const sourceCounts = async () => {
  const [r] = await sql<{ o: string; l: string; j: string }[]>`
    select (select count(*) from organizations)::text as o, (select count(*) from journal_lines)::text as l,
           (select count(*) from journal_entries)::text as j`;
  return r;
};

// ---------------------------------------------------------------------------------------------- tests

describe('T-393 S2 - runDrill', () => {
  it('16. round trip ties: ok, a report with durations in postgres/drills/, the scratch database gone, no temp files, source never connected, size logged', async () => {
    const store = await cloneStore(baseStore); // so the report count below is this test's alone
    const name = newTargetName('rt');
    const o = await drill({ store, targetUrl: urlFor(name) });

    expect(o.ok, `${o.text}\n${o.out}`).toBe(true);
    expect(o.hb.map((c) => c.name)).toEqual(['start', 'ok']);
    expect(await dbExists(name)).toBe(false); // dropped afterwards
    expect(o.connects.filter((c) => c.host.includes('source.invalid') || c.port === 25060)).toEqual([]); // I7: only parsed
    expect(o.out).toMatch(/\d+\s*(bytes|B|kB|MB|GB)|pg_database_size|database size/i); // R8: the restored size is logged
    expect(readdirSync(o.tmpDir)).toEqual([]);

    const reports = (await store.list('postgres/drills/')).map((x) => x.key);
    expect(reports, 'the report must be written to postgres/drills/<date>.json').toHaveLength(1);
    expect(reports[0]).toMatch(/^postgres\/drills\/\d{4}-\d{2}-\d{2}\.json$/);
    const f = path.join(freshDir('rep'), 'r.json');
    await store.get(reports[0]!, f);
    const text = readFileSync(f, 'utf8');
    const rep = JSON.parse(text) as Record<string, any>;
    expect(text).toContain(await keyOf(store, '.dump'));
    const flat: Record<string, unknown> = { ...rep, ...(typeof rep.durations === 'object' && rep.durations ? rep.durations : {}) };
    for (const re of [/download/i, /restore/i, /check/i]) {
      const hit = Object.entries(flat).find(([k, v]) => re.test(k) && typeof v === 'number');
      expect(hit, `report needs a numeric duration field matching ${String(re)}: ${text}`).toBeDefined();
    }
    expect(leaksPassword(text, adminPassword), 'the admin password must not appear').toBe(false); // R13
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(leaksPassword(o.out, adminPassword), 'the admin password must not appear').toBe(false);
  });

  it('17. a changed balance fails and names the org and account (a per-account edit; org totals untouched)', async () => {
    const store = await cloneStore(baseStore);
    let org = '';
    let account = '';
    await editManifest(store, (m) => {
      const row = m.fingerprint.trialBalance[0];
      org = row.orgId;
      account = row.accountId;
      row.debit = (Number(row.debit) + 0.01).toFixed(2);
    });
    const name = newTargetName('bal');
    const o = await drill({ store, targetUrl: urlFor(name) });

    expect(o.ok, 'a 0.01 difference must not tie').toBe(false);
    expect(o.text).toContain(org);
    expect(o.text).toContain(account);
    expect(o.hb.map((c) => c.name)).toEqual(['start', 'fail']);
    expect(await dbExists(name)).toBe(false); // dropped even on failure
    expect(leaksPassword(o.text, adminPassword), 'the admin password must not appear').toBe(false);
  });

  it('18. a lost table fails, naming it (row counts are compared)', async () => {
    const store = await cloneStore(baseStore);
    await editManifest(store, (m) => {
      m.fingerprint.rowCounts['public.organizations'] += 1;
    });
    const name = newTargetName('cnt');
    const o = await drill({ store, targetUrl: urlFor(name) });
    expect(o.ok).toBe(false);
    expect(o.text).toContain('public.organizations');
    expect(await dbExists(name)).toBe(false);
  });

  it('19. empty is not a tie (R9): the check run as a non-BYPASSRLS role that can SELECT every table sees nothing and FAILS', async () => {
    const [role] = await sql<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = ${RESTRICTED_TEST_ROLE}`;
    expect(role, `role ${RESTRICTED_TEST_ROLE} must exist`).toBeDefined();
    expect(role!.rolbypassrls || role!.rolsuper).toBe(false);

    const store = await cloneStore(baseStore);
    const name = newTargetName('rls');
    let adminLines = -1;
    let roleLines = -1;
    let roleErr: unknown = null;
    const o = await drill({
      store,
      targetUrl: urlFor(name),
      hooks: {
        afterRestore: async (db) => {
          const a = postgres(urlFor(db), { max: 1, onnotice: () => {} });
          try {
            await a.unsafe(`grant usage on schema public, drizzle to ${RESTRICTED_TEST_ROLE}`);
            await a.unsafe(`grant select on all tables in schema public, drizzle to ${RESTRICTED_TEST_ROLE}`);
            adminLines = Number((await a`select count(*)::text as n from journal_lines`)[0]!.n);
          } finally {
            await a.end({ timeout: 5 });
          }
          const r = postgres(urlFor(db, { name: RESTRICTED_TEST_ROLE, password: RESTRICTED_TEST_PASSWORD }), { max: 1, onnotice: () => {} });
          try {
            roleLines = Number((await r`select count(*)::text as n from journal_lines`)[0]!.n);
          } catch (e) {
            roleErr = e;
          } finally {
            await r.end({ timeout: 5 });
          }
        },
        checkUrl: (db) => urlFor(db, { name: RESTRICTED_TEST_ROLE, password: RESTRICTED_TEST_PASSWORD }),
      },
    });

    // The set-up is what makes the test meaningful: SELECT is granted (no permission error) and RLS hides every row.
    expect(roleErr, `setup is wrong: the role got an error instead of an empty set: ${String(roleErr)}`).toBeNull();
    expect(adminLines).toBeGreaterThan(0);
    expect(roleLines).toBe(0);
    expect(o.ok, 'equal empties must not be reported as a tie').toBe(false);
    expect(o.text).toMatch(/empty|no orgs|zero|0 journal|no journal/i);
    expect(await dbExists(name)).toBe(false);
  });

  it('20. checksum: one flipped byte in the stored dump fails BEFORE restoring, and no database is created', async () => {
    const store = await cloneStore(baseStore);
    const dumpKey = await keyOf(store, '.dump');
    const f = path.join(freshDir('flip'), 'd.dump');
    await store.get(dumpKey, f);
    const buf = readFileSync(f);
    const at = Math.floor(buf.length / 2);
    const was = buf[at];
    if (was === undefined) throw new Error('the dump file is empty');
    buf[at] = was ^ 0xff;
    writeFileSync(f, buf);
    await store.put(dumpKey, f, {});

    const name = newTargetName('sum');
    const restored = vi.fn();
    const o = await drill({ store, targetUrl: urlFor(name), hooks: { afterRestore: async () => { restored(); } } });

    expect(o.ok).toBe(false);
    expect(o.text).toMatch(/sha-?256|checksum|digest|hash/i); // refused for the checksum, not for a later reason
    expect(restored).not.toHaveBeenCalled();
    expect(await dbExists(name)).toBe(false); // never created
    expect(o.hb.map((c) => c.name)).toEqual(['start', 'fail']);
  });

  it('22. no complete dump: a store holding only a bare .dump fails with "no complete dump"', async () => {
    const store = fsStore(freshDir('bare'));
    const f = path.join(freshDir('x'), 'bare.dump');
    writeFileSync(f, 'not a real dump');
    await store.put('postgres/daily/2026-10-11/shareat-20261010T203000Z.dump', f, {});
    const name = newTargetName('bare');
    const o = await drill({ store, targetUrl: urlFor(name) });

    expect(o.ok).toBe(false);
    expect(o.text).toMatch(/no complete dump/i);
    expect(await dbExists(name)).toBe(false);
    expect(o.hb.map((c) => c.name)).toEqual(['start', 'fail']);
  });

  it('22b. the newest COMPLETE dump is restored: a newer bare .dump with no manifest is ignored', async () => {
    const store = await cloneStore(baseStore);
    const f = path.join(freshDir('x'), 'newer.dump');
    writeFileSync(f, 'half-uploaded');
    await store.put('postgres/daily/2026-10-12/shareat-20261011T203000Z.dump', f, {});
    const name = newTargetName('newer');
    const o = await drill({ store, targetUrl: urlFor(name) });

    expect(o.ok, `${o.text}\n${o.out}`).toBe(true);
    const reports = (await store.list('postgres/drills/')).map((x) => x.key);
    const rf = path.join(freshDir('rep'), 'r.json');
    await store.get(reports[0]!, rf);
    const text = readFileSync(rf, 'utf8');
    expect(text).toContain(await keyOf(store, '20261010T203000Z.dump'));
    expect(text).not.toContain('20261011T203000Z');
  });

  it('21. target guards (R10, I7): shareat_test (the source), shareat_prod, foo_drill and a same-name-other-host target are each refused before ANY connection, and the source is untouched', async () => {
    const store = await cloneStore(baseStore);
    const decoy = 'foo_drill';
    await withAdmin((a) => a.unsafe(`create database ${decoy}`));
    decoyDbs.push(decoy);
    const before = await sourceCounts();

    const sameName = 'shareat_test_drill_samename';
    scratchDbs.push(sameName);
    const cases: { label: string; targetUrl: string; sourceUrl: string }[] = [
      { label: 'the source database itself', targetUrl: altUrlFor(sourceDbName), sourceUrl: altUrlFor(sourceDbName) },
      { label: 'shareat_prod', targetUrl: altUrlFor('shareat_prod'), sourceUrl: altUrlFor(sourceDbName) },
      { label: 'foo_drill (pattern fails; a real database exists)', targetUrl: altUrlFor(decoy), sourceUrl: altUrlFor(sourceDbName) },
      {
        // Pattern-valid, and EQUAL to the source's name, but on a different host: refused on the name alone.
        label: 'same name as the source on a different host',
        targetUrl: altUrlFor(sameName),
        sourceUrl: `postgresql://src:srcpw@source.invalid:25060/${sameName}?sslmode=require`,
      },
    ];
    for (const c of cases) {
      const o = await drill({ store, targetUrl: c.targetUrl, sourceUrl: c.sourceUrl });
      expect(o.ok, `${c.label} must be refused`).toBe(false);
      expect(o.connects.filter((x) => x.host === ALT_HOST), `${c.label}: the drill may open no connection before the refusal; text=${o.text}`).toEqual([]);
      expect(leaksPassword(o.text, adminPassword), 'the admin password must not appear').toBe(false);
    }
    expect(await dbExists(sameName), 'the same-name target must not have been created').toBe(false);
    expect(await dbExists(decoy), 'foo_drill must not have been dropped').toBe(true);
    expect(await dbExists('shareat_prod')).toBe(false); // nor created
    expect(await dbExists(sourceDbName)).toBe(true);
    expect(await sourceCounts()).toEqual(before);
  });

  it('23a. sequences: one set below max() of its column fails and is named; one running AHEAD of its rows passes', async () => {
    // drizzle.__drizzle_migrations.id is a serial with many rows in every migrated database.
    const [pick] = await sql<{ seq: string; tbl: string; col: string; max: string }[]>`
      select s.relname as seq, t.relname as tbl, a.attname as col,
             (select max(id)::text from drizzle.__drizzle_migrations) as max
      from pg_class s
      join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
      join pg_class t on t.oid = d.refobjid
      join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'drizzle'
      join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
      where s.relkind = 'S' and t.relname = '__drizzle_migrations'`;
    expect(pick, 'setup: drizzle.__drizzle_migrations must own a sequence').toBeDefined();
    expect(Number(pick!.max)).toBeGreaterThan(5);
    const seq = `drizzle.${pick!.seq}`;

    const setSeq = (value: number) => async (db: string) => {
      const a = postgres(urlFor(db), { max: 1, onnotice: () => {} });
      try {
        await a.unsafe(`select setval('${seq}', ${value}, true)`);
      } finally {
        await a.end({ timeout: 5 });
      }
    };

    const low = await drill({ store: await cloneStore(baseStore), targetUrl: urlFor(newTargetName('seqlo')), hooks: { afterRestore: setSeq(1) } });
    expect(low.ok, 'a sequence below max() of its column must fail').toBe(false);
    expect(low.text).toContain(pick!.seq);

    const ahead = await drill({
      store: await cloneStore(baseStore),
      targetUrl: urlFor(newTargetName('seqhi')),
      hooks: { afterRestore: setSeq(Number(pick!.max) + 1000) },
    });
    expect(ahead.ok, `a sequence ahead of its rows is fine (>= not ==): ${ahead.text}`).toBe(true);
  });

  it('23. history guards survive the restore (T-354): an UPDATE of a posted journal entry is refused by its trigger on the restored database', async () => {
    // Control on the live source: the guard fires there, so a refusal below means the restore kept it.
    await expect(sql.begin(async (tx) => {
      await tx`update journal_entries set memo = 'tamper' where id = (select id from journal_entries limit 1)`;
    })).rejects.toThrow();

    let refused: unknown = null;
    let updated = false;
    const o = await drill({
      store: await cloneStore(baseStore),
      targetUrl: urlFor(newTargetName('trg')),
      hooks: {
        afterRestore: async (db) => {
          const a = postgres(urlFor(db), { max: 1, onnotice: () => {} });
          try {
            await a`update journal_entries set memo = 'tamper' where id = (select id from journal_entries limit 1)`;
            updated = true;
          } catch (e) {
            refused = e;
          } finally {
            await a.end({ timeout: 5 });
          }
        },
      },
    });
    expect(o.ok, `${o.text}\n${o.out}`).toBe(true);
    expect(updated, 'the restored database let a posted journal entry be UPDATEd').toBe(false);
    expect(refused).not.toBeNull();
  });
});
