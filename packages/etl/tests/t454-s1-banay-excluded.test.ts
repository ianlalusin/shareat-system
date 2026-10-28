/**
 * T-454 S1 - Banay-Banay leaves the dual-run comparator (bible rows 377, 384).
 * Spec: docs/tasks/454-drop-banay-banay.md S1, tests T1-T4 (+ data-not-code leg).
 *
 * Contract the builder must meet (all in packages/etl/src/dual-run/snapshot.ts):
 *   - v1 id iGOW7q2pZbeHWV832UNh moves from OPERATING to EXCLUDED with a reason that cites bible row 377.
 *   - No other source file under packages/etl/src/dual-run or packages/domain/src/dual-run names that id (no special case).
 * Everything else (assertStoresTicked, computeV1Figures keys path, runDualRun) already consumes snapshot.stores /
 * snapshot.excludedStores, so it must start behaving correctly with no code change. The unknown-store refusal and the
 * "operating store must be ticked" refusal must stay.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../src/dual-run/snapshot';
import { computeV1Figures } from '../src/dual-run/v1-figures';
import { assertStoresTicked } from '../src/dual-run/keys';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const D = 'eVYKj6wABdakk8RgEotW';
const WEEK = '2026-10-19';

const raw = (): Any => ({
  stores: [
    { id: L, name: 'SharEat Lipa' },
    { id: M, name: 'SharEat Malvar' },
    { id: B, name: 'SharEat Banay-Banay' },
    { id: D, name: 'SharEat Davao' },
  ],
  journal: [L, M, B, D].map((s, i) => ({
    id: `j${i}`, storeId: s, businessDate: '2026-10-20', sourceType: 'sale', sourceId: `s${i}`, legKey: 'cash:cashier',
    accountId: 'cash__cashier', direction: 'in', amount: 100 + i, status: 'posted',
  })),
  expenses: [
    { id: 'exB', storeId: B, dayKey: '2026-10-20', totalAmount: 50, status: 'posted', supplierId: 'S1', expenseEntryId: 'e', expenseEntryGroup: 'OPEX', category: 'x', payments: [{ method: 'cash', amount: 50, accountId: 'cashier' }] },
  ],
  salesDays: [
    { id: '2026-10-20', storeId: B, status: 'verified', dineInSales: 100, onlineBreakdown: {}, creditSales: 0 },
    { id: '2026-10-20', storeId: L, status: 'verified', dineInSales: 100, onlineBreakdown: {}, creditSales: 0 },
  ],
  suppliers: [],
  paymentAccounts: [],
});
const build = (r: Any = raw()): Any => buildSnapshot(r, { from: '2026-10-19', through: '2026-10-25', extractedAt: '2026-10-26T00:00:00Z' });

const tick = (id: string, name: string): Any => ({ section: 'store', v1Store: '', v1Key: id, v1Label: name, v2Key: id.slice(0, 4), ticked: true });
const sheet3 = (): Any[] => [tick(L, 'SharEat Lipa'), tick(M, 'SharEat Malvar'), tick(D, 'SharEat Davao')];

describe('T-454 S1: Banay-Banay excluded by ruling', () => {
  // T1. Mutant M1: Banay-Banay left in OPERATING (stores would hold it; excludedStores would not).
  it('T1 [M1] Banay-Banay is in excludedStores with a reason citing row 377, out of stores, and its documents are dropped', () => {
    const s = build();
    expect(s.stores.map((x: Any) => x.id).sort()).toEqual([L, M, D].sort());
    const ex = s.excludedStores.find((e: Any) => e.id === B);
    expect(ex).toBeTruthy();
    expect(ex.reason).toMatch(/377/);
    expect(s.journal.some((j: Any) => j.storeId === B)).toBe(false);
    expect(s.expenses.some((e: Any) => e.storeId === B)).toBe(false);
    expect(s.salesDays.some((d: Any) => d.storeId === B)).toBe(false);
    expect(s.journal.filter((j: Any) => j.storeId === L)).toHaveLength(1); // the other stores keep their documents
  });

  // T2. Mutant M2: assertStoresTicked fed the raw roster (would demand a Banay-Banay row). Also M1.
  it('T2 [M2] a keys sheet with no Banay-Banay row passes assertStoresTicked and computeV1Figures (no "not mapped" refusal)', () => {
    const s = build();
    expect(() => assertStoresTicked(sheet3(), s.stores.map((x: Any) => x.id))).not.toThrow();
    const f = computeV1Figures(s, { weekStart: WEEK, keys: sheet3() } as Any);
    expect(Object.keys(f.stores).sort()).toEqual([L, M, D].sort());
  });

  // T3. Mutant M3: exclusion silent (reason dropped / not carried to the report).
  it('T3 [M3] the figures/report carry Banay-Banay as excluded with its reason, not as a silently missing store', () => {
    const f = computeV1Figures(build(), { weekStart: WEEK, keys: sheet3() } as Any);
    const e = f.excluded.find((x: Any) => x.id === B);
    expect(e).toMatchObject({ id: B, name: 'SharEat Banay-Banay' });
    expect(e?.reason).toMatch(/377/);
    expect(f.excluded.every((x: Any) => x.reason.length > 0)).toBe(true);
  });

  // M4: a leftover ticked Banay-Banay row must not re-enter the run (guard in v1-figures).
  it('T3b [M4] a ticked Banay-Banay row left in the sheet is refused as an excluded store, never compared', () => {
    const rows = [...sheet3(), tick(B, 'SharEat Banay-Banay')];
    expect(() => computeV1Figures(build(), { weekStart: WEEK, keys: rows } as Any)).toThrow(/excluded/i);
  });

  // T4. Mutant M5: classify defaulting unknown ids to drop.
  it('T4 [M5] an unknown store id (roster or document) is still refused', () => {
    const r = raw();
    r.stores.push({ id: 'MYSTERY', name: 'Somewhere New' });
    expect(() => build(r)).toThrow(/unknown store/i);
    const r2 = raw();
    r2.journal.push({ ...r2.journal[0], id: 'ghost', storeId: 'GHOST' });
    expect(() => build(r2)).toThrow(/unknown store/i);
  });

  // Mutant M6: guard loosened so a missing operating store is skipped.
  it('T4b [M6] a NOT-excluded store missing from the sheet still refuses by name (Malvar), and unticked/no-key too', () => {
    const s = build();
    const ids = s.stores.map((x: Any) => x.id);
    const noMalvar = sheet3().filter((r) => r.v1Key !== M);
    expect(() => assertStoresTicked(noMalvar, ids)).toThrow(new RegExp(`${M}|Malvar`));
    expect(() => computeV1Figures(s, { weekStart: WEEK, keys: noMalvar } as Any)).toThrow(new RegExp(`${M}|Malvar`));
    const unticked = sheet3().map((r) => (r.v1Key === M ? { ...r, ticked: false } : r));
    expect(() => assertStoresTicked(unticked, ids)).toThrow(new RegExp(`${M}|Malvar`));
    const noKey = sheet3().map((r) => (r.v1Key === D ? { ...r, v2Key: '' } : r));
    expect(() => assertStoresTicked(noKey, ids)).toThrow(new RegExp(`${D}|Davao`));
  });

  // Data not code. Mutant M7: a special-case branch (if id === Banay...) added elsewhere instead of the list.
  it('T5 [M7] the exclusion is one entry in the named list in snapshot.ts; no other dual-run source names the store', () => {
    const root = join(__dirname, '..', '..', '..');
    const dirs = [join(root, 'packages', 'etl', 'src', 'dual-run'), join(root, 'packages', 'domain', 'src', 'dual-run')];
    const hits: string[] = [];
    for (const d of dirs) {
      for (const f of readdirSync(d).filter((n) => n.endsWith('.ts'))) {
        const t = readFileSync(join(d, f), 'utf8');
        const n = t.split(B).length - 1;
        if (n > 0) hits.push(`${f}:${n}`);
        if (/banay/i.test(t) && f !== 'snapshot.ts') hits.push(`${f}:name`);
      }
    }
    expect(hits).toEqual(['snapshot.ts:1']);
    const snap = readFileSync(join(dirs[0]!, 'snapshot.ts'), 'utf8');
    const excl = snap.slice(snap.indexOf('const EXCLUDED'));
    expect(excl.slice(0, excl.indexOf('};'))).toContain(B);
    const oper = snap.slice(snap.indexOf('const OPERATING'), snap.indexOf('const EXCLUDED'));
    expect(oper).not.toContain(B);
  });
});
