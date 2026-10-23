import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { journalPath } from '../../scripts/lib/rehearsal/journal';
import {
  cli,
  connect,
  dir,
  dropScenarioCopies,
  entry,
  laneUrl,
  minutesAgo,
  mkOrg,
  newRehearsalDb,
  openingFigures,
  start,
  stop,
  uid,
  urlFor,
  writeJournalFile,
  type OrgFx,
} from './t394-s2-fixture';

/**
 * T-394 S2 - `report` end to end (invariants 10c "verify and report fail", 12, 13; R10). Written TESTER-FIRST: red until `report`
 * exists in scripts/cutover-rehearsal.ts (today: "usage:" + exit 1).
 *
 * ## Pinned CLI contract
 *   npx tsx scripts/cutover-rehearsal.ts report --confirm-database <db> --out-dir <dir>     (env as S1)
 *   - Re-runs guards (a)-(d) and (f); needs no app session. Reads the journal (steps, `checks`, `by` ids) and the copy.
 *   - SANITISED report -> <out-dir>/cutover-rehearsal-YYYY-MM-DD.md (default out-dir docs/reviews; the tests always pass --out-dir,
 *     so nothing is ever written into the repo). FULL report -> <REHEARSAL_DIR>/<db>.full-report.md.
 *   - Fails (exit 1, names the table) when a clock_terminals row was created/updated or an attendance_punches row inserted after
 *     `start.at` (I10c). Exit 0 otherwise. The sanitised report states each step as whole seconds or NOT TIMED, each journal check as
 *     PASS/FAIL by name, the account CODES with totals, counts per class and the migration list; it never carries a persons text
 *     column, an email, a phone, a hash, a connection string, a check's free-text detail (R10).
 *   - Pure part: scripts/lib/rehearsal/report.ts (see tests/unit/t394-s2-report.test.ts).
 */

beforeAll(start, 180_000);
afterEach(dropScenarioCopies, 120_000);
afterAll(stop, 300_000);

const NAME = 'SENTINELNAME Maria Dela Cruz';
const DETAIL = 'Stock at SENTINELSTORE comes to ₱SENTINELAMOUNT7654.32 (supplier cost SENTINELCOST 48.75)';

let outDir: string;
beforeAll(() => {
  outDir = mkdtempSync(path.join(tmpdir(), 't394-s2-out-'));
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const files = (d: string): string[] => (existsSync(d) ? readdirSync(d).map((n) => path.join(d, n)) : []);

/** The checks a complete rehearsal has recorded by report time (names pinned in t394-s2-verify.test.ts). */
const EXPECTED_CHECKS = ['tie_out', 'app_role', 'terminal_activity', 'fiscal_coverage', 'sequences_reset', 'opening_set', 'c2_c5_recorded', 'freeze'];

async function seeded(opts: { terminal?: boolean; fail?: boolean; omit?: string } = {}): Promise<{ db: string; fx: OrgFx }> {
  const db = await newRehearsalDb();
  const s = connect(db);
  try {
    const fx = await mkOrg(s, { personName: NAME });
    await s`update persons set display_name = ${NAME} where id = ${fx.personId}`;
    await openingFigures(s, fx);
    await entry(s, fx, { date: '2026-12-31', source: 'manual_journal', status: 'draft', createdAt: minutesAgo(600), lines: [{ code: '1110', debit: '1.00', credit: '0' }, { code: '3300', debit: '0', credit: '1.00' }] });
    if (opts.terminal) await s`insert into clock_terminals (org_id, store_id, label, firebase_uid) values (${fx.orgId}, ${fx.storeId}, 'T1', ${uid('fb')})`;
    writeJournalFile(db, {
      steps: [
        { code: 'migrate', startedAt: minutesAgo(50), endedAt: new Date(Date.parse(minutesAgo(50)) + 90_400).toISOString(), result: 'pass' },
        { code: 'C3', startedAt: minutesAgo(40), by: fx.personId },
        { code: 'C5', startedAt: minutesAgo(20), endedAt: minutesAgo(19), by: fx.personId, result: 'done' },
      ],
      checks: EXPECTED_CHECKS.filter((n) => n !== opts.omit).map((name) => ({
        name,
        ok: !(opts.fail && name === 'tie_out'),
        detail: name === 'tie_out' ? DETAIL : 'ok',
        at: minutesAgo(10),
      })),
    });
    return { db, fx };
  } finally {
    await s.end({ timeout: 5 });
  }
}

describe('T-394 S2 I13 - the committed report is sanitised by construction (CLI, real copy seeded with sentinels)', () => {
  it('13.cli the sanitised report has no person name, no free-text check detail, no connection string, no password; the --by person is an id', async () => {
    const { db, fx } = await seeded({ fail: true });
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, 'a FAIL check in the journal makes report exit 1 (the evidence is still written)').toBe(1);
    expect(r.text).not.toContain('usage: cutover-rehearsal <start');

    const committed = files(outDir).filter((f) => /cutover-rehearsal-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(committed, `no sanitised report in ${outDir}: ${files(outDir).join(', ')}`).toHaveLength(1);
    const text = readFileSync(committed[0]!, 'utf8');

    for (const s of [NAME, 'SENTINELNAME', DETAIL, 'SENTINELSTORE', 'SENTINELAMOUNT', 'SENTINELCOST', 'postgresql://', urlFor(db), laneUrl]) {
      expect(text.includes(s), `the committed report leaks "${s}"`).toBe(false);
    }
    const password = decodeURIComponent(new URL(laneUrl).password);
    if (password.length >= 8) expect(text.includes(password), 'the database password leaked').toBe(false);

    expect(text).toContain(fx.personId);
    expect(text).toContain(db);
    expect(text.split('\n').find((l) => l.includes('C3')) ?? '', 'the untimed human step').toContain('NOT TIMED');
    expect(text.split('\n').find((l) => l.includes('migrate')) ?? '').toMatch(/\b90\b/);
    expect((text.split('\n').find((l) => l.includes('tie_out')) ?? ''), 'the failed check').toContain('FAIL');
    expect((text.split('\n').find((l) => l.includes('app_role')) ?? '')).toContain('PASS');
    expect(text, 'account codes with totals').toContain('3300');
    expect(text).toMatch(/150(\.00)?/);
  }, 180_000);

  it('13.cli2 the FULL report is in REHEARSAL_DIR and keeps the detail the committed one drops', async () => {
    const { db } = await seeded();
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-800)).toBe(0);
    const full = path.join(dir, `${db}.full-report.md`);
    expect(existsSync(full), `no full report at ${full}`).toBe(true);
    expect(readFileSync(full, 'utf8')).toContain('SENTINELAMOUNT7654.32');
  }, 180_000);

  it('13.cli3 nothing but the two reports and the journal is written (no repo file, nothing outside --out-dir / REHEARSAL_DIR)', async () => {
    const { db } = await seeded();
    const before = files(outDir).length;
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-800)).toBe(0);
    expect(files(outDir).length - before).toBeLessThanOrEqual(1);
  }, 180_000);
});

