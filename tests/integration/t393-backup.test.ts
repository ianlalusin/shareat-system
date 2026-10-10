import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * T-393 S1 - nightly backup. `docs/tasks/393-nightly-backup-and-restore.md` R1-R3, R6, R7, R9, I1-I3, I8, I9, I11,
 * tests 9-15 and 15a. Written TESTER-FIRST: red with "Cannot find module scripts/lib/backup/object-store" until the
 * builder lands the modules.
 *
 * Real Postgres (5435), real `pg_dump` / `pg_restore` / `pg_dumpall` (PG18 client; `PG_BIN_DIR` or PATH - a missing
 * binary FAILS, it never skips), `fsStore(tmpdir)` standing in for Spaces, a recording fake for the heartbeat. The
 * source is the test database, seeded through the REAL `postEntry` for TWO orgs so the trial balance is not empty.
 *
 * Contract choices the spec leaves open, fixed here and flagged in the hand-back:
 *  - `runBackup` REJECTS on failure (spec: "heartbeat fail, remove the temp file, rethrow").
 *  - Manifest field names are read leniently: size = `size` | `bytes` | `byteSize`; `sha256`; `rolesKey` | `roles.key`.
 *    `fingerprint` is exactly the spec's `Fingerprint` interface. The manifest KEY must match the I5 pattern
 *    (`...Z.manifest.json`), otherwise retention could never delete it.
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
import type { Heartbeat } from '../../scripts/lib/backup/heartbeat';

const sql = postgres(adminUrl, { max: 4, onnotice: () => {} });
const sourceDbName = decodeURIComponent(new URL(adminUrl).pathname.slice(1));

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

const PG_WIN = 'C:/Program Files/PostgreSQL/18/bin';
function pgBin(name: 'pg_dump' | 'pg_restore' | 'pg_dumpall' | 'psql'): string {
  const dir = process.env.PG_BIN_DIR;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return dir ? path.join(dir, exe) : exe;
}
const pgEnv = (url: string) => ({ ...process.env, PGPASSWORD: decodeURIComponent(new URL(url).password) });
const connArgs = (url: string) => {
  const u = new URL(url);
  return ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username)];
};

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const sha256File = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

const dirs: string[] = [];
const freshDir = (label: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `t393-${label}-`));
  dirs.push(d);
  return d;
};

type Call = { name: 'start' | 'ok' | 'fail'; arg?: string };
function fakeHeartbeat(opts: { throws?: boolean } = {}): Heartbeat & { calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: Call['name']) => async (arg?: string) => {
    calls.push({ name, arg });
    if (opts.throws) throw new Error('heartbeat endpoint is down');
  };
  return { calls, start: rec('start'), ok: rec('ok'), fail: rec('fail') } as Heartbeat & { calls: Call[] };
}

/** Wraps a store: records an ordered event log, can fail chosen puts, and counts deletes. */
function recordingStore(inner: ObjectStore, failPut?: (key: string, nth: number) => boolean) {
  const events: string[] = [];
  let nth = 0;
  const store: ObjectStore = {
    async put(key, file, meta) {
      nth += 1;
      if (failPut?.(key, nth)) {
        events.push(`putfail:${key}`);
        throw new Error('injected put failure');
      }
      await inner.put(key, file, meta);
      events.push(`put:${key}`);
    },
    head: (k) => inner.head(k),
    list: (p) => inner.list(p),
    get: (k, f) => inner.get(k, f),
    async delete(keys) {
      events.push(`delete:${keys.join('\n')}`);
      await inner.delete(keys);
    },
  };
  const deletedKeys = () => events.filter((e) => e.startsWith('delete:')).flatMap((e) => e.slice(7).split('\n')).filter(Boolean);
  return { store, events, deletedKeys };
}

const NOW = new Date('2026-10-10T20:30:00Z'); // 04:30 Manila on 2026-10-11: the Manila date is NOT the UTC date
const MANILA_DATE = '2026-10-11';
const I5 = /^postgres\/daily\/\d{4}-\d{2}-\d{2}\/shareat-\d{8}T\d{6}Z\.(dump|manifest\.json|roles\.sql)$/;

