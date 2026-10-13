import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T-394 S1 - the CLI end to end on REAL local rehearsal databases (invariants 1, 3, 4, 4a, 5, 11; docs/tasks/
 * 394-purge-and-opening-rehearsal.md s4-s6, "S1 orchestrator rulings"). Written TESTER-FIRST: red until
 * scripts/cutover-rehearsal.ts exists ("Cannot find module" / no such file -> every spawn exits non-zero).
 *
 * Databases (localhost only, created AND dropped here, only these three names - ruled 2026-10-14, the name pattern is not
 * injectable): shareat_rehearsal_20991113 (the target), _20991115 (the --against restore), _20991199 (a DECOY that
 * DATABASE_URL / SYSTEM_DATABASE_URL name, which must stay untouched). The lane database is only the admin connection.
 *
 * ## Contract choices the spec leaves open (flagged in the hand-back)
 *  - `npx tsx scripts/cutover-rehearsal.ts <sub> --confirm-database <db> [...]`; env REHEARSAL_DATABASE_URL (target),
 *    REHEARSAL_DIR (journal + predump), and for rollback-check `--against <ENV_NAME>` where ENV_NAME holds the URL.
 *  - Exit 0 pass, 1 a check failed, 2 refused by a guard; the refusal/failure text goes to stdout or stderr (both are searched).
 *  - `start` writes at least one file into REHEARSAL_DIR (the journal); `predump` leaves a *.dump and its *.manifest.json there.
 *  - `purge --by <personId>` (one org on the target).
 */

config({ path: '.env.local' });
const laneUrl = process.env.TEST_DATABASE_URL;
if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(laneUrl)) {
  throw new Error(`Refusing to run against ${laneUrl.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}
if (!['localhost', '127.0.0.1'].includes(new URL(laneUrl).hostname)) throw new Error('T-394 S1 CLI tests run on localhost only.');

import { buildPgArgs, resolvePgBin, runTool } from '../../scripts/lib/backup/pg-tools';

const TARGET_DB = 'shareat_rehearsal_20991113';
const AGAINST_DB = 'shareat_rehearsal_20991115';
const DECOY_DB = 'shareat_rehearsal_20991199';
const OWN_DBS = [TARGET_DB, AGAINST_DB, DECOY_DB] as const;
const urlFor = (db: string): string => {
  const u = new URL(laneUrl);
  u.pathname = `/${db}`;
  return u.toString();
};
const admin = postgres(laneUrl, { max: 1, onnotice: () => {} });
const repoRoot = path.resolve(__dirname, '../..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PINNED = 'shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com';
let dir: string;
let personId = '';

function cli(sub: string[], envOver: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    REHEARSAL_DATABASE_URL: urlFor(TARGET_DB),
    REHEARSAL_DIR: dir,
    DATABASE_URL: urlFor(DECOY_DB),
    SYSTEM_DATABASE_URL: urlFor(DECOY_DB),
    T394_AGAINST_URL: urlFor(AGAINST_DB),
    ...envOver,
  };
  const r = spawnSync(process.execPath, [tsxCli, 'scripts/cutover-rehearsal.ts', ...sub], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 580_000,
    env: env as NodeJS.ProcessEnv,
  });
  return { status: r.status, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}
const withDb = (sub: string, db = TARGET_DB, more: string[] = []) => [sub, '--confirm-database', db, ...more];

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((n) => {
    const p = path.join(root, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

async function dropOwn(): Promise<void> {
  for (const db of OWN_DBS) await admin.unsafe(`drop database if exists "${db}" with (force)`);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 't394-s1-cli-'));
  await dropOwn();
  for (const db of OWN_DBS) await admin.unsafe(`create database "${db}"`);
}, 120_000);

afterAll(async () => {
  try {
    await dropOwn();
  } finally {
    await admin.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

describe('T-394 S1 I1 - the CLI refuses with exit 2 before touching anything', () => {
  const pinnedUrl = `postgresql://u:p@${PINNED}:25060/${TARGET_DB}`;
  const cases: [string, string[], Record<string, string | undefined>][] = [
    ['typed name differs', withDb('start', 'shareat_rehearsal_20991114'), {}],
    ['name not anchored', withDb('start', `${TARGET_DB}_prod`), { REHEARSAL_DATABASE_URL: urlFor(`${TARGET_DB}_prod`) }],
    ['pinned production host', withDb('start'), { REHEARSAL_DATABASE_URL: pinnedUrl }],
    ['target only in DATABASE_URL', withDb('start'), { REHEARSAL_DATABASE_URL: undefined, DATABASE_URL: urlFor(TARGET_DB) }],
    ['target equals DATABASE_URL', withDb('start'), { DATABASE_URL: urlFor(TARGET_DB) }],
    ['target equals SYSTEM_DATABASE_URL', withDb('start'), { SYSTEM_DATABASE_URL: urlFor(TARGET_DB) }],
    ['production host added by PRODUCTION_DB_HOSTS', withDb('start'), { PRODUCTION_DB_HOSTS: 'localhost' }],
  ];
  for (const sub of ['start', 'migrate', 'predump', 'purge'] as const) {
    it(`1.cli.${sub} refuses every bad target with exit 2`, () => {
      for (const [label, args, env] of cases) {
        const a = [sub, ...args.slice(1)];
        if (sub === 'purge') a.push('--by', '00000000-0000-0000-0000-000000000000');
        const r = cli(a, env);
        expect(r.status, `${sub} / ${label}\n${r.text.slice(-400)}`).toBe(2);
        expect(r.text).not.toContain('p@'); // no connection string with its password
      }
    });
  }
});

