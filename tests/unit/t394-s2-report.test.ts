import { describe, expect, it } from 'vitest';

/**
 * T-394 S2 - the rehearsal report, pure part (invariants 12, 13 and R10; docs/tasks/394-purge-and-opening-rehearsal.md s4 R9/R10,
 * s6). Written TESTER-FIRST: red with "Cannot find module scripts/lib/rehearsal/report" until the builder lands S2.
 *
 * ## Pinned contract (scripts/lib/rehearsal/report.ts) - the S1 "function signatures in the test header are the contract" ruling
 *   export interface ReportInput {
 *     database: string;                       // shareat_rehearsal_YYYYMMDD (a name, never a URL)
 *     generatedAt: string;                    // ISO instant
 *     steps: { code: string; startedAt: string; endedAt?: string; by?: string; result?: string }[];   // journal steps; `by` is a personId
 *     checks: { name: string; ok: boolean; detail: string }[];   // detail is FREE TEXT from the checks (may hold names, costs): FULL report only
 *     classCounts: { class: string; tables: number; rows: number }[];                   // counts per cutover class
 *     accountTotals: { orgId: string; code: string; debit: string; credit: string }[];  // numeric text, account CODES only
 *     migrations: string[];                   // migration list (names/tags)
 *     people: { id: string; displayName: string }[];   // lets the FULL report name people; the sanitised one never may
 *   }
 *   export function buildReports(input: ReportInput): { sanitised: string; full: string };
 *   export function reportFileName(generatedAt: string): string;   // 'cutover-rehearsal-YYYY-MM-DD.md', Manila business date
 * A step line shows its code and either whole seconds (Math.round of end - start) or the words NOT TIMED (never 0).
 * A check line shows its name and PASS or FAIL. The sanitised report carries NO check detail, no people, no connection string.
 */

import { buildReports, reportFileName } from '../../scripts/lib/rehearsal/report';

const NAME = 'SENTINELNAME Maria Dela Cruz';
const EMAIL = 'sentinel.person@example.invalid';
const PHONE = '+639171234567';
const HASH = 'pbkdf2$310000$SENTINELHASHabcdef0123456789';
const URLPW = 'postgresql://svc_user:SENTINELPASSWORD@db.example.invalid:25060/shareat_rehearsal_20261113';
const COST = 'SENTINELSUPPLIERCOST 48.7500 per kg';
const PID = '11111111-2222-3333-4444-555555555555';

const base = () => ({
  database: 'shareat_rehearsal_20261113',
  generatedAt: '2026-11-13T09:30:00.000Z',
  steps: [
    { code: 'migrate', startedAt: '2026-11-13T08:00:00.000Z', endedAt: '2026-11-13T08:01:30.400Z', result: 'pass' } as { code: string; startedAt: string; endedAt?: string; by?: string; result?: string },
    { code: 'C3', startedAt: '2026-11-13T08:10:00.000Z', by: PID } as { code: string; startedAt: string; endedAt?: string; by?: string; result?: string },
    { code: 'C5', startedAt: '2026-11-13T08:20:00.000Z', endedAt: '2026-11-13T08:20:00.000Z', by: PID, result: 'done' } as { code: string; startedAt: string; endedAt?: string; by?: string; result?: string },
  ],
  checks: [
    { name: 'tie_out', ok: false, detail: `Stock at Lipa comes to ₱100.00; ${NAME} ${EMAIL} ${PHONE} ${HASH} ${URLPW} ${COST}` },
    { name: 'app_role', ok: true, detail: 'role t394_app has no bypass' },
  ],
  classCounts: [
    { class: 'purge', tables: 90, rows: 0 },
    { class: 'keep', tables: 70, rows: 1234 },
  ],
  accountTotals: [{ orgId: '99999999-0000-0000-0000-000000000001', code: '3900', debit: '0.00', credit: '4567.89' }],
  migrations: ['0193_alpha', '0194_beta'],
  people: [{ id: PID, displayName: NAME }],
});

const line = (text: string, needle: string): string => text.split('\n').find((l) => l.includes(needle)) ?? '';

