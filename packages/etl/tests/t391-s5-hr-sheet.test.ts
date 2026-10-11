/**
 * T-391 S5 (TESTER) - the HR sheet validator behind `validate-hr`. Pure: no database, no network, no file access.
 * docs/tasks/391-production-master-data-load.md, S7, R15, test 11, invariant I8.
 *
 * CONTRACT these tests pin:
 *   packages/etl/src/master-data/hr-sheet.ts
 *     validateHr({ roster: Row[], rates: Row[] })
 *       -> { rows: Row[], errors: Array<{ person: string, column: string, message: string }>, complete: number, total: number, summary: string }
 *       roster : parsed staff-roster.csv rows (columns in the spec §Contract)
 *       rates  : parsed v1-staff-rates.local.csv rows (columns written by extract: v1_store_id, v1_staff_id, staff_code, full_name,
 *                pay_type, daily_rate, hourly_rate, monthly_rate, daily_/hourly_/monthly_rate_effective_from; S14c: keyed by `person_ref`, NOT v1_staff_id;
 *                S14c: summary also names roster persons with no rate row; S14f: rate_effective_from = the person's own basis date, else blank)
 *       rows      : the roster rows with pay_basis / rate / rate_effective_from merged in from the rates row whose v1_staff_id equals the
 *                   roster's person_ref; ids come back as typed (the caller writes them to the local file, never to the server)
 *       errors    : one per failed column; `person` is the full_name, `column` the roster column; `message` shows at most the LAST 4 digits
 *       complete  : persons whose four id columns (sss_no, philhealth_no, pagibig_no, tin) are all present and valid; total = roster rows
 *       summary   : exactly `${complete} of ${total} complete` appears in it
 *     Valid ids: sss 10 digits, philhealth 12, pagibig 12, tin 9 or 12; dashes and spaces ignored. A blank id is "incomplete", not an error.
 *     The same id on two persons is an error naming BOTH people.
 *
 * Red today: the module does not exist, so each test fails on its dynamic import, inside the test.
 */
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const COLS = ['row_key', 'person_ref', 'full_name', 'store_code', 'positions', 'primary_position', 'employment_status', 'started_on', 'staff_code', 'sss_no', 'philhealth_no', 'pagibig_no', 'tin', 'pay_basis', 'rate', 'rate_effective_from', 'hr_note'];
let n = 0;
const person = (name: string, over: Record<string, string> = {}): Record<string, string> => {
  const base: Record<string, string> = Object.fromEntries(COLS.map((c) => [c, '']));
  return {
    ...base,
    row_key: `k${String(++n).padStart(12, '0')}`,
    person_ref: `st${n}`,
    full_name: name,
    store_code: 'LIPA',
    started_on: '2026-01-05',
    // unique per person, so only a deliberate duplicate is a duplicate
    sss_no: `50${String(1000000 + n * 7).slice(0, 7)}1`,
    philhealth_no: `2${String(10000000000 + n * 13).slice(0, 11)}`,
    pagibig_no: `3${String(10000000000 + n * 17).slice(0, 11)}`,
    tin: `4${String(10000000 + n * 19).slice(0, 8)}`,
    ...over,
  };
};
async function run(roster: Any[], rates: Any[] = []): Promise<Any> {
  const mod: Any = await import('../src/master-data/hr-sheet');
  return mod.validateHr({ roster, rates });
}
const errFor = (r: Any, name: string, column: string): Any => r.errors.find((e: Any) => e.person === name && e.column === column);

describe('11a. each id: its valid and its invalid forms', () => {
  it.each([
    ['sss_no', '3412345678', true],
    ['sss_no', '34-1234567-8', true],
    ['sss_no', '34 1234567 8', true],
    ['sss_no', '341234567', false], // off by one, short
    ['sss_no', '34123456789', false], // off by one, long
    ['philhealth_no', '123456789012', true],
    ['philhealth_no', '12-345678901-2', true],
    ['philhealth_no', '12345678901', false],
    ['philhealth_no', '1234567890123', false],
    ['pagibig_no', '123456789012', true],
    ['pagibig_no', '1234-5678-9012', true],
    ['pagibig_no', '12345678901', false],
    ['pagibig_no', '1234567890123', false],
    ['tin', '123456789', true],
    ['tin', '123-456-789-000', true],
    ['tin', '12345678', false],
    ['tin', '1234567890', false], // 10: neither 9 nor 12
    ['tin', '12345678901', false], // 11
    ['tin', '1234567890123', false], // 13
    ['sss_no', '34-12345A7-8', false], // a letter
  ])('%s %s -> valid: %s. Mutant: an off-by-one length', async (column, value, ok) => {
    const r = await run([person('Test Person', { [column]: value })]);
    expect(Boolean(errFor(r, 'Test Person', column))).toBe(!ok);
    expect(r.complete).toBe(ok ? 1 : 0);
    expect(r.total).toBe(1);
  });
});

