import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T-394 S1 - integration legs on the LANE database (invariants 3, 5, 6, 7a; docs/tasks/394-purge-and-opening-rehearsal.md s6).
 * Written TESTER-FIRST: red with "Cannot find module scripts/lib/rehearsal/checks" (new module) until the builder lands S1;
 * the two 7a tests run the EXISTING scripts/cutover-purge.ts and are red on the behaviour today.
 *
 * Real Postgres, real `applyPurge` (via the T-390 helper). A real purge truncates the whole database: run ONLY via
 * `it-lane.cjs shareat_test_t394`. This file never creates a `shareat_rehearsal_*` database (see the hand-back QUESTION: the
 * required name has no "_test" in it, which the tester's own safety rule forbids creating), so the legs that need one -
 * CLI exit codes (I1/I3 end to end), I4 "C2 row for every org", I4a decoy-DB migrate, I11 restore - are NOT in this file.
 *
 * ## Contract choices the spec leaves open (flagged in the hand-back)
 *  checks.ts (all take a `postgres.Sql` that bypasses RLS, connected to the target):
 *   - checkLiveness(sql): Promise<{ ok: boolean; sessions: { applicationName: string; pid: number }[]; message: string }>
 *     other sessions on current_database() excluding pg_backend_pid(); the message names each application_name.
 *   - checkFiscalCoverage(sql, { runAt: Date, conversionDate: string }): Promise<{ ok: boolean; failures: { orgId: string;
 *     firstMissingMonth: string /* YYYY-MM *\/; reason: string }[] }>. Required months: the conversion month through (Manila
 *     business month of runAt) + 11, each covered by an `open` period; months BEFORE the conversion month are not required (R6).
 *   - snapshotStart(sql): Promise<StartSnapshot> holding `keepCounts: Record<'persons'|'accounts'|'stores'|'opening_counts', number>` and
 *     `keepHashes: Record<string, string>` (md5 of the rows' text, per KEEP-class table, as purge.ts's tableMd5).
 *   - checkPostPurge(sql, start, { conversionDate }): Promise<{ ok: boolean; failures: { check: string; detail: string }[] }>
 *     with check ids 'purge_tables_empty' | 'keep_counts_unchanged' | 'trial_balance_zero' | 'no_pre_conversion_periods' | 'keep_content_unchanged'.
 */

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { checkFiscalCoverage, checkLiveness, checkPostPurge, snapshotStart } from '../../scripts/lib/rehearsal/checks';
import { CUTOVER_CLASSIFICATION } from '../../packages/db/src/cutover/classification';
import { PURGE_AS_OF, performersForAllOrgs, realPurge } from './t390-real-purge';

const sql = postgres(url, { max: 1, onnotice: () => {} });
const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const repoRoot = path.resolve(__dirname, '../..');

async function mkOrg(tag: string): Promise<{ orgId: string; personId: string }> {
  const code = uid(`t394${tag}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Fixture person') returning id`;
  return { orgId: o!.id, personId: p!.id };
}

/** Open monthly periods `from`..`to` inclusive (first-of-month dates). */
async function openPeriods(orgId: string, from: string, to: string, skip: string[] = []): Promise<void> {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series(${from}::date, ${to}::date, '1 month') d
    where to_char(d, 'YYYY-MM') <> all(${skip}::text[])`;
}

const NOV_13_MANILA = new Date('2026-11-13T04:00:00Z');
const NOV_1_0100_MANILA = new Date('2026-10-31T17:00:00Z'); // 2026-11-01 01:00 in Manila, still October in UTC
const OCT_31_2300_MANILA = new Date('2026-10-30T15:00:00Z');
const JAN_1_0800_MANILA = new Date('2027-01-01T00:00:00Z');

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-394 S1 I3 - liveness: a second session on the target is found and named', () => {
  it('3.a another client session is reported with its application_name; the tool\'s own session is not', async () => {
    const decoy = postgres(url, { max: 1, connection: { application_name: 't394-decoy-app' }, onnotice: () => {} });
    try {
      await decoy`select 1`;
      const r = await checkLiveness(sql);
      expect(r.ok).toBe(false);
      expect(r.sessions.map((s) => s.applicationName)).toContain('t394-decoy-app');
      expect(r.message).toContain('t394-decoy-app');
    } finally {
      await decoy.end({ timeout: 5 });
    }
  });

  it('3.b with the decoy gone the verdict equals "no other session exists" (own pid excluded)', async () => {
    const n = (await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`)[0]!.n;
    const r = await checkLiveness(sql);
    expect(r.ok).toBe(n === 0);
    expect(r.sessions.length).toBe(n);
  });
});