async function listAll(store: ObjectStore): Promise<string[]> {
  return (await store.list('postgres/')).map((o) => o.key).sort();
}
async function readManifest(store: ObjectStore, key: string): Promise<Record<string, any>> {
  const f = path.join(freshDir('mf'), 'm.json');
  await store.get(key, f);
  return JSON.parse(readFileSync(f, 'utf8'));
}
const sizeOf = (m: Record<string, any>): number => Number(m.size ?? m.bytes ?? m.byteSize);
const sha256Of = (m: Record<string, any>): string => String(m.sha256 ?? m.dump?.sha256);
const rolesKeyOf = (m: Record<string, any>): string => String(m.rolesKey ?? m.roles?.key);

/** Seeds `n` old, COMPLETE (dump + manifest) dated dumps so a prune has real work to do. */
async function seedOldDumps(store: ObjectStore, n: number, startDate = '2025-01-01'): Promise<string[]> {
  const f = path.join(freshDir('seed'), 'x');
  writeFileSync(f, 'x');
  const dumps: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.parse(`${startDate}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const stem = `postgres/daily/${d}/shareat-${d.replace(/-/g, '')}T193000Z`;
    await store.put(`${stem}.dump`, f, {});
    await store.put(`${stem}.manifest.json`, f, {});
    await store.put(`${stem}.roles.sql`, f, {});
    dumps.push(`${stem}.dump`);
  }
  return dumps;
}

/** Captures everything written to stdout/stderr (and so every console.*) while `fn` runs. */
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

/** Scratch databases this file creates. The name MUST pass the drill pattern; every one is dropped in afterAll. */
const scratchDbs: string[] = [];
async function createScratch(label: string): Promise<string> {
  const name = `shareat_test_drill_${label}${randomBytes(3).toString('hex')}`;
  expect(name).toMatch(/^shareat_(restore_drill|test_drill_[a-z0-9]+)$/);
  const admin = postgres(urlFor('postgres'), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  scratchDbs.push(name);
  return name;
}
async function dropScratch(name: string): Promise<void> {
  if (!/^shareat_(restore_drill|test_drill_[a-z0-9]+)$/.test(name)) throw new Error(`refusing to drop ${name}`);
  const admin = postgres(urlFor('postgres'), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
function restoreInto(db: string, dumpFile: string, extra: string[] = []) {
  const url = urlFor(db);
  const r = spawnSync(
    pgBin('pg_restore'),
    [...connArgs(url), '-d', db, '--no-owner', '--no-acl', '--exit-on-error', ...extra, dumpFile],
    { env: pgEnv(url), encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`pg_restore into ${db} failed (${r.status}): ${r.stderr}`);
}

interface TbRow { org: string; account: string; d: string; c: string; n: string }
const money = (x: string | number) => Number(x).toFixed(2);
async function tbOf(db: postgres.Sql): Promise<TbRow[]> {
  const rows = await db<{ org: string; account: string; d: string; c: string; n: string }[]>`
    select org_id::text as org, account_id::text as account,
           sum(debit_total)::text as d, sum(credit_total)::text as c, sum(net_balance)::text as n
    from v_trial_balance group by org_id, account_id order by org_id, account_id`;
  return rows.map((r) => ({ org: r.org, account: r.account, d: money(r.d), c: money(r.c), n: money(r.n) }));
}
const tbOfManifest = (m: Record<string, any>): TbRow[] =>
  (m.fingerprint.trialBalance as { orgId: string; accountId: string; debit: string; credit: string; net: string }[])
    .map((r) => ({ org: r.orgId, account: r.accountId, d: money(r.debit), c: money(r.credit), n: money(r.net) }))
    .sort((a, b) => (a.org + a.account).localeCompare(b.org + b.account));

// ---------------------------------------------------------------------------------------------- seeding

let orgA = '';
let orgB = '';

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
    idempotencyKey: `t393:${tag}:${fx.id}`,
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
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`T393 ${code}`}, ${code}) returning id`;
    await seedChartOfAccounts(sql, o!.id);
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      select ${o!.id}, m::date, (m + interval '1 month - 1 day')::date, 'open'
      from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;
    return o!.id;
  };
  orgA = await mkOrg('t393-org-a');
  orgB = await mkOrg('t393-org-b');
  await postFixture(orgA, 'expense.cash.simple', 'a');
  await postFixture(orgA, 'expense.split.cash-online', 'a');
  await postFixture(orgA, 'expense.credit.ap', 'a');
  await postFixture(orgB, 'expense.cash.simple', 'b');
  await postFixture(orgB, 'expense.split.cash-online', 'b');
}, 120_000);

afterAll(async () => {
  for (const name of scratchDbs) await dropScratch(name).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await closeDb();
  await sql.end({ timeout: 5 });
});