describe('T-394 S2 I12 - every step is timed in whole seconds or named NOT TIMED', () => {
  it('12.a a step with both marks shows whole seconds from the marks (90.4 s -> 90)', () => {
    const { sanitised, full } = buildReports(base());
    for (const t of [sanitised, full]) expect(line(t, 'migrate'), t).toMatch(/\b90\b/);
  });

  it('12.b a step with no end mark is reported NOT TIMED and never as zero (mutant: missing end treated as zero)', () => {
    const { sanitised, full } = buildReports(base());
    for (const t of [sanitised, full]) {
      const l = line(t, 'C3');
      expect(l, `no line for C3 in:\n${t}`).not.toBe('');
      expect(l).toContain('NOT TIMED');
      expect(l).not.toMatch(/(^|\D)0\s*(s|sec|seconds)\b/i);
    }
  });

  it('12.c a step that ended the instant it started is a real 0, not NOT TIMED', () => {
    const l = line(buildReports(base()).sanitised, 'C5');
    expect(l).not.toContain('NOT TIMED');
    expect(l).toMatch(/(^|\D)0(\D|$)/);
  });

  it('12.d with no end mark on ANY step the report still lists every step code as NOT TIMED', () => {
    const input = base();
    input.steps = input.steps.map((s) => ({ code: s.code, startedAt: s.startedAt }));
    const { sanitised } = buildReports(input);
    for (const c of ['migrate', 'C3', 'C5']) expect(line(sanitised, c)).toContain('NOT TIMED');
  });
});

describe('T-394 S2 I13 / R10 - the committed report is sanitised by construction', () => {
  it('13.a no person name, email, phone, hash, password URL, check detail or cost appears in the sanitised report', () => {
    const { sanitised } = buildReports(base());
    for (const s of [NAME, 'SENTINELNAME', EMAIL, PHONE, HASH, 'SENTINELHASH', URLPW, 'SENTINELPASSWORD', 'svc_user', COST, 'SENTINELSUPPLIERCOST', 'Stock at Lipa', '₱100.00', 'postgresql://']) {
      expect(sanitised.includes(s), `sanitised report leaks "${s}"`).toBe(false);
    }
  });

  it('13.b the --by person appears as the id, never the name (mutant: name instead of id)', () => {
    const { sanitised } = buildReports(base());
    expect(sanitised).toContain(PID);
    expect(sanitised).not.toContain(NAME);
  });

  it('13.c what R10 allows IS there: counts per class, durations, PASS/FAIL per check, account codes with totals, the migration list', () => {
    const { sanitised } = buildReports(base());
    expect(sanitised).toContain('1234');
    expect(sanitised).toContain('purge');
    expect(line(sanitised, 'tie_out')).toContain('FAIL');
    expect(line(sanitised, 'app_role')).toContain('PASS');
    expect(line(sanitised, '3900')).toMatch(/4567\.89/);
    expect(sanitised).toContain('0193_alpha');
    expect(sanitised).toContain('0194_beta');
    expect(sanitised).toContain('shareat_rehearsal_20261113');
  });

  it('13.d the FULL report is the one that keeps the detail (it is not the same text)', () => {
    const { sanitised, full } = buildReports(base());
    expect(full).not.toBe(sanitised);
    expect(full).toContain('Stock at Lipa comes to ₱100.00');
    expect(full).toContain('4567.89');
    expect(full).toContain('1234');
  });

  it('13.e a password-bearing URL inside a check detail cannot reach the sanitised report', () => {
    const input = base();
    input.checks = [{ name: 'tie_out', ok: true, detail: URLPW }];
    expect(buildReports(input).sanitised).not.toContain('SENTINELPASSWORD');
  });
});

describe("T-394 S2 - the committed report's file name is dated in Manila, not UTC", () => {
  it('reportFileName: 2026-11-13T09:30Z -> cutover-rehearsal-2026-11-13.md', () => {
    expect(reportFileName('2026-11-13T09:30:00.000Z')).toBe('cutover-rehearsal-2026-11-13.md');
  });
  it('reportFileName: 2026-12-31T17:00Z is 01:00 on 1 Jan in Manila (mutant: toISOString().slice(0, 10))', () => {
    expect(reportFileName('2026-12-31T17:00:00.000Z')).toBe('cutover-rehearsal-2027-01-01.md');
  });
});