describe('T-394 S1 I6 - DEF-585: every org has open periods through the seed horizon of the run date', () => {
  let full: string; // 2027-01..2027-10: right for a 13 Nov 2026 run
  let toSep: string; // 2027-01..2027-09
  let closedJan: string;
  let none: string; // a second org created with no periods
  let gap: string; // 2027-03 missing

  beforeAll(async () => {
    full = (await mkOrg('full')).orgId;
    await openPeriods(full, '2027-01-01', '2027-10-01');
    toSep = (await mkOrg('tosep')).orgId;
    await openPeriods(toSep, '2027-01-01', '2027-09-01');
    closedJan = (await mkOrg('closedjan')).orgId;
    await openPeriods(closedJan, '2027-01-01', '2027-10-01');
    await sql`update fiscal_periods set status = 'closed', closed_at = now() where org_id = ${closedJan} and starts_on = '2027-01-01'`;
    none = (await mkOrg('none')).orgId;
    gap = (await mkOrg('gap')).orgId;
    await openPeriods(gap, '2027-01-01', '2027-10-01', ['2027-03']);
  });

  const run = (runAt: Date) => checkFiscalCoverage(sql, { runAt, conversionDate: PURGE_AS_OF });
  const failureOf = (r: Awaited<ReturnType<typeof run>>, orgId: string) => r.failures.find((f) => f.orgId === orgId);

  it('6.a on 13 Nov 2026 an org covered 2027-01..2027-10 passes (horizon = run month + 11, NOT conversion + 11); pre-2027 months are not required', async () => {
    const r = await run(NOV_13_MANILA);
    expect(failureOf(r, full)).toBeUndefined();
  });

  it('6.b the same org fails on the 1 Jan 2027 run, naming its first missing month 2027-11', async () => {
    const f = failureOf(await run(JAN_1_0800_MANILA), full);
    expect(f?.firstMissingMonth).toBe('2027-11');
  });

  it('6.c the run month is the MANILA month: 01:00 on 1 Nov in Manila (still 31 Oct UTC) needs 2027-10; one hour earlier in Manila does not', async () => {
    expect(failureOf(await run(NOV_1_0100_MANILA), toSep)?.firstMissingMonth).toBe('2027-10');
    expect(failureOf(await run(OCT_31_2300_MANILA), toSep)).toBeUndefined();
  });

  it('6.d a closed period covering the conversion date does not count as coverage', async () => {
    const f = failureOf(await run(NOV_13_MANILA), closedJan);
    expect(f?.firstMissingMonth).toBe('2027-01');
  });

  it('6.e an org with no periods fails naming 2027-01, even though another org is fine (every org is checked, not the first)', async () => {
    const r = await run(NOV_13_MANILA);
    expect(failureOf(r, none)?.firstMissingMonth).toBe('2027-01');
    expect(failureOf(r, full)).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('6.f a hole in the middle is named: first missing month 2027-03', async () => {
    expect(failureOf(await run(NOV_13_MANILA), gap)?.firstMissingMonth).toBe('2027-03');
  });
});

describe('T-394 S1 I5 - after the real purge on the copy', () => {
  let orgId: string;
  let personId: string;
  let start: Awaited<ReturnType<typeof snapshotStart>>;
  let cash: string;
  let income: string;
  let preCutoverNonC2 = 0;

  beforeAll(async () => {
    ({ orgId, personId } = await mkOrg('purge'));
    const acct = async (code: string, type: string, normal: string): Promise<string> =>
      (
        await sql<{ id: string }[]>`
          insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
          values (${orgId}, ${code}, ${code}, ${type}, ${normal}, true, true, 'active') returning id`
      )[0]!.id;
    cash = await acct('1110', 'asset', 'debit');
    income = await acct('4100', 'income', 'credit');
    await sql`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('S')}, 'Fixture store', 'multi_room')`;
    // a 2026 period (the purge deletes it), the 2027 periods (it keeps them), and one draft journal entry (purge-class data)
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-12-01', '2026-12-31', 'open')`;
    await openPeriods(orgId, '2027-01-01', '2027-03-01');
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on = '2026-12-01'`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
        values (${orgId}, '2026-12-10', ${period!.id}, 'manual_journal', ${uid('src')}, ${uid('key')}, 't394', ${personId}, 'draft')
        returning id`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 1, ${cash}, '100.00', 0)`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 2, ${income}, 0, '100.00')`;
    });
    // every org needs a person BEFORE the snapshot, or the helper's own insert would change the persons count
    await performersForAllOrgs(sql, personId);
    preCutoverNonC2 = (await sql<{ n: number }[]>`select count(*)::int as n from cutover_steps where step_code <> 'C2'`)[0]!.n;
    start = await snapshotStart(sql);
    await realPurge(sql, personId);
  }, 600_000);

  it('5.a snapshotStart counted the four KEEP tables before the purge', () => {
    for (const t of ['persons', 'accounts', 'stores', 'opening_counts'] as const) {
      expect(typeof start.keepCounts[t], t).toBe('number');
    }
    expect(start.keepCounts.persons).toBeGreaterThanOrEqual(1);
    expect(start.keepCounts.accounts).toBeGreaterThanOrEqual(2);
    expect(start.keepCounts.stores).toBeGreaterThanOrEqual(1);
  });

  it('5.a2 snapshotStart holds an md5 of every KEEP-class table, and a correct purge leaves each identical', async () => {
    const keep = Object.entries(CUTOVER_CLASSIFICATION)
      .filter(([, e]) => (e as { class: string }).class === 'keep')
      .map(([t]) => t)
      .filter((t) => t !== 'cutover_steps'); // the purge itself writes its C2 rows here, after its own byte-identical check
    expect(keep.length).toBeGreaterThan(10);
    for (const t of keep) expect(typeof start.keepHashes[t], `keepHashes.${t}`).toBe('string');
    for (const t of keep) {
      const [row] = await sql.unsafe<{ h: string }[]>(`select md5(coalesce(string_agg(x::text, '' order by x::text), '')) as h from "${t}" x`);
      expect(row!.h, `${t} content changed through the purge`).toBe(start.keepHashes[t]);
    }
  });

  it('5.a3 cutover_steps gained exactly the C2 rows, one per organization, and nothing else changed in it', async () => {
    const orgs = (await sql<{ n: number }[]>`select count(*)::int as n from organizations`)[0]!.n;
    const c2 = (await sql<{ n: number }[]>`select count(*)::int as n from cutover_steps where step_code = 'C2'`)[0]!.n;
    const total = (await sql<{ n: number }[]>`select count(*)::int as n from cutover_steps`)[0]!.n;
    expect(c2).toBe(orgs);
    expect(total - c2, 'rows other than C2 must be the pre-purge ones').toBe(preCutoverNonC2);
  });

  it('5.b a correct purge passes every post-condition', async () => {
    const r = await checkPostPurge(sql, start, { conversionDate: PURGE_AS_OF });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('5.c a KEEP count that moved fails keep_counts_unchanged (start counts are compared, not recomputed)', async () => {
    const forged = { ...start, keepCounts: { ...start.keepCounts, opening_counts: start.keepCounts.opening_counts + 1 } };
    const r = await checkPostPurge(sql, forged, { conversionDate: PURGE_AS_OF });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.check)).toContain('keep_counts_unchanged');
    // and a real extra person after the purge moves persons the same way
    const [extra] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'late') returning id`;
    try {
      const r2 = await checkPostPurge(sql, start, { conversionDate: PURGE_AS_OF });
      expect(r2.failures.map((f) => f.check)).toContain('keep_counts_unchanged');
    } finally {
      await sql`delete from persons where id = ${extra!.id}`;
    }
  });

  it('5.c2 KEEP table CONTENT is compared, not only counts: a renamed account fails keep_content_unchanged', async () => {
    await sql`update accounts set name = name || ' (edited)' where id = ${cash}`;
    try {
      const r = await checkPostPurge(sql, start, { conversionDate: PURGE_AS_OF });
      expect(r.ok).toBe(false);
      expect(r.failures.map((f) => f.check)).toContain('keep_content_unchanged');
      expect(r.failures.map((f) => f.check)).not.toContain('keep_counts_unchanged');
    } finally {
      await sql`update accounts set name = replace(name, ' (edited)', '') where id = ${cash}`;
    }
  });

  it('5.d a fiscal period before the conversion date fails no_pre_conversion_periods', async () => {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-11-01', '2026-11-30', 'open')`;
    try {
      const r = await checkPostPurge(sql, start, { conversionDate: PURGE_AS_OF });
      expect(r.failures.map((f) => f.check)).toContain('no_pre_conversion_periods');
    } finally {
      await sql`delete from fiscal_periods where org_id = ${orgId} and starts_on = '2026-11-01'`;
    }
  });

  it('5.e a row left in a purge-class table fails purge_tables_empty', async () => {
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on = '2027-01-01'`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
        values (${orgId}, '2027-01-02', ${period!.id}, 'manual_journal', ${uid('src')}, ${uid('key')}, 't394 leftover', ${personId}, 'draft')
        returning id`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 1, ${cash}, '5.00', 0)`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 2, ${income}, 0, '5.00')`;
    });
    const r = await checkPostPurge(sql, start, { conversionDate: PURGE_AS_OF });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.check)).toContain('purge_tables_empty');
  });

  it('5.f a non-zero trial balance fails trial_balance_zero (numeric text, even for a small posted amount)', async () => {
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on = '2027-01-01'`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, status)
        values (${orgId}, '2027-01-03', ${period!.id}, 'manual_journal', ${uid('src')}, ${uid('key')}, 't394 posted', 'draft')
        returning id`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 1, ${cash}, '0.01', 0)`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 2, ${income}, 0, '0.01')`;
      await tx`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${personId} where id = ${e!.id}`;
    });
    const r = await checkPostPurge(sql, start, { conversionDate: PURGE_AS_OF });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.check)).toContain('trial_balance_zero');
  });
});

