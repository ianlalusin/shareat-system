import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';

import { seedChartOfAccounts } from '../../packages/db/seed/chart-of-accounts';

/**
 * T-394 S2 - shared fixture for the verify / report tests. TESTER-owned. Local databases only (localhost:5435).
 *
 * Databases: ONE template `t394s2_tpl_NNNN` cloned from the lane database in `start()`, then one clone per scenario named
 * `shareat_rehearsal_2099NNNN` (the S1 ruling: far-future name, created and dropped by the tests; the name pattern is not injectable).
 * Cluster roles `t394s2_app_NNNN` (no bypass) and `t394s2_byp_NNNN` (BYPASSRLS) stand in for "the app's role". Everything is dropped in `stop()`.
 *
 * The journal is written by hand (scripts/lib/rehearsal/journal.ts's own shape plus the S2 additions pinned in t394-s2-verify.test.ts)
 * so each scenario controls `start.at` and `purgeCommittedAt` exactly.
 */

config({ path: '.env.local' });
export const laneUrl = process.env.TEST_DATABASE_URL as string;
if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(laneUrl)) throw new Error('Refusing: lane database name must contain "_test".');
if (!['localhost', '127.0.0.1'].includes(new URL(laneUrl).hostname)) throw new Error('T-394 S2 tests run on localhost only.');

export const repoRoot = path.resolve(__dirname, '../..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const digits = (): string => String(1000 + Math.floor(Math.random() * 9000));
// two vitest workers (the verify and report files) must never draw the same database name: the process id is part of it
const pidTag = String((process.pid % 90) + 10);
const rehearsalSuffix = (): string => pidTag + String(10 + Math.floor(Math.random() * 90));
const used = new Set<string>();
const uniq = (mk: () => string): string => {
  let v = mk();
  while (used.has(v)) v = mk();
  used.add(v);
  return v;
};

export const urlFor = (db: string, user?: string, password?: string): string => {
  const u = new URL(laneUrl);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = password ?? '';
  }
  return u.toString();
};

export const TPL = uniq(() => `t394s2_tpl_${digits()}`);
export const APP_ROLE = uniq(() => `t394s2_app_${digits()}`);
export const BYPASS_ROLE = uniq(() => `t394s2_byp_${digits()}`);
export const ROLE_PW = 'pw_' + digits();

let admin: postgres.Sql;
const clones: string[] = [];
export let dir: string;