describe('T-394 S2 - report exits 1 when the journal is not a clean, complete record', () => {
  it('a journal check that is FAIL: exit 1, names the check', async () => {
    const { db } = await seeded({ fail: true });
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-500)).toBe(1);
    expect(r.text).toContain('tie_out');
  }, 180_000);

  it('a journal that is missing an expected check (freeze): exit 1, names it (a skipped verify is not a pass)', async () => {
    const { db } = await seeded({ omit: 'freeze' });
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-500)).toBe(1);
    expect(r.text).toContain('freeze');
  }, 180_000);

  it('the control: every expected check present and PASS: exit 0', async () => {
    const { db } = await seeded();
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-500)).toBe(0);
  }, 180_000);
});

describe('T-394 S2 - the full report, the journal and REHEARSAL_DIR are private (POSIX modes)', () => {
  it.skipIf(process.platform === 'win32')('full report and journal are mode 600, REHEARSAL_DIR is 700 after report, even if they started wider', async () => {
    const { db } = await seeded();
    chmodSync(dir, 0o755);
    chmodSync(journalPath(dir, db), 0o644);
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-500)).toBe(0);
    const mode = (f: string): number => statSync(f).mode & 0o777;
    expect(mode(path.join(dir, `${db}.full-report.md`)).toString(8), 'full report').toBe('600');
    expect(mode(journalPath(dir, db)).toString(8), 'journal').toBe('600');
    expect(mode(dir).toString(8), 'REHEARSAL_DIR').toBe('700');
  }, 180_000);
});

describe('T-394 S2 I10c - report fails when a terminal was touched after start', () => {
  it('a clock_terminals row created after start: exit 1, names the table', async () => {
    const { db } = await seeded({ terminal: true });
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    expect(r.text).toContain('clock_terminals');
  }, 180_000);

  it('an attendance_punches row inserted after start: exit 1, names the table (mutant: terminals only)', async () => {
    const { db, fx } = await seeded();
    const s = connect(db);
    try {
      const [e] = await s<{ id: string }[]>`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${fx.orgId}, ${fx.storeId}, ${fx.personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2026-01-01') returning id`;
      await s`
        insert into attendance_punches (org_id, store_id, person_id, employment_id, client_punch_id, occurred_at, shift_day, method, asserted_intent, source)
        values (${fx.orgId}, ${fx.storeId}, ${fx.personId}, ${e!.id}, ${uid('cp')}, now(), current_date, 'manual', 'in', 'manual_entry')`;
    } finally {
      await s.end({ timeout: 5 });
    }
    const r = cli(['report', '--out-dir', outDir], db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    expect(r.text).toContain('attendance_punches');
  }, 180_000);
});

describe('T-394 S2 - report is guarded like every other subcommand', () => {
  it('a typed name that differs is refused with exit 2 and writes no report', async () => {
    const db = await newRehearsalDb();
    writeJournalFile(db);
    const before = files(outDir).length;
    const r = cli(['report', '--out-dir', outDir], 'shareat_rehearsal_20991114', { REHEARSAL_DATABASE_URL: urlFor(db) });
    expect(r.status, r.text.slice(-400)).toBe(2);
    expect(files(outDir).length).toBe(before);
  }, 180_000);
});

void postgres;
