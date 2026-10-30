/**
 * T-502 step 1 - the read-only v1 expense export. Unit: a Firestore fake, no database, no network.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReadOnlyV1Client } from '../src/master-data/snapshot';
import { normaliseParticulars, runV1ExpenseExport } from '../../../scripts/lib/v1-expense-export';

type Doc = { id: string; data: Record<string, unknown> };
function fakeFirestore(docs: Record<string, Doc[]>, reads: string[] = []) {
  return {
    collection(path: string) {
      return {
        async get() {
          reads.push(path);
          return { docs: (docs[path] ?? []).map((d) => ({ id: d.id, data: () => d.data })) };
        },
      };
    },
  };
}
const exp = (id: string, dayKey: string, extra: Record<string, unknown> = {}): Doc => ({
  id,
  data: { dayKey, totalAmount: 100, status: 'posted', expenseEntryId: 'EE1', expenseEntryGroup: 'OPEX', category: 'Supplies', subCategory: 'Cleaning', particulars: 'Dish soap', ...extra },
});
const base = (): Record<string, Doc[]> => ({
  stores: [{ id: 'S1', data: { name: 'Lipa' } }, { id: 'S2', data: { name: 'Malvar' } }],
  expenseEntries: [{ id: 'EE1', data: { group: 'OPEX', category: 'Supplies', subCategory: 'Cleaning', isActive: true, needReceipts: false, needParticulars: true } }],
  'stores/S1/expenses': [
    exp('a', '2026-10-01', { totalAmount: '1234.50', storeId: 'WRONG', supplierName: 'ACME', payments: [{ method: 'cash', amount: 1 }, { method: 'online', amount: 2 }] }),
    exp('b', '2026-10-31', { particulars: '  DISH   Soap ', totalAmount: 50 }),
    exp('c', '2026-11-01'),
    exp('d', '2026-09-30'),
    exp('e', '20261015', { status: 'voided', particulars: '=HYPERLINK("x")' }),
  ],
  'stores/S2/expenses': [exp('f', '2026-10-10', { particulars: 'Tape, "wide"' })],
});
const run = async (docs = base(), over: Record<string, unknown> = {}, reads: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 't502-'));
  const result = await runV1ExpenseExport(makeReadOnlyV1Client(fakeFirestore(docs, reads)), {
    from: '2026-10-01', through: '2026-10-31', outDir: dir, env: {}, now: new Date('2026-11-02T00:00:00Z'), ...over,
  });
  return { dir, result, read: (f: string) => readFileSync(join(dir, f), 'utf8') };
};

describe('v1 expense export', () => {
  it('refuses under production before reading anything', async () => {
    const reads: string[] = [];
    await expect(run(base(), { env: { NODE_ENV: 'production' } }, reads)).rejects.toThrow(/production/);
    expect(reads).toEqual([]);
  });

  it('is read-only: the client only has collection().get()', () => {
    const c = makeReadOnlyV1Client(fakeFirestore({}));
    expect(Object.keys(c)).toEqual(['collection']);
    expect(Object.keys(c.collection('x'))).toEqual(['get']);
  });

  it('takes the store from the path, keeps amounts as strings, filters dates inclusively', async () => {
    const { dir, read } = await run();
    const rows = read('expenses.csv').trim().split('\n');
    expect(rows[0]).toContain('v1_id,store_id,store_name,business_date');
    expect(rows.length).toBe(1 + 4); // a, b, e (Oct 1, Oct 31, Oct 15) + f
    const a = rows.find((r) => r.startsWith('a,'))!;
    expect(a).toContain('S1,Lipa,2026-10-01');
    expect(a).not.toContain('WRONG');
    expect(a).toContain(',1234.50,'); // string kept verbatim, not 1234.5
    expect(a).toContain('ACME');
    expect(a).toContain('cash|online');
    expect(rows.some((r) => r.startsWith('b,') && r.includes(',50,'))).toBe(true);
    expect(rows.some((r) => r.startsWith('c,') || r.startsWith('d,'))).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('escapes formulas and quotes (RFC 4180), flags voided', async () => {
    const { read } = await run();
    const csv = read('expenses.csv');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"Tape, ""wide"""');
    const e = csv.split('\n').find((r) => r.startsWith('e,'))!;
    expect(e.trim().endsWith(',true')).toBe(true);
  });

  it('normalises particulars and summarises with counts, sorted by count desc, voided excluded', async () => {
    expect(normaliseParticulars('  DISH   Soap ')).toBe('dish soap');
    const { read } = await run();
    const lines = read('particulars-summary.csv').trim().split('\n');
    expect(lines[0]).toBe('particulars,count,total_amount,first_date,last_date,categories');
    expect(lines[1]).toBe('dish soap,2,1284.50,2026-10-01,2026-10-31,OPEX / Supplies / Cleaning');
    expect(lines[2]!.startsWith('"tape')).toBe(true);
    expect(lines.length).toBe(3);
  });

  it('writes the catalogue and a README with range and counts; --stores narrows', async () => {
    const reads: string[] = [];
    const { read, result } = await run(base(), { stores: ['S2'] }, reads);
    expect(read('expense-entries.csv')).toContain('EE1,OPEX,Supplies,Cleaning');
    expect(read('README.txt')).toMatch(/2026-10-01 to 2026-10-31.*expenses 1.*expense entries 1/s);
    expect(reads).not.toContain('stores/S1/expenses');
    expect(result.counts.expenses).toBe(1);
    expect(existsSync(result.expensesPath)).toBe(true);
  });

  it('rejects bad dates and unknown stores', async () => {
    await expect(run(base(), { from: '2026-13-01' })).rejects.toThrow(/date/i);
    await expect(run(base(), { through: '2026-09-01' })).rejects.toThrow(/before/);
    await expect(run(base(), { stores: ['NOPE'] })).rejects.toThrow(/NOPE/);
  });
});
