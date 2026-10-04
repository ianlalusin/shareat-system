import { describe, expect, it, vi } from 'vitest';

/**
 * T-374 S2 / DEF-577 - the helpers that take `now`. Manila is UTC+8: 02:00 on 1 April 2026 is 18:00 UTC on 31 March,
 * so a helper that reads the UTC calendar answers "31 March" for the first eight hours of every Manila day.
 *
 * ⭐ RED FIRST on HEAD (U1, U2); U3/U4 are the positive controls - at 12:00 Manila (04:00 UTC) both calendars agree,
 * so the answer must be the same before and after the fix.
 */
// The libs import server-only data modules; the helpers under test are pure, so stub the I/O edges.
vi.mock('@shareat/db', () => ({ tillShiftsRepo: {}, payrollRepo: {} }));
vi.mock('@shareat/domain', () => ({
  derivePeriods: (
    cfg: { payrollPeriodType: string; semiMonthlyCutoffDay: number },
    y: number,
    m: number,
  ) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ym = `${y}-${pad(m)}`;
    return cfg.payrollPeriodType === 'monthly'
      ? [{ start: `${ym}-01`, end: `${ym}-${pad(last)}` }]
      : [
          { start: `${ym}-01`, end: `${ym}-${pad(cfg.semiMonthlyCutoffDay)}` },
          { start: `${ym}-${pad(cfg.semiMonthlyCutoffDay + 1)}`, end: `${ym}-${pad(last)}` },
        ];
  },
  payoutDateFor: () => '',
  previewPayRun: async () => null,
}));
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: async () => null, listStores: async () => [], listActingPersons: async () => [] }));
vi.mock('@/lib/constraint-messages', () => ({ errorMessage: (e: unknown) => String(e) }));

import { today } from '../src/app/till/lib';
import { currentPeriod, periodsForMonth } from '../src/app/payroll/lib';

const MANILA_2AM_APR_1 = new Date('2026-03-31T18:00:00Z'); // business date 2026-04-01
const MANILA_NOON_APR_1 = new Date('2026-04-01T04:00:00Z'); // business date 2026-04-01, UTC date the same
const CFG = { payrollPeriodType: 'semi_monthly' as const, semiMonthlyCutoffDay: 15 };

describe('U1: the till trading-date default is the Manila date', () => {
  it('02:00 Manila on 1 April is 2026-04-01 (HEAD: 2026-03-31)', () => {
    expect(today(MANILA_2AM_APR_1)).toBe('2026-04-01');
  });
});

describe('U2: the payroll form opens on the Manila month', () => {
  it('periodsForMonth at 02:00 Manila on 1 April lists April (HEAD: March)', () => {
    const p = periodsForMonth(CFG, MANILA_2AM_APR_1);
    expect(p.map((x) => x.start)).toEqual(['2026-04-01', '2026-04-16']);
  });
  it('currentPeriod at 02:00 Manila on 1 April is the first April period (HEAD: the last March period / first of March)', () => {
    expect(currentPeriod(CFG, MANILA_2AM_APR_1).start).toBe('2026-04-01');
  });
  it('currentPeriod at 02:00 Manila on 1 January opens on January of the NEW year', () => {
    expect(currentPeriod(CFG, new Date('2025-12-31T18:00:00Z')).start).toBe('2026-01-01');
  });
});

describe('U2b: the mid-month boundary', () => {
  it('02:00 Manila on 16 April (18:00 UTC on the 15th) is in the second half (HEAD: the first)', () => {
    expect(currentPeriod(CFG, new Date('2026-04-15T18:00:00Z')).start).toBe('2026-04-16');
  });
});

describe('U3/U4 controls: at 12:00 Manila both calendars agree, so nothing may change', () => {
  it('till today', () => {
    expect(today(MANILA_NOON_APR_1)).toBe('2026-04-01');
  });
  it('payroll periods and current period', () => {
    expect(periodsForMonth(CFG, MANILA_NOON_APR_1).map((x) => x.start)).toEqual(['2026-04-01', '2026-04-16']);
    expect(currentPeriod(CFG, MANILA_NOON_APR_1).start).toBe('2026-04-01');
  });
  it('12:00 Manila on 16 April: second half, both calendars', () => {
    expect(currentPeriod(CFG, new Date('2026-04-16T04:00:00Z')).start).toBe('2026-04-16');
  });
});
