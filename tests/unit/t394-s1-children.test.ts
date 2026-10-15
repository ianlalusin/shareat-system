import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CUTOVER_CLASSIFICATION } from '../../packages/db/src/cutover/classification';
import { runMigrateChild, runPredumpChild, runPurgeChildren, type SpawnCall } from '../../scripts/lib/rehearsal/children';

/**
 * T-394 S1 invariants 3 (purge refuses on a live session), 4 and 4a (argv + env of every child; docs/tasks/
 * 394-purge-and-opening-rehearsal.md s4 R4, R5, R12, s6). Written TESTER-FIRST: red with "Cannot find module
 * scripts/lib/rehearsal/children" until the builder lands S1. A spawn FAKE records every call; nothing is run.
 *
 * ## Contract choices the spec leaves open (flagged in the hand-back)
 *  - children.ts exports `SpawnCall = { command: string; args: string[]; env: Record<string, string | undefined> }` and three
 *    functions taking the PARENT env explicitly (never process.env), a `confirmDatabase`, and an injected `spawn`:
 *      runPurgeChildren({ env, confirmDatabase, by, spawn, liveness })
 *      runMigrateChild({ env, confirmDatabase, spawn })
 *      runPredumpChild({ env, confirmDatabase, dir, spawn })
 *    `spawn(call) => Promise<{ code: number }>`; `liveness() => Promise<{ ok: boolean; message?: string }>` (guard e, called once,
 *    by purge only here; the real one wraps checks.checkLiveness). All resolve `{ ok, code, ran }`: code 0 pass, 1 a child
 *    failed, 2 refused by a guard (then ran === 0 and spawn was never called). The target is read from env.REHEARSAL_DATABASE_URL
 *    and passes guards (a)-(d) inside each function.
 *  - The purge script is identified by the path scripts/cutover-purge.ts (or the npm script cutover:purge) in args; the flags
 *    are the tail from '--confirm-database'. The migrate child by 'db:migrate'; the predump child by 'db-backup'.
 */

const DB = 'shareat_rehearsal_20261113';
const TARGET = `postgresql://tester:pw1@localhost:5435/${DB}`;
const DECOY_APP = 'postgresql://app:pw2@localhost:5435/shareat_test_decoy_app';
const DECOY_SYS = 'postgresql://sys:pw3@localhost:5435/shareat_test_decoy_sys';
const DECOY_TEST = 'postgresql://tst:pw4@localhost:5435/shareat_test_decoy_tst';
const PARENT = {
  PATH: '/usr/bin',
  REHEARSAL_DATABASE_URL: TARGET,
  DATABASE_URL: DECOY_APP,
  SYSTEM_DATABASE_URL: DECOY_SYS,
  TEST_DATABASE_URL: DECOY_TEST,
  BACKUP_HEARTBEAT_URL: 'https://hc-ping.example/backup-uuid',
  SPACES_KEY: 'spaces-key-123',
  SPACES_SECRET: 'spaces-secret-456',
};
const PRODUCTION_MONITOR_KEYS = ['BACKUP_HEARTBEAT_URL', 'SPACES_KEY', 'SPACES_SECRET'] as const;
const KEEP_FROM = (CUTOVER_CLASSIFICATION.fiscal_periods as unknown as { keepFrom: string }).keepFrom;
const BY = '018f0000-0000-7000-8000-000000000001';

function fake(codes: number[] = []) {
  const calls: SpawnCall[] = [];
  const spawn = async (call: SpawnCall): Promise<{ code: number }> => {
    calls.push(call);
    return { code: codes[calls.length - 1] ?? 0 };
  };
  return { calls, spawn };
}
const live = async () => ({ ok: true });

/** Every database URL in a child's env must be the guarded target: no decoy, no other database. */
function urlsOf(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string' && /^postgres(ql)?:\/\//.test(v)) as [string, string][]);
}
const DUMP = '/rehearsal/dir/auditdump';
const tailFromConfirm = (c: SpawnCall): string[] => c.args.slice(c.args.indexOf('--confirm-database'));

