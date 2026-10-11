import { describe, expect, it } from 'vitest';

/**
 * T-390 S2 - `planOpeningStock`, the ONE implementation of R5's arithmetic (R17). `docs/tasks/390-opening-stock-and-subledger-tieout.md`
 * s4 R5, R17, s5.2, s8 tests 6 and 7. TESTER-first: red until `packages/domain/src/cutover/opening-stock.ts` exists and exports it.
 *
 * ⛔ SPEC DEFECT (reported): s5.2 gives `planOpeningStock(counts, itemKinds)` no argument or return SHAPES. This file fixes them as
 * the smallest natural reading and keeps them in ONE place (`plan()` and `amounts()` below) so the orchestrator can correct them in
 * one edit if the builder's shapes differ:
 *   counts    = rows { storeId, locationId, itemId, itemName, quantity: string, unitCost: string | null } (also carried as name/kind)
 *   itemKinds = Map<itemId, kind>   (a value that is ALSO an object with .kind/.name is passed, so Map<itemId, {kind,name}> works)
 *   result    = per store, per account (1310/1320/1330), the opening figure in pesos; `amounts()` finds them in any reasonable shape
 *               (Map, array, or object; keyed by store and account code, or objects carrying storeId/code/amount).
 * What the tests pin is the ARITHMETIC and the ACCOUNT MAPPING, not the container.
 */

const STORE_A = 'store-A';
const STORE_B = 'store-B';

interface CountRow {
  storeId: string;
  locationId: string;
  itemId: string;
  itemName: string;
  name: string;
  kind: string;
  quantity: string;
  unitCost: string | null;
}
const row = (storeId: string, locationId: string, itemId: string, itemName: string, kind: string, quantity: string, unitCost: string | null): CountRow => ({
  storeId, locationId, itemId, itemName, name: itemName, kind, quantity, unitCost,
});

/** A Map<itemId, kind> whose values also answer `.kind` and `.name` (see the header). */
function kindsOf(rows: CountRow[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const r of rows) m.set(r.itemId, Object.assign(new String(r.kind), { kind: r.kind, name: r.itemName }));
  return m;
}

async function planFn(): Promise<(counts: unknown, kinds: unknown) => unknown> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('../../packages/domain/src/cutover/opening-stock')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`MISSING MODULE: packages/domain/src/cutover/opening-stock.ts does not load (T-390 S2 has not been built): ${(e as Error).message}`);
  }
  const fn = mod.planOpeningStock;
  if (typeof fn !== 'function') throw new Error('MISSING EXPORT: opening-stock.ts does not export planOpeningStock (T-390 S2 has not been built).');
  return fn as (counts: unknown, kinds: unknown) => unknown;
}

/** Run the plan; a thrown or rejected refusal comes back as the error. */
async function plan(rows: CountRow[]): Promise<{ result: unknown; error: unknown }> {
  const fn = await planFn();
  try {
    return { result: await fn(rows, kindsOf(rows)), error: null };
  } catch (error) {
    return { result: null, error };
  }
}

interface Figure {
  storeId: string | null;
  code: string;
  amount: string;
}
const ACCOUNT = /^13[123]0$/;
const asPesos = (v: unknown): string | null =>
  typeof v === 'number' ? v.toFixed(2) : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v).toFixed(2) : null;

/** Every (store, account, amount) the plan holds, whatever the container. */
function amounts(result: unknown): Figure[] {
  const out: Figure[] = [];
  const walk = (node: unknown, store: string | null): void => {
    if (node === null || node === undefined) return;
    if (node instanceof Map) {
      for (const [k, v] of node) visit(String(k), v, store);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, store);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const here = typeof o.storeId === 'string' ? o.storeId : store;
    const code = [o.code, o.accountCode, o.account].find((c) => typeof c === 'string' && ACCOUNT.test(c as string)) as string | undefined;
    const amount = [o.amount, o.total, o.value, o.debit].map(asPesos).find((a) => a !== null);
    if (code && amount) {
      out.push({ storeId: here, code, amount });
      return;
    }
    for (const [k, v] of Object.entries(o)) visit(k, v, here);
  };
  const visit = (key: string, v: unknown, store: string | null): void => {
    if (ACCOUNT.test(key)) {
      const o = (v ?? {}) as Record<string, unknown>;
      const direct = asPesos(v) ?? [o.amount, o.total, o.value, o.debit].map(asPesos).find((a) => a !== null) ?? null;
      if (direct !== null) out.push({ storeId: store, code: key, amount: direct });
      else walk(v, store);
      return;
    }
    walk(v, key === STORE_A || key === STORE_B ? key : store);
  };
  walk(result, null);
  return out;
}
const amountOf = (figs: Figure[], storeId: string, code: string): string | undefined =>
  figs.find((f) => (f.storeId === storeId || f.storeId === null) && f.code === code)?.amount;