describe('T-394 S1 I4a - migrate aims its child at the target, not at the environment', () => {
  it('4a.cli migrate advances the target\'s drizzle journal and leaves the DECOY named by DATABASE_URL empty', async () => {
    const r = cli(withDb('migrate'));
    expect(r.status, r.text.slice(-600)).toBe(0);
    const t = postgres(urlFor(TARGET_DB), { max: 1, onnotice: () => {} });
    const d = postgres(urlFor(DECOY_DB), { max: 1, onnotice: () => {} });
    try {
      const [{ n }] = await t<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(n).toBeGreaterThan(100);
      const decoyHas = await d<{ s: string }[]>`select nspname as s from pg_namespace where nspname in ('drizzle', 'public') and exists (select 1 from pg_class c where c.relnamespace = pg_namespace.oid and c.relkind = 'r')`;
      expect(decoyHas, 'the decoy must hold no table at all').toEqual([]);
    } finally {
      await t.end({ timeout: 5 });
      await d.end({ timeout: 5 });
    }
  }, 600_000);
});

describe('T-394 S1 I3, I4, I5 - start / predump / purge on the migrated copy', () => {
  async function seed(): Promise<void> {
    const s = postgres(urlFor(TARGET_DB), { max: 1, onnotice: () => {} });
    try {
      const [o] = await s<{ id: string }[]>`insert into organizations (name, code) values ('Rehearsal Org', 't394cli') returning id`;
      const orgId = o!.id;
      const [p] = await s<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Performer') returning id`;
      personId = p!.id;
      await s`insert into stores (org_id, code, name, stock_model) values (${orgId}, 'T394', 'Fixture store', 'multi_room')`;
      const acct = async (code: string, type: string, normal: string): Promise<string> =>
        (
          await s<{ id: string }[]>`
            insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
            values (${orgId}, ${code}, ${code}, ${type}, ${normal}, true, true, 'active') returning id`
        )[0]!.id;
      const cash = await acct('1110', 'asset', 'debit');
      const income = await acct('4100', 'income', 'credit');
      await s`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-12-01', '2026-12-31', 'open')`;
      await s`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
        from generate_series('2027-01-01'::date, '2028-12-01'::date, '1 month') d`;
      const [period] = await s<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on = '2026-12-01'`;
      await s.begin(async (tx) => {
        const [e] = await tx<{ id: string }[]>`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, status)
          values (${orgId}, '2026-12-10', ${period!.id}, 'manual_journal', ${crypto.randomUUID()}, ${crypto.randomUUID()}, 't394 cli', 'draft')
          returning id`;
        await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 1, ${cash}, '100.00', 0)`;
        await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 2, ${income}, 0, '100.00')`;
        await tx`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${personId} where id = ${e!.id}`;
      });
    } finally {
      await s.end({ timeout: 5 });
    }
  }

  beforeAll(seed, 120_000);

  it('3.cli start and purge refuse with exit 2 while another session is on the target, naming its application_name', async () => {
    const live = postgres(urlFor(TARGET_DB), { max: 1, connection: { application_name: 't394-live-app' }, onnotice: () => {} });
    try {
      await live`select 1`;
      const s = cli(withDb('start'));
      expect(s.status, s.text.slice(-400)).toBe(2);
      expect(s.text).toContain('t394-live-app');
      const p = cli(withDb('purge', TARGET_DB, ['--by', personId]));
      expect(p.status, p.text.slice(-400)).toBe(2);
      expect(p.text).toContain('t394-live-app');
      const [{ n }] = await live<{ n: number }[]>`select count(*)::int as n from cutover_steps where step_code = 'C2'`;
      expect(n, 'a refused purge writes nothing').toBe(0);
    } finally {
      await live.end({ timeout: 5 });
    }
  }, 300_000);

  it('4.cli start passes on the idle copy, opens the journal in REHEARSAL_DIR, exit 0', () => {
    const r = cli(withDb('start'));
    expect(r.status, r.text.slice(-600)).toBe(0);
    expect(walk(dir).length).toBeGreaterThan(0);
  }, 300_000);

  it('4.cli predump leaves a dump and its manifest in REHEARSAL_DIR, taken from the target (exit 0)', () => {
    const r = cli(withDb('predump'));
    expect(r.status, r.text.slice(-600)).toBe(0);
    const files = walk(dir);
    expect(files.some((f) => f.endsWith('.dump'))).toBe(true);
    expect(files.some((f) => f.endsWith('.manifest.json'))).toBe(true);
  }, 300_000);

  it('4.cli / 5.cli purge runs the real CLI three times: the C2 row exists for EVERY org, purge tables are empty, KEEP rows remain', async () => {
    const r = cli(withDb('purge', TARGET_DB, ['--by', personId]));
    expect(r.status, r.text.slice(-800)).toBe(0);
    const t = postgres(urlFor(TARGET_DB), { max: 1, onnotice: () => {} });
    try {
      const orgs = await t<{ id: string }[]>`select id from organizations`;
      expect(orgs.length).toBeGreaterThanOrEqual(1);
      const missing = await t<{ id: string }[]>`
        select o.id from organizations o
        where not exists (select 1 from cutover_steps c where c.org_id = o.id and c.step_code = 'C2')`;
      expect(missing, 'every org must have its C2 row').toEqual([]);
      const [{ n }] = await t<{ n: number }[]>`select count(*)::int as n from journal_entries`;
      expect(n).toBe(0);
      const [{ k }] = await t<{ k: number }[]>`select count(*)::int as k from persons`;
      expect(k).toBeGreaterThanOrEqual(1);
    } finally {
      await t.end({ timeout: 5 });
    }
  }, 600_000);
});

describe('T-394 S1 I11 - rollback-check restores nothing itself; it compares the restored predump with the dump\'s own manifest', () => {
  async function restorePredump(): Promise<void> {
    const dump = walk(dir).find((f) => f.endsWith('.dump'));
    expect(dump, 'predump must have left a dump').toBeTruthy();
    const { argv, env } = buildPgArgs(urlFor(AGAINST_DB), ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', dump!]);
    const r = await runTool(resolvePgBin('pg_restore'), argv, env);
    expect(r.code, r.stderr.slice(0, 400)).toBe(0);
  }

  it('11.cli the pre-purge dump restored into a second guarded database ties to its manifest (exit 0)', async () => {
    await restorePredump();
    const r = cli(['rollback-check', '--confirm-database', TARGET_DB, '--against', 'T394_AGAINST_URL']);
    expect(r.status, r.text.slice(-600)).toBe(0);
  }, 300_000);

  it('11.cli one extra row in the restored database fails (exit 1) and names the table', async () => {
    const a = postgres(urlFor(AGAINST_DB), { max: 1, onnotice: () => {} });
    try {
      await a`insert into organizations (name, code) values ('Extra', 't394extra')`;
    } finally {
      await a.end({ timeout: 5 });
    }
    const r = cli(['rollback-check', '--confirm-database', TARGET_DB, '--against', 'T394_AGAINST_URL']);
    expect(r.status, r.text.slice(-600)).toBe(1);
    expect(r.text).toContain('public.organizations');
  }, 300_000);

  it('11.cli --against naming the target itself, or a bad database, is refused (exit 2)', () => {
    expect(cli(['rollback-check', '--confirm-database', TARGET_DB, '--against', 'T394_AGAINST_URL'], { T394_AGAINST_URL: urlFor(TARGET_DB) }).status).toBe(2);
    expect(cli(['rollback-check', '--confirm-database', TARGET_DB, '--against', 'T394_AGAINST_URL'], { T394_AGAINST_URL: urlFor(`${AGAINST_DB}_prod`) }).status).toBe(2);
    expect(cli(['rollback-check', '--confirm-database', TARGET_DB, '--against', 'T394_AGAINST_URL'], { T394_AGAINST_URL: `postgresql://u:p@${PINNED}:25060/${AGAINST_DB}` }).status).toBe(2);
  });
});
