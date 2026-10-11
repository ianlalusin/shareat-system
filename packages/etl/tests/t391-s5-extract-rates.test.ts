/**
 * T-391 S5 (TESTER) - the rates file `extract` writes is the file `validate-hr` reads (S13, S14c, S14f).
 * docs/tasks/391-production-master-data-load.md, R15, S7.
 *
 * CONTRACT: runExtract writes `v1-staff-rates.local.csv` (in ratesDir) with these columns, one row per v1 staff record:
 *   person_ref (the staffIdentities group KEY for a grouped person, else the v1 staff id - the same key the staff-roster sheet carries),
 *   v1_store_id, staff_code, full_name, pay_type, daily_rate, hourly_rate, monthly_rate,
 *   daily_rate_effective_from, hourly_rate_effective_from, monthly_rate_effective_from.
 * Fed straight into validateHr with the roster planStaff emits from the same snapshot, every person with a rate row merges its rate and
 * the date of its own basis.
 *
 * Red today: the file is keyed by v1_staff_id and has only hourly_rate_effective_from, so nobody matches.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReadOnlyV1Client, runExtract } from '../src/master-data/snapshot';
import { parseCsv } from '../src/master-data/sheets';
import { parseStoreMap } from '../src/master-data/store-map';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';

const DATA: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {
  stores: [{ id: L, data: { name: 'SharEat Lipa' } }, { id: M, data: { name: 'SharEat Malvar' } }],
  [`stores/${L}/staff`]: [
    { id: 'st1', data: { staffCode: 'SE-001', fullName: 'Grace Group', positions: ['Cook'], employmentStatus: 'regular', dateHired: '2025-01-05', isActive: true, payType: 'daily', dailyRate: 611, dailyRateEffectiveFrom: '2025-03-03', hourlyRateEffectiveFrom: '2025-01-01' } },
    { id: 'st3', data: { staffCode: 'SE-002', fullName: 'Sol Solo', positions: ['Cook'], employmentStatus: 'regular', dateHired: '2025-01-05', isActive: true, payType: 'monthly', monthlyRate: 18123, monthlyRateEffectiveFrom: '2025-02-02', hourlyRateEffectiveFrom: '2025-01-01' } },
    { id: 'st4', data: { staffCode: 'SE-003', fullName: 'Hal Hourly', positions: ['Cook'], employmentStatus: 'regular', dateHired: '2025-01-05', isActive: true, payType: 'hourly', hourlyRate: 77.77, hourlyRateEffectiveFrom: '2025-04-04' } },
  ],
  [`stores/${M}/staff`]: [
    { id: 'st2', data: { staffCode: 'SE-001', fullName: 'Grace Group', positions: ['Cook'], employmentStatus: 'regular', dateHired: '2025-01-05', isActive: true, payType: 'daily', dailyRate: 611, dailyRateEffectiveFrom: '2025-03-03', hourlyRateEffectiveFrom: '2025-01-01' } },
  ],
  staffIdentities: [{ id: 'grpkeyG', data: { staffRefs: [{ storeId: L, staffId: 'st1' }, { storeId: M, staffId: 'st2' }] } }],
};

const fake = (): Any => ({
  collection: (path: string) => ({ get: async () => ({ docs: (DATA[path] ?? []).map((d) => ({ id: d.id, data: () => d.data })) }) }),
});

const MAP = parseStoreMap(
  ['v1_store_id,name,role,org_code,store_code', `${L},Lipa,own,SE,LIPA`, `${M},Malvar,own,SE,MLVR`].join('\r\n'),
);
const CANON = ['Cashier', 'Cook', 'Server', 'Dishwasher', 'Slicer', 'Inventory Staff'].map((name, i) => ({ id: `p${i}`, name, storeCode: null }));

async function extracted(): Promise<{ rates: Any[]; roster: Any[] }> {
  const dir = mkdtempSync(join(tmpdir(), 't391-s5-rates-'));
  const ratesDir = `${dir}-rates`;
  await runExtract(makeReadOnlyV1Client(fake()), { outDir: dir, ratesDir, env: { NODE_ENV: 'development' } });
  const rates = parseCsv(readFileSync(join(ratesDir, 'v1-staff-rates.local.csv'), 'utf8'));
  const snapshot = JSON.parse(readFileSync(join(dir, 'v1-snapshot.json'), 'utf8'));
  const mod: Any = await import('../src/master-data/staff-plan');
  const plan = mod.planStaff({ snapshot, map: MAP, orgCode: 'SE', existingPositions: CANON, existingPersons: [], links: [], answers: {} });
  return { rates, roster: plan.sheets['staff-roster'] };
}

describe('extract writes the rates file validate-hr reads', () => {
  it('has person_ref (group key for a grouped person, else the v1 staff id) and the three effective-from columns', async () => {
    const { rates } = await extracted();
    const cols = Object.keys(rates[0]);
    for (const c of ['person_ref', 'daily_rate_effective_from', 'hourly_rate_effective_from', 'monthly_rate_effective_from']) expect(cols).toContain(c);
    const ref = (name: string): string[] => rates.filter((r) => r.full_name === name).map((r) => r.person_ref);
    expect(ref('Grace Group')).toEqual(['grpkeyG', 'grpkeyG']);
    expect(ref('Sol Solo')).toEqual(['st3']);
    expect(ref('Hal Hourly')).toEqual(['st4']);
  });

  it('fed straight into validateHr with the matching roster, every person merges their rate and their own basis date. Mutant: keyed by v1_staff_id / only the hourly date', async () => {
    const { rates, roster } = await extracted();
    expect(roster).toHaveLength(3);
    const mod: Any = await import('../src/master-data/hr-sheet');
    const r = mod.validateHr({ roster, rates });
    const by = (n: string): Any => r.rows.find((x: Any) => x.full_name === n);
    expect(by('Grace Group')).toMatchObject({ pay_basis: 'daily', rate: '611', rate_effective_from: '2025-03-03' });
    expect(by('Sol Solo')).toMatchObject({ pay_basis: 'monthly', rate: '18123', rate_effective_from: '2025-02-02' });
    expect(by('Hal Hourly')).toMatchObject({ pay_basis: 'hourly', rate: '77.77', rate_effective_from: '2025-04-04' });
  });
});