describe('11b. completeness, blanks, duplicates', () => {
  it('N of M complete: a blank id is incomplete but is not an error; a malformed one is both', async () => {
    const r = await run([person('Whole One'), person('Blank Two', { tin: '' }), person('Bad Three', { sss_no: '123' })]);
    expect(r.total).toBe(3);
    expect(r.complete).toBe(1);
    expect(r.summary).toContain('1 of 3 complete');
    expect(errFor(r, 'Blank Two', 'tin')).toBeUndefined();
    expect(errFor(r, 'Bad Three', 'sss_no')).toBeDefined();
  });

  it('the same SSS on two persons is refused by BOTH names (also when typed with and without dashes). Mutant: duplicates ignored', async () => {
    const r = await run([person('Dup Alpha', { sss_no: '34-1234567-8' }), person('Dup Beta', { sss_no: '3412345678' }), person('Other Gamma', { sss_no: '3499999999' })]);
    const dup = r.errors.filter((e: Any) => e.column === 'sss_no');
    const text = JSON.stringify(dup);
    expect(text).toContain('Dup Alpha');
    expect(text).toContain('Dup Beta');
    expect(text).not.toContain('Other Gamma');
    expect(r.complete).toBe(1);
  });

  it('the same id in DIFFERENT columns (an SSS equal to someone\'s TIN) is not a duplicate', async () => {
    const r = await run([person('One', { sss_no: '3412345678' }), person('Two', { tin: '341234567', sss_no: '3498765432' })]);
    expect(r.errors).toHaveLength(0);
  });
});

describe('11c. an error never echoes a full id (I8)', () => {
  it('the message shows at most the last 4 digits. Mutant: the full id echoed', async () => {
    const BAD_PH = '12345678901'; // 11 digits
    const BAD_SSS = '341234567'; // 9 digits
    const r = await run([person('Echo Ed', { philhealth_no: BAD_PH, sss_no: BAD_SSS }), person('Twin Tess', { sss_no: '3411111111' }), person('Twin Tom', { sss_no: '3411111111' })]);
    const text = JSON.stringify(r.errors);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    for (const full of [BAD_PH, BAD_SSS, '3411111111', '34-1111111-1']) expect(text).not.toContain(full);
    for (const e of r.errors) {
      const runs = String(e.message).match(/\d+/g) ?? [];
      for (const d of runs) expect(d.length).toBeLessThanOrEqual(4);
    }
    expect(JSON.stringify(errFor(r, 'Echo Ed', 'philhealth_no'))).toContain('Echo Ed');
  });
});

describe('11d. rates are merged from the local file, never invented', () => {
  const rate = (id: string, over: Record<string, string> = {}): Record<string, string> => ({
    v1_store_id: 'b9DzsnPbr1BUnY88lyT4', person_ref: id, staff_code: 'SE-001', full_name: 'x', pay_type: 'hourly',
    daily_rate: '', hourly_rate: '81.25', monthly_rate: '', hourly_rate_effective_from: '2026-01-01', daily_rate_effective_from: '', monthly_rate_effective_from: '', ...over,
  });

  it('pay_basis, rate and rate_effective_from come from the rates row whose person_ref equals the roster person_ref (S14c: same key; the group key for a grouped person); unmatched persons stay blank', async () => {
    const a = person('Rated Rae');
    const b = person('Unrated Ray');
    const r = await run([a, b], [rate(a.person_ref!), rate('someone-else', { hourly_rate: '55.5' })]);
    const ra = r.rows.find((x: Any) => x.full_name === 'Rated Rae');
    const rb = r.rows.find((x: Any) => x.full_name === 'Unrated Ray');
    expect(ra.pay_basis).toBe('hourly');
    expect(ra.rate).toBe('81.25');
    expect(ra.rate_effective_from).toBe('2026-01-01');
    expect(rb.pay_basis).toBe('');
    expect(rb.rate).toBe('');
    expect(JSON.stringify(r.rows)).not.toContain('55.5');
  });

  it('S13: a blank person_ref (roster) or blank person_ref (rates) matches nothing and is incomplete, not an error; a grouped person matches on the group key', async () => {
    const blank = person('Blank Ref', { person_ref: '' });
    const grp = person('Group Gus', { person_ref: 'grpkey7' });
    const r = await run([blank, grp], [rate('', { hourly_rate: '12.34' }), rate('grpkey7', { hourly_rate: '70' })]);
    expect(r.errors.filter((e: Any) => e.person === 'Blank Ref' && e.column === 'person_ref')).toHaveLength(0);
    expect(r.rows.find((x: Any) => x.full_name === 'Blank Ref').rate).toBe('');
    expect(r.rows.find((x: Any) => x.full_name === 'Group Gus').rate).toBe('70');
    expect(JSON.stringify(r.rows)).not.toContain('12.34');
  });

  it('a daily-paid person takes the daily rate', async () => {
    const a = person('Daily Dee');
    const r = await run([a], [rate(a.person_ref!, { pay_type: 'daily', daily_rate: '610', hourly_rate: '' })]);
    expect(r.rows[0].pay_basis).toBe('daily');
    expect(r.rows[0].rate).toBe('610');
  });

  it('a rate never appears in an error message or the summary', async () => {
    const a = person('Rated Rae', { sss_no: '12' });
    const r = await run([a], [rate(a.person_ref!)]);
    expect(JSON.stringify({ e: r.errors, s: r.summary })).not.toContain('81.25');
  });
});


