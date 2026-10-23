/**
 * T-426 slice T - what each senior/PWD diner alone consumed. Ruling 2, Acceptance 1 (share = one head), 5 (zero share), the voided-dish rule.
 *
 * CONTRACT for the builder (S1) - NEW module `apps/pos/src/lib/statutory/shares.ts`:
 *   statutoryShares(input: { lines: SessionBillLine[]; diners: StatutoryDiner[]; heads: number | null;
 *                            package?: { isBundle?: boolean; bundleMaxCap?: number } | null }): StatutoryShares
 *     StatutoryShares = { shares: DinerShare[]; totalCentavos: number; zeroShareDinerIds: string[] }
 *     DinerShare      = { dinerId: string; centavos: number; packageCentavos: number; dishCentavos: number; dishLineIds: string[] }
 *     - `shares` has one entry per diner, SAME ORDER as `diners`; every number is an integer count of centavos; `centavos = packageCentavos + dishCentavos`.
 *     - a diner is a record { id, kind: 'senior'|'pwd', name, idNo, idNoNormalized, addedByUid, addedAtClientMs, dishLineIds: string[] }.
 *     - per-head package (a line of type 'package', qtyOrdered = heads): the diner's k-th position takes head k of
 *       `allocate(line net after that line's OWN adjustments, one weight per billable head)` (ties to the earlier index, so the diners together
 *       never exceed the line).
 *     - bundle (`package.isBundle`, the 'package' line is qty 1 at bundlePrice): covered heads = min(heads, bundleMaxCap); a diner in position
 *       k < covered takes `allocate(bundle line net, covered ones)[k]`; a diner beyond the covered heads takes ONE unit of the extra-head line
 *       (the line whose id starts with `bundleextra_`).
 *     - dishes: an 'addon' line whose id is in the diner's `dishLineIds` counts in full (billable units x (unitPrice + modifiersTotal), minus
 *       that line's own adjustments); billable units = qtyOrdered - voidedQty - freeQty. A line whose billable units are 0 contributes 0 and is NOT
 *       listed in the share's `dishLineIds` (the voided dish leaves the diner automatically). A line in two diners' lists counts once (first diner).
 *     - `zeroShareDinerIds`: diners whose `centavos` is 0 (these block payment: see capture.test.ts).
 *   pruneDishAssignments(diners, lines): StatutoryDiner[]   - a NEW array; each diner's `dishLineIds` keeps only ids of lines that still exist
 *       with billable units > 0; other fields unchanged; the input is not mutated.
 */
import { describe, expect, it } from 'vitest';
import { loadMod, mkDiner, mkLine, need, type Diner } from '@/test-helpers/statutoryOracle';

const W = '@/lib/statutory/shares';
type Share = { dinerId: string; centavos: number; packageCentavos: number; dishCentavos: number; dishLineIds: string[] };
type Out = { shares: Share[]; totalCentavos: number; zeroShareDinerIds: string[] };
async function shares(input: Record<string, unknown>): Promise<Out> {
  const fn = need<(i: any) => Out>(await loadMod(W), 'statutoryShares', 'apps/pos/src/lib/statutory/shares.ts');
  return fn(input);
}
const prune = async (diners: Diner[], lines: any[]): Promise<Diner[]> =>
  need<(d: any, l: any) => Diner[]>(await loadMod(W), 'pruneDishAssignments', 'apps/pos/src/lib/statutory/shares.ts')(diners, lines);

const pkg4 = () => mkLine({ id: 'pkg', type: 'package', name: 'Unli Pack', priceC: 44900, qty: 4 });
const platter = () => mkLine({ id: 'a1', type: 'addon', name: 'Shared platter', priceC: 31800, qty: 1 });

