/**
 * T-636 - tick each government contribution on or off, per person (docs/tasks/636-statutory-toggles.md). Unit level, no database:
 * - `agenciesToSkip` (pure): unticked OR missing skips the agency; only MISSING is a warning.
 * - `computeStatutory` fed by it: an unticked SSS is zero on both sides while PhilHealth and Pag-IBIG are computed; net = gross - deductions.
 * - `setStatutoryDeductions` with the database and the capability check as spies: authorize first, the audit row's before/after, nothing on no change.
 * The DB-backed cases are in integration/t190-statutory.test.ts ("T-636"): CI runs them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const state = { refuse: false, current: { deductSss: true, deductPhilhealth: true, deductPagibig: true } as Record<string, boolean> | undefined };
const append = vi.fn(async (..._a: unknown[]) => {
  calls.push('audit');
});

vi.mock('@shareat/auth', async (orig) => {
  const real = await orig<typeof import('@shareat/auth')>();
  return {
    ...real,
    authorize: vi.fn(async (_tx: unknown, _actor: unknown, cap: string, scope: unknown) => {
      calls.push(`authorize:${cap}:${JSON.stringify(scope)}`);
      if (state.refuse) throw new real.AuthorizationError(`test: no ${cap}`, cap as never);
    }),
  };
});
vi.mock('@shareat/db', async (orig) => {
  const real = await orig<typeof import('@shareat/db')>();
  return {
    ...real,
    auditLogRepo: { append },
    statutoryRepo: {
      ...real.statutoryRepo,
      lockPersons: vi.fn(async () => calls.push('lock')),
      governmentIdsFor: vi.fn(async () => {
        calls.push('read');
        return state.current ? [{ personId: 'p1', sssNo: '1234567890', philhealthNo: null, pagibigNo: null, tin: null, ...state.current }] : [];
      }),
      setStatutoryDeductions: vi.fn(async (_tx: unknown, _org: string, _p: string, flags: unknown) => {
        calls.push(`write:${JSON.stringify(flags)}`);
        return true;
      }),
    },
  };
});

const { AuthorizationError } = await import('@shareat/auth');
const { money, ZERO, add, subtract } = await import('@shareat/core/money');
const { agenciesToSkip, computeStatutory, setStatutoryDeductions } = await import('../src/payroll');
type Rate = Parameters<typeof computeStatutory>[0]['rates']['sss'];

const ALL = { sssNo: '1234567890', philhealthNo: '123456789012', pagibigNo: '210987654321', deductSss: true, deductPhilhealth: true, deductPagibig: true };

describe('agenciesToSkip (pure)', () => {
  it('test 1 (rule): SSS unticked with its number on file is skipped, as a choice, not missing', () => {
    expect(agenciesToSkip({ ...ALL, deductSss: false })).toEqual({ skipped: ['sss'], missing: [], unticked: ['sss'] });
  });

  it('test 2 (rule): unticked with a number is not missing; a missing number with the tick on is', () => {
    expect(agenciesToSkip({ ...ALL, sssNo: null, deductPagibig: false })).toEqual({ skipped: ['sss', 'pagibig'], missing: ['sss'], unticked: ['pagibig'] });
    // unticked AND missing: the untick explains it, so no warning for a number nobody will use
    expect(agenciesToSkip({ ...ALL, philhealthNo: null, deductPhilhealth: false })).toEqual({ skipped: ['philhealth'], missing: [], unticked: ['philhealth'] });
  });

  it('test 3 (rule): every tick on and every number on file skips nothing; no facts at all = every agency missing, as before', () => {
    expect(agenciesToSkip(ALL)).toEqual({ skipped: [], missing: [], unticked: [] });
    expect(agenciesToSkip(undefined)).toEqual({ skipped: ['sss', 'philhealth', 'pagibig'], missing: ['sss', 'philhealth', 'pagibig'], unticked: [] });
  });
});

describe('the payslip with SSS unticked', () => {
  const row = (over: Partial<Rate> & Pick<Rate, 'agency'>): Rate =>
    ({ id: `rate-${over.agency}`, effectiveFrom: '2026-01-01', eeRate: '0', erRate: '0', baseKind: 'basic', floor: null, ceiling: null, step: null, lowThreshold: null, lowEeRate: null, ecThreshold: null, ecLow: null, ecHigh: null, ...over }) as Rate;
  const RATES = {
    sss: row({ agency: 'sss', eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', step: '500', ecThreshold: '15000', ecLow: '10', ecHigh: '30' }),
    philhealth: row({ agency: 'philhealth', eeRate: '0.025', erRate: '0.025', floor: '10000', ceiling: '100000' }),
    pagibig: row({ agency: 'pagibig', eeRate: '0.02', erRate: '0.02', floor: '0', ceiling: '10000', lowThreshold: '1500', lowEeRate: '0.01' }),
  };
  const zero = { base: ZERO, ee: ZERO, er: ZERO, ec: ZERO };

  it('test 1: SSS ee/er/EC are 0 while PhilHealth 260 and Pag-IBIG 200 are computed; net = gross - deductions', () => {
    const r = computeStatutory({
      basicPay: money('10400.00'),
      grossPay: money('10400.00'),
      isMwe: false,
      rates: RATES,
      prior: { sss: zero, philhealth: zero, pagibig: zero },
      skipped: agenciesToSkip({ ...ALL, deductSss: false }).skipped,
      brackets: [{ over: '0', baseTax: '0', rate: '0' }],
      advanceOutstanding: ZERO,
    });
    expect(r.sss).toEqual({ ee: '0.00', er: '0.00', ec: '0.00' });
    expect(r.philhealth).toEqual({ ee: '260.00', er: '260.00' });
    expect(r.pagibig).toEqual({ ee: '200.00', er: '200.00' });
    const deductions = [r.sss.ee, r.philhealth.ee, r.pagibig.ee, r.withholding, r.advanceRecovered].reduce((a, b) => add(a, b), ZERO);
    expect(r.netPay).toBe(subtract(money('10400.00'), deductions));
    expect(r.netPay).toBe('9940.00');
  });
});

describe('setStatutoryDeductions', () => {
  const actor = { orgId: 'org-1', personId: 'manager-1' } as never;
  const input = { personId: 'p1', storeId: 'store-1', deductSss: false, deductPhilhealth: true, deductPagibig: false };
  beforeEach(() => {
    calls.length = 0;
    append.mockClear();
    state.refuse = false;
    state.current = { deductSss: true, deductPhilhealth: true, deductPagibig: true };
  });

  it('test 4: authorize (enrol_staff at the store) comes first; refused = nothing read, written or audited', async () => {
    state.refuse = true;
    await expect(setStatutoryDeductions({} as never, actor, input)).rejects.toBeInstanceOf(AuthorizationError);
    expect(calls).toEqual(['authorize:enrol_staff:{"storeId":"store-1"}']);
  });

  it('test 4: one audit row with before/after of the CHANGED ticks only', async () => {
    expect(await setStatutoryDeductions({} as never, actor, input)).toEqual({ changed: ['deductSss', 'deductPagibig'] });
    expect(calls).toEqual(['authorize:enrol_staff:{"storeId":"store-1"}', 'lock', 'read', 'write:{"deductSss":false,"deductPhilhealth":true,"deductPagibig":false}', 'audit']);
    expect(append.mock.calls[0]![2]).toEqual({
      actorPersonId: 'manager-1',
      action: 'person.statutory_deduction_set',
      storeId: 'store-1',
      entityId: 'p1',
      before: { deductSss: true, deductPagibig: true },
      after: { deductSss: false, deductPagibig: false },
      source: 'web',
    });
  });

  it('the same ticks again write nothing and audit nothing', async () => {
    state.current = { deductSss: false, deductPhilhealth: true, deductPagibig: false };
    expect(await setStatutoryDeductions({} as never, actor, input)).toEqual({ changed: [] });
    expect(calls.some((c) => c.startsWith('write'))).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('a person not in the org is refused in words', async () => {
    state.current = undefined;
    await expect(setStatutoryDeductions({} as never, actor, input)).rejects.toMatchObject({ userMessage: expect.stringContaining('That person') });
  });
});
