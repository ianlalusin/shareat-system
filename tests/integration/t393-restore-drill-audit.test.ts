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
 * T-393 S2 audit legs (coordinator's round 2): overlap (2), failed scratch DROP (3), expected size logged and required
 * (4), incomplete manifest (7). Same helpers and seeding as t393-restore-drill.test.ts, kept in a separate file so the
 * first file stays as reviewed.
 *
 * Contract choices (flagged in the hand-back):
 *  - 2: the second run is refused with a message matching /already|in progress|running|lock|overlap|busy/i, quickly,
 *    and the first run's database survives and the first run still finishes ok.
 *  - 3: the drop failure is forced by marking the restored scratch database IS_TEMPLATE (DROP DATABASE refuses a
 *    template). The run must then FAIL (resolved ok:false or rejected, heartbeat start,fail), never ok-with-a-warning.
 *  - 4: the log line before restore contains the manifest's sourceDatabaseBytes as plain digits (optionally with
 *    , _ or space thousand separators). A manifest without it is refused, naming the size or the field.
 *  - 7: a manifest whose fingerprint lacks orgTotals or rowCounts fails with "manifest is incomplete".
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

async function rawDrill(store: ObjectStore, target: string, hooks?: DrillOver['hooks']) {
  const hb = fakeHeartbeat();
  const r = await runDrill({
    store, targetUrl: urlFor(target), maintenanceDb: 'postgres', sourceUrl: UNREACHABLE_SOURCE, heartbeat: hb, tmpDir: freshDir('rtmp'),
    ...(hooks ? { hooks } : {}),
  } as Parameters<typeof runDrill>[0]).then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }));
  const res = r.value as Record<string, any> | null;
  const text = [r.error ? String((r.error as Error)?.message ?? r.error) : '', res ? JSON.stringify(res) : ''].join('\n');
  return { ok: res?.ok === true, text, hb: hb.calls };
}

describe('T-393 S2 audit - runDrill', () => {
  it('2. overlap: a second run while one holds the target is refused up front, does not drop the first run\'s database, and the first still finishes ok', async () => {
    const store = await cloneStore(baseStore);
    const name = newTargetName('olap');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });

    const first = rawDrill(store, name, { afterRestore: async () => { entered(); await gate; } });
    await Promise.race([inside, first.then((x) => { throw new Error(`the first drill ended before the hook: ${x.text}`); })]);
    expect(await dbExists(name)).toBe(true);

    let second;
    try {
      second = await Promise.race([
        rawDrill(await cloneStore(baseStore), name),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the second drill did not return within 60 s (it should be refused up front)')), 60_000)),
      ]);
    } catch (e) {
      release(); // a red here must not leave the first drill hanging on its gate
      throw e;
    }
    expect(second.ok).toBe(false);
    expect(second.text).toMatch(/already|in progress|running|lock|overlap|busy/i);
    expect(await dbExists(name), 'the second run must not have dropped the first run\'s database').toBe(true);

    release();
    const done = await first;
    expect(done.ok, done.text).toBe(true);
    expect(await dbExists(name)).toBe(false);
  }, 180_000);

  it('3. a failed scratch DROP at the end makes the run FAIL (heartbeat fail), not ok with a warning', async () => {
    const store = await cloneStore(baseStore);
    const name = newTargetName('dropfail');
    let hbCalls: Call[] = [];
    const hb = fakeHeartbeat();
    hbCalls = hb.calls;
    const res = await runDrill({
      store, targetUrl: urlFor(name), maintenanceDb: 'postgres', sourceUrl: UNREACHABLE_SOURCE, heartbeat: hb, tmpDir: freshDir('dtmp'),
      hooks: {
        afterRestore: async (db: string) => {
          await withAdmin((a) => a.unsafe(`alter database ${db} is_template true`)); // DROP DATABASE refuses a template
        },
      },
    } as Parameters<typeof runDrill>[0]).then((v) => ({ v: v as unknown as Record<string, any>, e: null as unknown }), (e: unknown) => ({ v: null, e }));
    try {
      expect(await dbExists(name), 'setup: the drop must really have failed').toBe(true);
      const failed = res.e !== null || res.v?.ok === false;
      expect(failed, `the run must report failure when the scratch database cannot be dropped: ${JSON.stringify(res.v)}`).toBe(true);
      expect(hbCalls.map((c) => c.name)).toEqual(['start', 'fail']);
      expect(JSON.stringify(res.v) + String((res.e as Error | null)?.message ?? '')).toMatch(/drop/i);
    } finally {
      await withAdmin(async (a) => {
        await a.unsafe(`alter database ${name} is_template false`).catch(() => {});
        await a.unsafe(`drop database if exists ${name} with (force)`).catch(() => {});
      });
    }
  });

  it('4. the expected size from the manifest (sourceDatabaseBytes) is logged BEFORE the restore; a manifest without it is refused', async () => {
    const MARK = 987654321;
    const store = await cloneStore(baseStore);
    await editManifest(store, (m) => { m.sourceDatabaseBytes = MARK; });
    let out = '';
    let outAtRestore = '';
    const so = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => ((out += String(c)), true)) as never);
    try {
      const o = await rawDrill(store, newTargetName('size'), { afterRestore: async () => { outAtRestore = out; } });
      expect(o.ok, o.text).toBe(true);
    } finally {
      so.mockRestore();
    }
    expect(outAtRestore, 'the expected size must already be in the log when the restore has finished').toMatch(/987[,_ ]?654[,_ ]?321/);

    const bad = await cloneStore(baseStore);
    await editManifest(bad, (m) => { delete m.sourceDatabaseBytes; });
    const name = newTargetName('nosize');
    const restored = vi.fn();
    const o2 = await rawDrill(bad, name, { afterRestore: async () => { restored(); } });
    expect(o2.ok).toBe(false);
    expect(o2.text).toMatch(/sourceDatabaseBytes|size/i);
    expect(restored).not.toHaveBeenCalled();
    expect(await dbExists(name)).toBe(false);
  });

  it('7. a manifest missing orgTotals or rowCounts fails with "manifest is incomplete", not "could not read the restored database"', async () => {
    for (const field of ['orgTotals', 'rowCounts'] as const) {
      const store = await cloneStore(baseStore);
      await editManifest(store, (m) => { delete m.fingerprint[field]; });
      const o = await rawDrill(store, newTargetName('inc'));
      expect(o.ok, `${field} missing must fail`).toBe(false);
      expect(o.text, field).toMatch(/manifest is incomplete/i);
      expect(o.text, field).not.toMatch(/could not read the restored/i);
      expect(o.text, field).toContain(field);
    }
  });
});