const baseDeps = (store: ObjectStore, heartbeat: Heartbeat, tmpDir: string) => ({
  store, sourceUrl: adminUrl, heartbeat, now: () => NOW, tmpDir,
});

// ---------------------------------------------------------------------------------------------- tests

describe('T-393 S1 - runBackup', () => {
  it('9. happy path: one dump + one roles file + one manifest under the Manila date; manifest matches the file; fingerprint covers both orgs', async () => {
    const root = freshDir('store');
    const tmpDir = freshDir('tmp');
    const store = fsStore(root);
    const hb = fakeHeartbeat();

    await runBackup(baseDeps(store, hb, tmpDir));

    const keys = await listAll(store);
    expect(keys).toHaveLength(3);
    const dump = keys.filter((k) => k.endsWith('.dump'));
    const roles = keys.filter((k) => k.endsWith('.roles.sql'));
    const manifests = keys.filter((k) => k.endsWith('.manifest.json'));
    expect(dump).toHaveLength(1);
    expect(roles).toHaveLength(1);
    expect(manifests).toHaveLength(1);
    // Manila business date in the directory, UTC stamp in the name (R4).
    expect(dump[0]).toBe(`postgres/daily/${MANILA_DATE}/shareat-20261010T203000Z.dump`);
    expect(manifests[0]).toMatch(I5); // deletable by retention, so the manifest key must fit the I5 shape
    expect(roles[0]!.startsWith(`postgres/daily/${MANILA_DATE}/`)).toBe(true);

    const m = await readManifest(store, manifests[0]!);
    const localDump = path.join(freshDir('dl'), 'd.dump');
    await store.get(dump[0]!, localDump);
    expect(sha256Of(m)).toBe(sha256File(localDump));
    expect(sizeOf(m)).toBe(statSync(localDump).size);
    expect(rolesKeyOf(m)).toBe(roles[0]);

    const fp = m.fingerprint;
    const orgs = fp.orgTotals.map((o: { orgId: string }) => o.orgId);
    expect(orgs).toEqual(expect.arrayContaining([orgA, orgB]));
    for (const o of fp.orgTotals as { debit: string; credit: string }[]) {
      expect(money(o.debit)).toBe(money(o.credit));
      expect(Number(o.debit)).toBeGreaterThan(0);
    }
    const tbOrgs = new Set((fp.trialBalance as { orgId: string }[]).map((r) => r.orgId));
    expect(tbOrgs.has(orgA) && tbOrgs.has(orgB)).toBe(true);
    expect(fp.rowCounts['public.organizations']).toBeGreaterThanOrEqual(2);
    expect(fp.rowCounts['public.journal_lines']).toBeGreaterThanOrEqual(10);
    expect(Object.keys(fp.rowCounts).some((k) => k.startsWith('drizzle.'))).toBe(true);

    expect(hb.calls.map((c) => c.name)).toEqual(['start', 'ok']);
    expect(readdirSync(tmpDir)).toEqual([]); // temp files removed

    // R13/I9: no secret in the manifest; the roles file carries no password hashes.
    const password = decodeURIComponent(new URL(adminUrl).password);
    expect(JSON.stringify(m)).not.toContain(password);
    expect(JSON.stringify(m)).not.toMatch(/postgres(ql)?:\/\//);
    const rolesLocal = path.join(freshDir('dl'), 'r.sql');
    await store.get(roles[0]!, rolesLocal);
    const rolesText = readFileSync(rolesLocal, 'utf8');
    expect(rolesText).toMatch(/CREATE ROLE/);
    expect(rolesText).not.toMatch(/SCRAM-SHA-256\$/);
  });

  it('10. same snapshot (I1): a balanced entry committed between fingerprint and pg_dump is in NEITHER; a plain pg_restore ties to the manifest', async () => {
    const store = fsStore(freshDir('store'));
    const before = await tbOf(sql);
    let injected = false;

    await runBackup({
      ...baseDeps(store, fakeHeartbeat(), freshDir('tmp')),
      hooks: {
        afterFingerprint: async () => {
          await postAsOrg(orgA, {
            entryDate: '2026-02-03',
            sourceType: 'expense_payment',
            sourceId: 'snapshot-probe',
            idempotencyKey: `t393:snapshot-probe:${randomBytes(4).toString('hex')}`,
            memo: 'committed after the fingerprint, before pg_dump',
            lines: [
              { accountCode: '5100', debit: '777.77', partyType: null, partyId: null, storeId: null, channelId: null, lineMemo: null },
              { accountCode: '1110', credit: '777.77', partyType: null, partyId: null, storeId: null, channelId: null, lineMemo: null },
            ],
          });
          injected = true;
        },
      },
    });
    expect(injected, 'the afterFingerprint hook must run').toBe(true);

    const after = await tbOf(sql);
    expect(after).not.toEqual(before); // the live ledger moved, so this test can tell the difference

    const keys = await listAll(store);
    const m = await readManifest(store, keys.find((k) => k.endsWith('.manifest.json'))!);
    expect(tbOfManifest(m)).toEqual(before); // the manifest is the ledger as of the snapshot

    const scratch = await createScratch('snap');
    const dl = path.join(freshDir('dl'), 'd.dump');
    await store.get(keys.find((k) => k.endsWith('.dump'))!, dl);
    restoreInto(scratch, dl);
    const restoredDb = postgres(urlFor(scratch), { max: 1, onnotice: () => {} });
    try {
      expect(await tbOf(restoredDb)).toEqual(tbOfManifest(m)); // dump and manifest are ONE snapshot
    } finally {
      await restoredDb.end({ timeout: 5 });
      await dropScratch(scratch);
    }
  });

  it('11. manifest last (R3, I3): a failed manifest put leaves no manifest, rejects, sends fail, and deletes NOTHING', async () => {
    const inner = fsStore(freshDir('store'));
    await seedOldDumps(inner, 50);
    const rec = recordingStore(inner, (key) => key.endsWith('.manifest.json') && key.includes(`/${MANILA_DATE}/`));
    const hb = fakeHeartbeat();

    await expect(runBackup(baseDeps(rec.store, hb, freshDir('tmp')))).rejects.toThrow();

    const tonight = (await listAll(inner)).filter((k) => k.includes(`/${MANILA_DATE}/`));
    expect(tonight.some((k) => k.endsWith('.manifest.json'))).toBe(false);
    expect(rec.deletedKeys()).toEqual([]);
    expect(hb.calls.map((c) => c.name)).toEqual(['start', 'fail']);
  });

  it('11b. a failed SECOND put (the roles file or the dump) also rejects, sends fail, writes no manifest and deletes nothing', async () => {
    const inner = fsStore(freshDir('store'));
    await seedOldDumps(inner, 50);
    // The seeding above went straight to `inner`, so `nth` here counts only this run's puts.
    const rec = recordingStore(inner, (_key, nth) => nth === 2);
    const hb = fakeHeartbeat();

    await expect(runBackup(baseDeps(rec.store, hb, freshDir('tmp')))).rejects.toThrow();

    const tonight = (await listAll(inner)).filter((k) => k.includes(`/${MANILA_DATE}/`));
    expect(tonight.some((k) => k.endsWith('.manifest.json'))).toBe(false);
    expect(rec.deletedKeys()).toEqual([]);
    expect(hb.calls.map((c) => c.name)).toEqual(['start', 'fail']);
  });

  it('12. corrupt archive (R6): a dump that passes `pg_restore --list` but fails the full read uploads nothing and fails the run', async () => {
    const store = fsStore(freshDir('store'));
    const hb = fakeHeartbeat();
    const probeDir = freshDir('probe');
    let usedFraction = 0;

    await expect(
      runBackup({
        ...baseDeps(store, hb, freshDir('tmp')),
        hooks: {
          // The spec says "about 90%". On the real PG18 client a custom-format archive cut that deep no longer
          // lists either, so a `--list`-only check would also reject it and the mutant would survive. Search for the
          // deepest cut that `--list` ACCEPTS and the full read REJECTS, assert one exists, and apply it.
          afterDump: async (file: string) => {
            const buf = readFileSync(file);
            const probe = path.join(probeDir, 'p.dump');
            for (const frac of [0.9995, 0.999, 0.998, 0.995, 0.99, 0.98, 0.97, 0.95]) {
              writeFileSync(probe, buf.subarray(0, Math.floor(buf.length * frac)));
              const list = spawnSync(pgBin('pg_restore'), ['--list', probe], { encoding: 'utf8' });
              const full = spawnSync(pgBin('pg_restore'), ['-f', NULL_DEVICE, probe], { encoding: 'utf8' });
              if (list.status === 0 && full.status !== 0) {
                writeFileSync(file, buf.subarray(0, Math.floor(buf.length * frac)));
                usedFraction = frac;
                return;
              }
            }
            throw new Error('TEST PRECONDITION: no truncation of this dump passes --list but fails the full read');
          },
        },
      }),
    ).rejects.toThrow();

    expect(usedFraction, 'the hook must have produced a list-passing, read-failing archive').toBeGreaterThan(0);
    expect(await listAll(store)).toEqual([]); // nothing uploaded, not even a bare dump
    expect(hb.calls.map((c) => c.name)).toEqual(['start', 'fail']);
  });

  it('13. bad credentials: the run fails and the password is in no log line, thrown message or heartbeat reason (I9)', async () => {
    const badPassword = 'wr0ng-pw-t393-Zq';
    const u = new URL(adminUrl);
    u.password = badPassword;
    const hb = fakeHeartbeat();
    const store = fsStore(freshDir('store'));

    const { out, result } = await captureOutput(() =>
      runBackup({ ...baseDeps(store, hb, freshDir('tmp')), sourceUrl: u.toString() }),
    );

    expect(result.ok).toBe(false);
    const thrown = result.ok ? '' : String((result.error as Error)?.message ?? result.error) + String((result.error as Error)?.stack ?? '');
    const reasons = hb.calls.map((c) => c.arg ?? '').join('\n');
    for (const channel of [out, thrown, reasons]) {
      expect(channel).not.toContain(badPassword);
      expect(channel).not.toContain(encodeURIComponent(badPassword));
    }
    expect(hb.calls.map((c) => c.name)).toEqual(['start', 'fail']);
    expect(await listAll(store)).toEqual([]);
  });

  it('14. heartbeat down (I8): every heartbeat call throws and the backup still succeeds', async () => {
    const store = fsStore(freshDir('store'));
    const hb = fakeHeartbeat({ throws: true });

    await runBackup(baseDeps(store, hb, freshDir('tmp')));

    expect((await listAll(store)).filter((k) => k.endsWith('.manifest.json'))).toHaveLength(1);
    expect(hb.calls.length).toBeGreaterThanOrEqual(2); // it did try
  });

  it('15. prune runs only on success: with 50 old dumps a good night deletes 1-10 (after the manifest), a failed night deletes 0', async () => {
    const innerOk = fsStore(freshDir('store'));
    const seeded = await seedOldDumps(innerOk, 50);
    // Things a prune must never touch.
    const f = path.join(freshDir('seed'), 'x');
    writeFileSync(f, 'x');
    const keepers = ['postgres/pinned/cutover-eve.dump', 'postgres/drills/2026-10-04.json', 'backups/site-frappe.tar.gz'];
    for (const k of keepers) await innerOk.put(k, f, {});
    const ok = recordingStore(innerOk);

    await runBackup(baseDeps(ok.store, fakeHeartbeat(), freshDir('tmp')));

    const deleted = ok.deletedKeys();
    const deletedDumps = deleted.filter((k) => k.endsWith('.dump'));
    expect(deletedDumps.length).toBeGreaterThanOrEqual(1);
    expect(deletedDumps.length).toBeLessThanOrEqual(10);
    for (const k of deleted) expect(k, `${k} is outside I5`).toMatch(I5);
    for (const k of deletedDumps) {
      expect(seeded).toContain(k); // only the old seeded ones, never tonight's
      expect(deleted).toContain(k.replace(/\.dump$/, '.roles.sql')); // the stem's roles file goes too
      expect(await innerOk.head(k.replace(/\.dump$/, '.roles.sql'))).toBeNull();
    }
    for (const k of keepers) expect(await innerOk.head(k), `${k} must survive`).not.toBeNull();
    // I3: every delete comes after tonight's manifest was written.
    const manifestAt = ok.events.findIndex((e) => e.startsWith('put:') && e.endsWith('.manifest.json') && e.includes(`/${MANILA_DATE}/`));
    const firstDeleteAt = ok.events.findIndex((e) => e.startsWith('delete:'));
    expect(manifestAt).toBeGreaterThanOrEqual(0);
    expect(firstDeleteAt).toBeGreaterThan(manifestAt);

    // A failed night (dump stage throws) deletes nothing.
    const innerBad = fsStore(freshDir('store'));
    await seedOldDumps(innerBad, 50);
    const bad = recordingStore(innerBad);
    await expect(
      runBackup({
        ...baseDeps(bad.store, fakeHeartbeat(), freshDir('tmp')),
        hooks: { afterDump: async () => { throw new Error('simulated dump-stage failure'); } },
      }),
    ).rejects.toThrow();
    expect(bad.deletedKeys()).toEqual([]);
  });

  it('4. prune failure AFTER a verified upload: logged, heartbeat ok, run resolves (the backup is good)', async () => {
    const inner = fsStore(freshDir('store'));
    await seedOldDumps(inner, 50);
    const base = recordingStore(inner);
    const store: ObjectStore = { ...base.store, delete: async () => { throw new Error('simulated Spaces delete outage'); } };
    const hb = fakeHeartbeat();

    const { out, result } = await captureOutput(() => runBackup(baseDeps(store, hb, freshDir('tmp'))));

    expect(result.ok, result.ok ? '' : String(result.error)).toBe(true);
    expect(hb.calls.map((c) => c.name)).toEqual(['start', 'ok']);
    expect((await listAll(inner)).filter((k) => k.includes(`/${MANILA_DATE}/`)).some((k) => k.endsWith('.manifest.json'))).toBe(true);
    expect(out).toMatch(/prune/i);
    expect(out).toMatch(/fail|error|outage/i);
  });

  it('15a-1. privilege (I11): a role with neither rolbypassrls nor rolsuper is refused BEFORE pg_dump, with no object written', async () => {
    const [role] = await sql<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = ${RESTRICTED_TEST_ROLE}`;
    expect(role, `role ${RESTRICTED_TEST_ROLE} must exist`).toBeDefined();
    expect(role!.rolbypassrls || role!.rolsuper).toBe(false);

    const store = fsStore(freshDir('store'));
    const hb = fakeHeartbeat();
    const afterDump = vi.fn(async () => {});

    const restrictedUrl = urlFor(sourceDbName, { name: RESTRICTED_TEST_ROLE, password: RESTRICTED_TEST_PASSWORD });
    const err = await runBackup({
      ...baseDeps(store, hb, freshDir('tmp')),
      sourceUrl: restrictedUrl,
      hooks: { afterDump },
    }).then(() => null, (e: unknown) => e);

    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toMatch(/rolbypassrls|rolsuper|bypass/i); // refused for the privilege, not for some later reason
    expect(afterDump).not.toHaveBeenCalled(); // no dump was ever taken
    expect(await listAll(store)).toEqual([]);
    expect(hb.calls.map((c) => c.name)).toEqual(['start', 'fail']);
  });

  it('15a-2. empty ledger (I11): a superuser against a database with no orgs, then orgs but zero journal lines, writes NO manifest', async () => {
    const scratch = await createScratch('empty');
    const schemaDump = path.join(freshDir('dl'), 'schema.dump');
    const d = spawnSync(
      pgBin('pg_dump'),
      [...connArgs(adminUrl), '-d', sourceDbName, '-Fc', '--schema-only', '-f', schemaDump],
      { env: pgEnv(adminUrl), encoding: 'utf8' },
    );
    expect(d.status, d.stderr).toBe(0);
    restoreInto(scratch, schemaDump);
    const scratchUrl = urlFor(scratch);
    const store = fsStore(freshDir('store'));

    // (a) no organisations at all.
    const hbA = fakeHeartbeat();
    const errA = await runBackup({ ...baseDeps(store, hbA, freshDir('tmp')), sourceUrl: scratchUrl }).then(() => null, (e: unknown) => e);
    expect(errA, 'zero orgs must be refused').not.toBeNull();
    expect(await listAll(store)).toEqual([]);
    expect(hbA.calls.map((c) => c.name)).toEqual(['start', 'fail']);

    // (b) an organisation, but no journal lines.
    const db = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    try {
      await db`insert into organizations (name, code) values ('Empty ledger org', 't393-empty')`;
    } finally {
      await db.end({ timeout: 5 });
    }
    const hbB = fakeHeartbeat();
    const errB = await runBackup({ ...baseDeps(store, hbB, freshDir('tmp')), sourceUrl: scratchUrl }).then(() => null, (e: unknown) => e);
    expect(errB, 'orgs with zero journal lines must be refused').not.toBeNull();
    expect(String((errB as Error).message)).toMatch(/journal|ledger|empty/i);
    expect((await listAll(store)).filter((k) => k.endsWith('.manifest.json'))).toEqual([]);
    expect(await listAll(store)).toEqual([]); // refused before pg_dump, so not even a dump
    expect(hbB.calls.map((c) => c.name)).toEqual(['start', 'fail']);

    await dropScratch(scratch);
  });
});