describe('per-head package: one head of the package line', () => {
  it('one senior at a table of four takes exactly one head, P449.00, and nothing from the shared dish', async () => {
    const r = await shares({ lines: [pkg4(), platter()], diners: [mkDiner(1)], heads: 4, package: null });
    expect(r.shares).toHaveLength(1);
    expect(r.shares[0]).toMatchObject({ dinerId: 'd1', centavos: 44900, packageCentavos: 44900, dishCentavos: 0, dishLineIds: [] });
    expect(r.totalCentavos).toBe(44900);
    expect(r.zeroShareDinerIds).toEqual([]);
  });

  it('two of four: each takes one head; the result keeps the diners order', async () => {
    const r = await shares({ lines: [pkg4(), platter()], diners: [mkDiner(2), mkDiner(1)], heads: 4, package: null });
    expect(r.shares.map((s) => s.dinerId)).toEqual(['d2', 'd1']);
    expect(r.shares.map((s) => s.centavos)).toEqual([44900, 44900]);
    expect(r.totalCentavos).toBe(89800);
  });

  it("all four diners together take the whole package line and not a centavo more", async () => {
    const r = await shares({ lines: [pkg4()], diners: [1, 2, 3, 4].map((n) => mkDiner(n)), heads: 4, package: null });
    expect(r.totalCentavos).toBe(4 * 44900);
  });

  it("the package line's OWN adjustment is allocated per head: 10% off 2 of 4 heads leaves 42,655 per head", async () => {
    const adjs = { x: { id: 'x', kind: 'discount', note: 'n', type: 'percent', value: 10, qty: 2, createdAtClientMs: 1000, createdByUid: 'u' } };
    const line = mkLine({ id: 'pkg', type: 'package', priceC: 44900, qty: 4, adjs });
    const r = await shares({ lines: [line], diners: [1, 2, 3, 4].map((n) => mkDiner(n)), heads: 4, package: null });
    // 4 x 449.00 = 1,796.00; 10% off two heads = 89.80; net 1,706.20 over 4 heads = 426.55 each
    expect(r.shares.map((s) => s.centavos)).toEqual([42655, 42655, 42655, 42655]);
    expect(r.totalCentavos).toBe(170620);
  });

  it('a line net that does not divide evenly is allocated exactly: three diners together take 29,999 centavos, no more, no less', async () => {
    const adjs = { x: { id: 'x', kind: 'discount', note: 'n', type: 'fixed', value: 0.01, qty: 1, createdAtClientMs: 1000, createdByUid: 'u' } };
    const line = mkLine({ id: 'pkg', type: 'package', priceC: 10000, qty: 3, adjs });
    const r = await shares({ lines: [line], diners: [1, 2, 3].map((n) => mkDiner(n)), heads: 3, package: null });
    expect(r.totalCentavos).toBe(29999);
    for (const s of r.shares) expect([9999, 10000]).toContain(s.centavos);
    for (const s of r.shares) expect(Number.isInteger(s.centavos)).toBe(true);
  });
});

describe('bundle: bundlePrice divided over the covered heads; a diner beyond them takes one extra head', () => {
  const bundle = { isBundle: true, bundleMaxCap: 3 };
  const bundleLine = () => mkLine({ id: 'package_pk', type: 'package', name: 'Bundle', priceC: 100000, qty: 1 });

  it('three diners on a 3-head bundle of P1,000.00 take exactly 100,000 together (33,334 / 33,333 / 33,333 in some order)', async () => {
    const r = await shares({ lines: [bundleLine()], diners: [1, 2, 3].map((n) => mkDiner(n)), heads: 3, package: bundle });
    expect(r.totalCentavos).toBe(100000);
    expect(r.shares.map((s) => s.centavos).sort()).toEqual([33333, 33333, 33334]);
    expect(r.shares.every((s) => s.packageCentavos === s.centavos && s.dishCentavos === 0)).toBe(true);
  });

  it('one diner of a 5-head party on a 3-cap bundle takes bundlePrice / 3 (33,334 or 33,333)', async () => {
    const r = await shares({ lines: [bundleLine()], diners: [mkDiner(1)], heads: 3, package: bundle });
    expect([33333, 33334]).toContain(r.shares[0]!.centavos);
  });

  it('the fourth diner, beyond the covered heads, takes one unit of the extra-head line (P200.00)', async () => {
    const extra = mkLine({ id: 'bundleextra_pk', type: 'addon', name: 'Extra Pax - Bundle', priceC: 20000, qty: 2, category: 'Extra Pax' });
    const r = await shares({ lines: [bundleLine(), extra], diners: [1, 2, 3, 4].map((n) => mkDiner(n)), heads: 5, package: bundle });
    expect(r.shares[3]!.centavos).toBe(20000);
    expect(r.shares.slice(0, 3).reduce((s, x) => s + x.centavos, 0)).toBe(100000);
    expect(r.totalCentavos).toBe(120000);
  });
});