describe('T-394 S1 I4 - purge runs the real CLI three times, in order, on the guarded target', () => {
  it('4.a spawns scripts/cutover-purge.ts exactly 3 times: dry run, --rehearse, then --apply --as-of <keepFrom> --by', async () => {
    const f = fake();
    const r = await runPurgeChildren({ env: PARENT, confirmDatabase: DB, by: BY, dumpDir: DUMP, spawn: f.spawn, liveness: live });
    expect(r).toMatchObject({ ok: true, code: 0, ran: 3 });
    expect(f.calls).toHaveLength(3);
    for (const c of f.calls) expect([c.command, ...c.args].join(' ')).toMatch(/scripts[\\/]cutover-purge\.ts|cutover:purge/);
    const base = ['--confirm-database', DB, '--yes-really-not-local'];
    expect(tailFromConfirm(f.calls[0]!)).toEqual(base);
    expect(tailFromConfirm(f.calls[1]!)).toEqual([...base, '--rehearse', '--as-of', KEEP_FROM, '--dump-dir', DUMP]);
    expect(tailFromConfirm(f.calls[2]!)).toEqual([...base, '--apply', '--as-of', KEEP_FROM, '--by', BY, '--dump-dir', DUMP]);
    expect(KEEP_FROM).toBe('2027-01-01');
  });

  it('4.b each child env carries DATABASE_URL = the guarded target and no other database URL (the parent env is not inherited)', async () => {
    const f = fake();
    await runPurgeChildren({ env: PARENT, confirmDatabase: DB, by: BY, dumpDir: DUMP, spawn: f.spawn, liveness: live });
    expect(f.calls).toHaveLength(3);
    for (const c of f.calls) {
      expect(c.env.DATABASE_URL).toBe(TARGET);
      for (const [k, v] of Object.entries(urlsOf(c.env))) expect(v, `${k} must be the target, not a decoy`).toBe(TARGET);
    }
  });

  it('4.c stops at the first non-zero child: a failing --rehearse means no --apply (code 1, ran 2)', async () => {
    const f = fake([0, 3, 0]);
    const r = await runPurgeChildren({ env: PARENT, confirmDatabase: DB, by: BY, dumpDir: DUMP, spawn: f.spawn, liveness: live });
    expect(f.calls).toHaveLength(2);
    expect(r).toMatchObject({ ok: false, code: 1, ran: 2 });
    expect(f.calls.some((c) => c.args.includes('--apply'))).toBe(false);
  });

  it('4.d a failing dry run stops after one child', async () => {
    const f = fake([1]);
    const r = await runPurgeChildren({ env: PARENT, confirmDatabase: DB, by: BY, dumpDir: DUMP, spawn: f.spawn, liveness: live });
    expect(f.calls).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, code: 1, ran: 1 });
  });

  it('4.e a failed guard spawns nothing and exits 2: wrong typed name, bad database name, pinned host, missing REHEARSAL_DATABASE_URL', async () => {
    const pinned = 'postgresql://u:p@shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com:25060/' + DB;
    const cases: [string, Record<string, string>, string][] = [
      ['typed name differs', PARENT, 'shareat_rehearsal_20261114'],
      ['bad database name', { ...PARENT, REHEARSAL_DATABASE_URL: 'postgresql://u:p@localhost:5435/shareat_rehearsal_20261113_prod' }, 'shareat_rehearsal_20261113_prod'],
      ['pinned production host', { ...PARENT, REHEARSAL_DATABASE_URL: pinned }, DB],
      ['no REHEARSAL_DATABASE_URL (DATABASE_URL is never the target)', { ...PARENT, REHEARSAL_DATABASE_URL: '', DATABASE_URL: TARGET }, DB],
    ];
    for (const [label, env, confirm] of cases) {
      const f = fake();
      const r = await runPurgeChildren({ env, confirmDatabase: confirm, by: BY, dumpDir: DUMP, spawn: f.spawn, liveness: live });
      expect(f.calls, `${label}: nothing may be spawned`).toHaveLength(0);
      expect(r, label).toMatchObject({ ok: false, code: 2, ran: 0 });
    }
  });
});

describe('T-394 S1 audit - a rehearsal child never inherits production monitor or storage credentials', () => {
  it('a1. BACKUP_HEARTBEAT_URL, SPACES_KEY and SPACES_SECRET are absent from the env of every purge, migrate and predump child', async () => {
    const all: SpawnCall[] = [];
    for (const run of [
      async (spawn: (c: SpawnCall) => Promise<{ code: number }>) => runPurgeChildren({ env: PARENT, confirmDatabase: DB, by: BY, dumpDir: DUMP, spawn, liveness: live }),
      async (spawn: (c: SpawnCall) => Promise<{ code: number }>) => runMigrateChild({ env: PARENT, confirmDatabase: DB, spawn }),
      async (spawn: (c: SpawnCall) => Promise<{ code: number }>) => runPredumpChild({ env: PARENT, confirmDatabase: DB, dir: 'C:/x', spawn }),
    ]) {
      const f = fake();
      await run(f.spawn);
      all.push(...f.calls);
    }
    expect(all).toHaveLength(5);
    for (const c of all) for (const k of PRODUCTION_MONITOR_KEYS) expect(c.env[k] ?? '', `${k} must not reach a child (unset or blank; blank stops dotenv re-supplying it from .env.local)`).toBe('');
  });
});