describe('S14c / S14f rates keyed by person_ref, the summary names the unrated, the date follows the basis', () => {
  const rt = (ref: string, over: Record<string, string> = {}): Record<string, string> => ({
    v1_store_id: 'b9DzsnPbr1BUnY88lyT4', person_ref: ref, staff_code: 'SE-001', full_name: 'x', pay_type: 'hourly',
    daily_rate: '', hourly_rate: '', monthly_rate: '', hourly_rate_effective_from: '', daily_rate_effective_from: '', monthly_rate_effective_from: '', ...over,
  });

  it('a grouped person rate row keyed by the group key merges; a row keyed only by a v1 staff id of that group does not. Mutant: keyed by v1_staff_id', async () => {
    const g = person('Group Gus', { person_ref: 'grpkey7' });
    const r = await run([g], [rt('grpkey7', { hourly_rate: '70', hourly_rate_effective_from: '2026-02-02' }), { ...rt('', { hourly_rate: '5' }), v1_staff_id: 'grpkey7-member' }]);
    expect(r.rows[0].rate).toBe('70');
    expect(r.rows[0].rate_effective_from).toBe('2026-02-02');
  });

  it('the summary names the roster persons with no rate row (and only them), never a rate', async () => {
    const a = person('Rated Rae');
    const b = person('Unrated Ray');
    const c = person('Unrated Uma');
    const r = await run([a, b, c], [rt(a.person_ref!, { hourly_rate: '81.25' })]);
    expect(r.summary).toContain('Unrated Ray');
    expect(r.summary).toContain('Unrated Uma');
    expect(r.summary).not.toContain('Rated Rae');
    expect(r.summary).not.toContain('81.25');
  });

  it.each([
    ['daily', { daily_rate: '610', daily_rate_effective_from: '2026-03-03', hourly_rate_effective_from: '2026-01-01', monthly_rate_effective_from: '2026-02-02' }, '610', '2026-03-03'],
    ['monthly', { monthly_rate: '18000', monthly_rate_effective_from: '2026-02-02', hourly_rate_effective_from: '2026-01-01', daily_rate_effective_from: '2026-03-03' }, '18000', '2026-02-02'],
    ['hourly', { hourly_rate: '81.25', hourly_rate_effective_from: '2026-01-01', daily_rate_effective_from: '2026-03-03', monthly_rate_effective_from: '2026-02-02' }, '81.25', '2026-01-01'],
  ])('%s basis: rate_effective_from is that basis own date. Mutant: always the hourly date', async (basis, over, rateVal, date) => {
    const a = person('Basis Bo');
    const r = await run([a], [rt(a.person_ref!, { pay_type: basis, ...over })]);
    expect(r.rows[0]).toMatchObject({ pay_basis: basis, rate: rateVal, rate_effective_from: date });
  });

  it.each(['daily', 'monthly'])('%s basis with only ANOTHER basis date filled: rate_effective_from is blank, never the other date', async (basis) => {
    const a = person('Fallback Fe');
    const other: Record<string, string> = basis === 'daily' ? { monthly_rate_effective_from: '2026-02-02' } : { daily_rate_effective_from: '2026-03-03' };
    const r = await run([a], [rt(a.person_ref!, { pay_type: basis, [`${basis}_rate`]: '500', hourly_rate_effective_from: '2026-01-01', ...other })]);
    expect(r.rows[0].rate).toBe('500');
    expect(r.rows[0].rate_effective_from).toBe('');
  });
});