describe('T-394 S1 I7a / R8 / DEF-641 - cutover-purge: --as-of is explicit for --apply and --rehearse; the dry-run default is the Manila date', () => {
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const clock = path.join(repoRoot, 'tests', 'integration', 't394-fake-clock.cjs').replace(/\\/g, '/');
  let reportDir: string;
  beforeAll(() => {
    reportDir = mkdtempSync(path.join(tmpdir(), 't394-r8-'));
  });
  afterAll(() => {
    rmSync(reportDir, { recursive: true, force: true });
  });

  function purgeCli(args: string[], fakeNow?: string) {
    return spawnSync(process.execPath, [tsxCli, 'scripts/cutover-purge.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        DATABASE_URL: url,
        CUTOVER_PURGE_REPORT_DIR: reportDir,
        CUTOVER_PURGE_BY: '',
        ...(fakeNow ? { T394_FAKE_NOW: fakeNow, NODE_OPTIONS: `--require ${clock}` } : {}),
      },
    });
  }
  // a person id that exists nowhere: if the refusal under test were missing, the run still could not write anything
  const NOBODY = '00000000-0000-0000-0000-000000000000';

  it('7a.a --apply without --as-of is refused, naming --as-of', () => {
    const r = purgeCli(['--confirm-database', dbName, '--apply', '--by', NOBODY]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/^REFUSED\..*--as-of.*$/m);
  });

  it('7a.b --rehearse without --as-of is refused, naming --as-of', () => {
    const r = purgeCli(['--confirm-database', dbName, '--rehearse']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/^REFUSED\..*--as-of.*$/m);
  });

  it('7a.c a dry run at 2026-12-31T23:30Z (07:30 Manila, 1 Jan 2027) defaults to as-of 2027-01-01', () => {
    const r = purgeCli(['--confirm-database', dbName], '2026-12-31T23:30:00Z');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('as-of 2027-01-01');
    expect(existsSync(path.join(reportDir, 'cutover-purge-2027-01-01.md'))).toBe(true);
  });

  it('7a.d control: at 2026-12-31T10:00Z (18:00 Manila, still 31 Dec) the default is 2026-12-31', () => {
    const r = purgeCli(['--confirm-database', dbName], '2026-12-31T10:00:00Z');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('as-of 2026-12-31');
    expect(existsSync(path.join(reportDir, 'cutover-purge-2026-12-31.md'))).toBe(true);
  });
});