describe('test 6 - one rounding per item per store (kills M6: rounding per room)', { timeout: 30_000 }, () => {
  it('three rooms of one store, 1 unit each at 0.0050, value at 0.02 (round2 of 0.015), NOT 0.03', async () => {
    const rows = [
      row(STORE_A, 'room-1', 'i1', 'Salt', 'raw_material', '1', '0.0050'),
      row(STORE_A, 'room-2', 'i1', 'Salt', 'raw_material', '1', '0.0050'),
      row(STORE_A, 'room-3', 'i1', 'Salt', 'raw_material', '1', '0.0050'),
    ];
    const { result, error } = await plan(rows);
    expect(error, 'planOpeningStock refused a plain count').toBeNull();
    const figs = amounts(result);
    expect(figs.length, `no 13x0 figure found in the plan: ${JSON.stringify(result)}`).toBeGreaterThan(0);
    // Per-room rounding gives round2(0.005) x 3 = 0.01 x 3 = 0.03. The single store layer of s16.11 gives 0.02.
    expect(amountOf(figs, STORE_A, '1310')).toBe('0.02');
  });

  it('the rounding is per ITEM: two items worth 0.004 each are 0.00 + 0.00, not round2(0.008) = 0.01 (kills rounding the account sum)', async () => {
    const rows = [
      row(STORE_A, 'room-1', 'i1', 'Salt', 'raw_material', '1', '0.0040'),
      row(STORE_A, 'room-1', 'i2', 'Pepper', 'raw_material', '1', '0.0040'),
      row(STORE_A, 'room-1', 'i3', 'Rice', 'raw_material', '10', '2.5000'),
    ];
    const { result, error } = await plan(rows);
    expect(error).toBeNull();
    // 0.00 + 0.00 + 25.00. Summing first and rounding once would give 25.01.
    expect(amountOf(amounts(result), STORE_A, '1310')).toBe('25.00');
  });

  it('exact in centavos, never in floats: 0.10 + 0.20 is 0.30', async () => {
    const rows = [
      row(STORE_A, 'room-1', 'i1', 'Salt', 'raw_material', '1', '0.1000'),
      row(STORE_A, 'room-1', 'i2', 'Pepper', 'raw_material', '1', '0.2000'),
    ];
    const { result } = await plan(rows);
    expect(amountOf(amounts(result), STORE_A, '1310')).toBe('0.30');
  });

  it('a quantity with three decimals times a cost with four: 333.333 x 12.3456 = 4115.1958848 -> 4115.20', async () => {
    const rows = [row(STORE_A, 'room-1', 'i1', 'Beef', 'raw_material', '333.333', '12.3456')];
    const { result } = await plan(rows);
    expect(amountOf(amounts(result), STORE_A, '1310')).toBe('4115.20');
  });

  it('stores are planned separately; zero-quantity rows add nothing', async () => {
    const rows = [
      row(STORE_A, 'a-1', 'i1', 'Salt', 'raw_material', '4', '10.0000'),
      row(STORE_A, 'a-2', 'i1', 'Salt', 'raw_material', '0', '10.0000'),
      row(STORE_B, 'b-1', 'i1', 'Salt', 'raw_material', '1', '10.0000'),
    ];
    const figs = amounts((await plan(rows)).result);
    expect(amountOf(figs, STORE_A, '1310')).toBe('40.00');
    expect(amountOf(figs, STORE_B, '1310')).toBe('10.00');
  });
});

describe('test 7 - the inventory account follows the item kind (kills M7: hard-coded 1310)', { timeout: 30_000 }, () => {
  it('raw_material, meat_slab, meat_sliced and retail land on 1310; supply on 1320; prepped on 1330', async () => {
    const rows = [
      row(STORE_A, 'r', 'i1', 'Pork belly', 'raw_material', '1', '100.0000'),
      row(STORE_A, 'r', 'i2', 'Slab', 'meat_slab', '1', '200.0000'),
      row(STORE_A, 'r', 'i3', 'Sliced', 'meat_sliced', '1', '300.0000'),
      row(STORE_A, 'r', 'i4', 'Soda', 'retail', '1', '400.0000'),
      row(STORE_A, 'r', 'i5', 'Gloves', 'supply', '1', '5.0000'),
      row(STORE_A, 'r', 'i6', 'Sauce base', 'prepped', '1', '7.0000'),
    ];
    const { result, error } = await plan(rows);
    expect(error, 'a prepped item is a legal commissary product and must map to 1330').toBeNull();
    const figs = amounts(result);
    expect(amountOf(figs, STORE_A, '1310')).toBe('1000.00');
    expect(amountOf(figs, STORE_A, '1320')).toBe('5.00');
    expect(amountOf(figs, STORE_A, '1330')).toBe('7.00');
  });

  it('only non-zero accounts appear: a store with only supplies has no 1310 or 1330 figure', async () => {
    const rows = [row(STORE_A, 'r', 'i5', 'Gloves', 'supply', '3', '5.0000')];
    const figs = amounts((await plan(rows)).result).filter((f) => f.storeId === STORE_A || f.storeId === null);
    expect(figs.map((f) => f.code).sort()).toEqual(['1320']);
  });

  it('a kind with no inventory account is refused BY ITEM NAME', async () => {
    const rows = [
      row(STORE_A, 'r', 'i1', 'Pork belly', 'raw_material', '1', '100.0000'),
      row(STORE_A, 'r', 'i9', 'Mystery Crate', 'unmapped_kind', '1', '9.0000'),
    ];
    const { error } = await plan(rows);
    expect(error, 'an unmapped kind was silently planned (or defaulted to 1310)').not.toBeNull();
    const text = `${(error as { userMessage?: string }).userMessage ?? ''} ${(error as Error).message}`;
    expect(text).toContain('Mystery Crate');
  });
});