describe('assigned dishes: only what the cashier marked as the diner\'s own', () => {
  it('a la carte: each diner takes the dishes assigned to them; the unassigned dish is nobody\'s', async () => {
    const a1 = mkLine({ id: 'a1', type: 'addon', priceC: 30000, qty: 1 });
    const a2 = mkLine({ id: 'a2', type: 'addon', priceC: 15000, qty: 2 });
    const a3 = mkLine({ id: 'a3', type: 'addon', priceC: 50000, qty: 1 });
    const r = await shares({ lines: [a1, a2, a3], diners: [mkDiner(1, { dishLineIds: ['a1'] }), mkDiner(2, { dishLineIds: ['a2'] })], heads: 3, package: null });
    expect(r.shares.map((s) => s.centavos)).toEqual([30000, 30000]);
    expect(r.shares[0]).toMatchObject({ packageCentavos: 0, dishCentavos: 30000, dishLineIds: ['a1'] });
    expect(r.totalCentavos).toBe(60000);
    expect(r.zeroShareDinerIds).toEqual([]);
  });

  it('package diner = one head + the dishes assigned to them (modifier price included)', async () => {
    const dish = mkLine({ id: 'a1', type: 'addon', priceC: 31800, qty: 1 });
    (dish as any).modifiersTotal = 10;
    const r = await shares({ lines: [pkg4(), dish], diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: 4, package: null });
    expect(r.shares[0]).toMatchObject({ packageCentavos: 44900, dishCentavos: 31800 + 1000, centavos: 44900 + 31800 + 1000 });
  });

  it('free and voided units of an assigned dish are not billed to the diner: qty 3, 1 voided, 1 free leaves one unit', async () => {
    const dish = mkLine({ id: 'a1', type: 'addon', priceC: 12000, qty: 3, voided: 1, free: 1 });
    const r = await shares({ lines: [dish], diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: 1, package: null });
    expect(r.shares[0]!.dishCentavos).toBe(12000);
  });

  it('a dish listed under two diners counts once, never twice (first diner keeps it)', async () => {
    const dish = mkLine({ id: 'a1', type: 'addon', priceC: 20000, qty: 1 });
    const r = await shares({ lines: [dish], diners: [mkDiner(1, { dishLineIds: ['a1'] }), mkDiner(2, { dishLineIds: ['a1'] })], heads: 2, package: null });
    expect(r.totalCentavos).toBe(20000);
    expect(r.shares[0]!.centavos).toBe(20000);
    expect(r.shares[1]!.centavos).toBe(0);
  });
});

describe('zero share and voided dishes (Acceptance 5)', () => {
  it('a la carte with no dish assigned: the share is 0 and the diner is listed as blocking', async () => {
    const dish = mkLine({ id: 'a1', type: 'addon', priceC: 20000, qty: 1 });
    const r = await shares({ lines: [dish], diners: [mkDiner(1), mkDiner(2, { dishLineIds: ['a1'] })], heads: 2, package: null });
    expect(r.shares[0]!.centavos).toBe(0);
    expect(r.zeroShareDinerIds).toEqual(['d1']);
  });

  it('voiding the only assigned dish brings the zero-share block back and drops the line from the share', async () => {
    const live = mkLine({ id: 'a1', type: 'addon', priceC: 20000, qty: 1 });
    const diners = [mkDiner(1, { dishLineIds: ['a1'] })];
    expect((await shares({ lines: [live], diners, heads: 1, package: null })).zeroShareDinerIds).toEqual([]);
    const voided = mkLine({ id: 'a1', type: 'addon', priceC: 20000, qty: 1, voided: 1 });
    const r = await shares({ lines: [voided], diners, heads: 1, package: null });
    expect(r.shares[0]).toMatchObject({ centavos: 0, dishLineIds: [] });
    expect(r.zeroShareDinerIds).toEqual(['d1']);
  });

  it('an assigned dish that was removed from the bill (moved) also brings the block back', async () => {
    const r = await shares({ lines: [], diners: [mkDiner(1, { dishLineIds: ['gone'] })], heads: 1, package: null });
    expect(r.zeroShareDinerIds).toEqual(['d1']);
  });

  it('a package diner never has a zero share just because no dish is assigned (the head is theirs)', async () => {
    const r = await shares({ lines: [pkg4()], diners: [mkDiner(1)], heads: 4, package: null });
    expect(r.zeroShareDinerIds).toEqual([]);
  });
});

describe('pruneDishAssignments: a voided or moved dish leaves the diner automatically', () => {
  it('keeps live lines, drops voided and missing ones, returns a new array and does not mutate', async () => {
    const live = mkLine({ id: 'a1', type: 'addon', priceC: 100, qty: 1 });
    const dead = mkLine({ id: 'a2', type: 'addon', priceC: 100, qty: 1, voided: 1 });
    const input = [mkDiner(1, { dishLineIds: ['a1', 'a2', 'a9'] }), mkDiner(2)];
    const frozen = JSON.parse(JSON.stringify(input));
    const out = await prune(input, [live, dead]);
    expect(out).not.toBe(input);
    expect(out[0]!.dishLineIds).toEqual(['a1']);
    expect(out[1]).toEqual(input[1]);
    expect(out[0]).toMatchObject({ id: 'd1', name: 'Diner 1', idNo: 'ID-1001' });
    expect(input).toEqual(frozen);
  });
});