export async function start(): Promise<void> {
  dir = mkdtempSync(path.join(tmpdir(), 't394-s2-'));
  admin = postgres(urlFor('postgres'), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create role "${APP_ROLE}" login password '${ROLE_PW}' nobypassrls nosuperuser`);
  await admin.unsafe(`create role "${BYPASS_ROLE}" login password '${ROLE_PW}' bypassrls nosuperuser`);
  await cloneInto(TPL, laneUrlDb());
  // The lane DB is shared with every other integration file and verify runs per EVERY org in the database it is pointed at, so
  // orgs those files left behind (full suite / CI: one DB) would pollute every copy with findings that are not this test's. Clear
  // them from the template; each scenario then seeds only its own org(s).
  const t = postgres(urlFor(TPL), { max: 1, onnotice: () => {} });
  try {
    await t.unsafe('truncate table organizations cascade');
    // verify's sequences_reset check fails on any owned sequence that has been used while its table is empty; the truncate above
    // empties the tables but leaves the sequences wherever the other files advanced them, so restart every owned sequence too.
    await t.unsafe(`
      do $$ declare r record; begin
        for r in
          select s.oid::regclass::text as seq from pg_class s
          join pg_depend d on d.objid = s.oid and d.deptype = 'a'
          where s.relkind = 'S' and s.relnamespace = 'public'::regnamespace
        loop execute format('alter sequence %s restart', r.seq); end loop;
      end $$`);
  } finally {
    await t.end({ timeout: 5 });
  }
}

/** Drops every per-scenario copy (not the template): called after each test so the disk and the drop time stay small. */
export async function dropScenarioCopies(): Promise<void> {
  for (const db of clones.filter((c) => c !== TPL)) {
    await admin.unsafe(`drop database if exists "${db}" with (force)`);
    clones.splice(clones.indexOf(db), 1);
  }
}

export async function stop(): Promise<void> {
  try {
    for (const db of clones.splice(0)) await admin.unsafe(`drop database if exists "${db}" with (force)`);
    await admin.unsafe(`drop role if exists "${APP_ROLE}"`);
    await admin.unsafe(`drop role if exists "${BYPASS_ROLE}"`);
  } finally {
    await admin.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  }
}

const laneUrlDb = (): string => decodeURIComponent(new URL(laneUrl).pathname.slice(1));

async function cloneInto(name: string, template: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await admin.unsafe(`create database "${name}" template "${template}"`);
      clones.push(name);
      return;
    } catch (e) {
      if (i >= 80 || !/being accessed by other users/.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** A fresh migrated copy named like a rehearsal. */
export async function newRehearsalDb(): Promise<string> {
  // The cluster is shared (other test runs, leftovers of a killed run), and the 4-digit suffix is small: on "already exists" draw
  // another name rather than fail the test for a collision that has nothing to do with verify.
  for (let i = 0; ; i++) {
    const name = uniq(() => `shareat_rehearsal_2099${rehearsalSuffix()}`);
    try {
      await cloneInto(name, TPL);
      return name;
    } catch (e) {
      if (i >= 20 || !/already exists/.test(String((e as Error).message))) throw e;
    }
  }
}

export const connect = (db: string, user?: string): postgres.Sql =>
  postgres(user ? urlFor(db, user, ROLE_PW) : urlFor(db), { max: 1, onnotice: () => {} });

/** An open session on the copy as the "app" (kept open until `end()`), the way the 9008 app would be. */
export async function appSession(db: string, role: string = APP_ROLE): Promise<{ end: () => Promise<void> }> {
  const s = postgres(urlFor(db, role, ROLE_PW), { max: 1, onnotice: () => {}, connection: { application_name: 't394-s2-app' } });
  await s`select 1`;
  return { end: () => s.end({ timeout: 5 }) };
}

export interface CliResult {
  status: number | null;
  text: string;
}

export function cli(sub: string[], db: string, envOver: Record<string, string | undefined> = {}): CliResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    REHEARSAL_DATABASE_URL: urlFor(db),
    REHEARSAL_DIR: dir,
    // the "production" stand-ins: a DIFFERENT database (the lane DB) so the guards pass
    DATABASE_URL: laneUrl,
    SYSTEM_DATABASE_URL: laneUrl,
    ...envOver,
  };
  const r = spawnSync(process.execPath, [tsxCli, 'scripts/cutover-rehearsal.ts', ...sub, '--confirm-database', db], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 300_000,
    env: env as NodeJS.ProcessEnv,
  });
  return { status: r.status, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

// ------------------------------------------------------------------------------------------------------------- seeding

export interface OrgFx {
  orgId: string;
  personId: string;
  storeId: string;
  storeName: string;
}

let seq = 0;
export const uid = (p: string): string => `${p}${Date.now().toString(36)}${++seq}`;

export async function mkOrg(s: postgres.Sql, o: { periods?: boolean; personName?: string } = {}): Promise<OrgFx> {
  const code = uid('t394s2');
  const [org] = await s<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(s, orgId);
  if (o.periods !== false) {
    await s`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
      from generate_series('2026-12-01'::date, '2028-12-01'::date, '1 month') d`;
  }
  const [p] = await s<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${o.personName ?? 'Fixture person'}) returning id`;
  const storeName = `Store ${uid('n')}`;
  const [st] = await s<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('S')}, ${storeName}, 'multi_room') returning id`;
  return { orgId, personId: p!.id, storeId: st!.id, storeName };
}

export interface EntryLine {
  code: string;
  debit: string;
  credit: string;
  storeId?: string;
}

/** One journal entry with its lines; `posted` goes through draft -> posted in one transaction (the S1 pattern). Returns the entry id. */
export async function entry(
  s: postgres.Sql,
  fx: OrgFx,
  o: { date: string; source: string; status: 'draft' | 'posted'; lines: EntryLine[]; createdAt?: string },
): Promise<string> {
  const [period] = await s<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${fx.orgId} and starts_on <= ${o.date}::date and ends_on >= ${o.date}::date`;
  if (!period) throw new Error(`fixture: no fiscal period for ${o.date}`);
  return s.begin(async (tx) => {
    const [e] = o.createdAt
      ? await tx<{ id: string }[]>`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, status, created_at)
          values (${fx.orgId}, ${o.date}, ${period.id}, ${o.source}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 't394 s2', 'draft', ${o.createdAt}::timestamptz)
          returning id`
      : await tx<{ id: string }[]>`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, status)
          values (${fx.orgId}, ${o.date}, ${period.id}, ${o.source}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 't394 s2', 'draft')
          returning id`;
    let n = 0;
    for (const l of o.lines) {
      const [a] = await tx<{ id: string }[]>`select id from accounts where org_id = ${fx.orgId} and code = ${l.code}`;
      if (!a) throw new Error(`fixture: no account ${l.code}`);
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id)
        values (${e!.id}, ${++n}, ${a.id}, ${l.debit}, ${l.credit}, ${l.storeId ?? null})`;
    }
    if (o.status === 'posted') await tx`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${fx.personId} where id = ${e!.id}`;
    return e!.id;
  });
}

/** Dr 1110 / Cr 3300 and Dr 1130 / Cr 3300: two opening entries that tie (the "figures" shape). */
export async function openingFigures(s: postgres.Sql, fx: OrgFx, status: ('draft' | 'posted')[] = ['posted', 'posted'], date = '2027-01-01'): Promise<string[]> {
  const a = await entry(s, fx, { date, source: 'opening_balance', status: status[0]!, lines: [{ code: '1110', debit: '100.00', credit: '0', storeId: fx.storeId }, { code: '3300', debit: '0', credit: '100.00', storeId: fx.storeId }] });
  const b = await entry(s, fx, { date, source: 'opening_balance', status: status[1]!, lines: [{ code: '1130', debit: '50.00', credit: '0', storeId: fx.storeId }, { code: '3300', debit: '0', credit: '50.00', storeId: fx.storeId }] });
  return [a, b];
}

/** A BALANCED opening entry that the tie-out must still refuse: Dr 1310 for a store with no counts. */
export async function nonTyingStock(s: postgres.Sql, fx: OrgFx, status: 'draft' | 'posted' = 'posted'): Promise<string> {
  return entry(s, fx, {
    date: '2027-01-01',
    source: 'opening_balance',
    status,
    lines: [{ code: '1310', debit: '75.00', credit: '0', storeId: fx.storeId }, { code: '3300', debit: '0', credit: '75.00', storeId: fx.storeId }],
  });
}

export async function step(s: postgres.Sql, fx: OrgFx, code: 'C2' | 'C5'): Promise<void> {
  await s`insert into cutover_steps (org_id, store_id, step_code, completion, note, completed_by)
          values (${fx.orgId}, null, ${code}, 'performed', 't394 s2 fixture', ${fx.personId})`;
}

// ------------------------------------------------------------------------------------------------------------- journal

import { mkdirSync, writeFileSync } from 'node:fs';
import { journalPath } from '../../scripts/lib/rehearsal/journal';

export const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

/** The R9 journal as S1 writes it, plus the S2 addition `checks`. `start.at` and `purgeCommittedAt` are the scenario's clock. */
export function writeJournalFile(
  db: string,
  o: { startAt?: string; purgeCommittedAt?: string | null; steps?: unknown[]; checks?: unknown[] } = {},
): void {
  const j = {
    database: db,
    openedAt: o.startAt ?? minutesAgo(60),
    start: {
      at: o.startAt ?? minutesAgo(60),
      snapshot: { keepCounts: { persons: 0, accounts: 0, stores: 0, opening_counts: 0 }, keepHashes: {} },
      migrationCount: 200,
      coverageOk: true,
    },
    steps: o.steps ?? [],
    ...(o.purgeCommittedAt === null ? {} : { purgeCommittedAt: o.purgeCommittedAt ?? minutesAgo(30) }),
    ...(o.checks ? { checks: o.checks } : {}),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(journalPath(dir, db), JSON.stringify(j, null, 2) + '\n', 'utf8');
}