describe('T-394 S1 I3 - a live session on the target makes purge refuse', () => {
  it('3.a purge consults liveness before any child, once, and a refusal spawns nothing (exit 2), naming the session', async () => {
    const f = fake();
    let asked = 0;
    const r = await runPurgeChildren({
      env: PARENT,
      confirmDatabase: DB,
      by: BY, dumpDir: DUMP,
      spawn: f.spawn,
      liveness: async () => {
        asked++;
        return { ok: false, message: 'a session is connected: application_name=erp-9008-dev' };
      },
    });
    expect(asked).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: false, code: 2, ran: 0 });
    expect(JSON.stringify(r)).toContain('erp-9008-dev');
  });

  it('3.c liveness is re-checked before EVERY child: a session that connects after the dry run stops the run before --rehearse', async () => {
    const f = fake();
    let asked = 0;
    const r = await runPurgeChildren({
      env: PARENT,
      confirmDatabase: DB,
      by: BY, dumpDir: DUMP,
      spawn: f.spawn,
      liveness: async () => {
        asked++;
        return asked >= 2 ? { ok: false, message: 'late session: application_name=late-app' } : { ok: true };
      },
    });
    expect(f.calls).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, code: 2, ran: 1 });
    expect(JSON.stringify(r)).toContain('late-app');
  });

  it('3.d a session that connects between --rehearse and --apply stops the apply (exit 2, ran 2)', async () => {
    const f = fake();
    let asked = 0;
    const r = await runPurgeChildren({
      env: PARENT,
      confirmDatabase: DB,
      by: BY, dumpDir: DUMP,
      spawn: f.spawn,
      liveness: async () => (++asked >= 3 ? { ok: false, message: 'late' } : { ok: true }),
    });
    expect(f.calls.some((c) => c.args.includes('--apply'))).toBe(false);
    expect(r).toMatchObject({ ok: false, code: 2, ran: 2 });
  });

  it('3.b with no live session the children run (liveness is a gate, not a replacement)', async () => {
    const f = fake();
    const r = await runPurgeChildren({ env: PARENT, confirmDatabase: DB, by: BY, dumpDir: DUMP, spawn: f.spawn, liveness: live });
    expect(r.ran).toBe(3);
  });
});

describe('T-394 S1 I4a - migrate and predump aim their child at the target, explicitly', () => {
  it('4a.a migrate: one child, `db:migrate`, DATABASE_URL = target, no other database URL', async () => {
    const f = fake();
    const r = await runMigrateChild({ env: PARENT, confirmDatabase: DB, spawn: f.spawn });
    expect(r).toMatchObject({ ok: true, code: 0, ran: 1 });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect([c.command, ...c.args].join(' ')).toMatch(/db:migrate/);
    expect(c.env.DATABASE_URL).toBe(TARGET);
    for (const [k, v] of Object.entries(urlsOf(c.env))) expect(v, `${k} must be the target`).toBe(TARGET);
  });

  it('4a.b predump: one child, db-backup --store=fs:<dir>, SYSTEM_DATABASE_URL = target, no other database URL', async () => {
    const f = fake();
    const dir = 'C:/rehearsal-journal/20261113';
    const r = await runPredumpChild({ env: PARENT, confirmDatabase: DB, dir, spawn: f.spawn });
    expect(r).toMatchObject({ ok: true, code: 0, ran: 1 });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect([c.command, ...c.args].join(' ')).toMatch(/db-backup/);
    expect(c.args).toContain(`--store=fs:${dir}`);
    expect(c.env.SYSTEM_DATABASE_URL).toBe(TARGET);
    for (const [k, v] of Object.entries(urlsOf(c.env))) expect(v, `${k} must be the target`).toBe(TARGET);
  });

  it('4a.c migrate and predump refuse a failed guard without spawning (exit 2)', async () => {
    for (const env of [{ ...PARENT, REHEARSAL_DATABASE_URL: DECOY_APP }, { ...PARENT, REHEARSAL_DATABASE_URL: undefined as unknown as string }]) {
      const m = fake();
      expect(await runMigrateChild({ env, confirmDatabase: DB, spawn: m.spawn })).toMatchObject({ ok: false, code: 2, ran: 0 });
      expect(m.calls).toHaveLength(0);
      const p = fake();
      expect(await runPredumpChild({ env, confirmDatabase: DB, dir: 'C:/x', spawn: p.spawn })).toMatchObject({ ok: false, code: 2, ran: 0 });
      expect(p.calls).toHaveLength(0);
    }
  });

  it('4a.d a failing migrate child is code 1', async () => {
    const f = fake([1]);
    expect(await runMigrateChild({ env: PARENT, confirmDatabase: DB, spawn: f.spawn })).toMatchObject({ ok: false, code: 1, ran: 1 });
  });
});

describe('T-394 S1 I4 - the tool has no purge SQL of its own', () => {
  it('4.f no file of the tool contains TRUNCATE or DELETE FROM in code (mutant: a local truncate loop)', () => {
    const root = new URL('../../', import.meta.url);
    const dirPath = fileURLToPath(new URL('scripts/lib/rehearsal/', root));
    const files = [...readdirSync(dirPath).map((n) => path.join(dirPath, n)), fileURLToPath(new URL('scripts/cutover-rehearsal.ts', root))];
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code, f).not.toMatch(/truncate\s|truncate\(|delete\s+from/i);
    }
  });
});
