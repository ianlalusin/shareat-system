/**
 * T-426 slice T - closing the old whole-bill senior/PWD path in the Bill Discount popover. Ruling 4, Acceptance 6.
 *
 * CONTRACT for the builder (S2) - NEW module `apps/pos/src/components/cashier/statutory-presets.ts` (pure; no React):
 *   STATUTORY_DISCOUNT_REFUSAL = 'Use the Senior / PWD button so the name and ID are recorded.'
 *   isStatutoryDiscount(d: { name?: string | null; vatExempt?: boolean | null }): boolean
 *       - true when `vatExempt` is truthy OR the name matches /senior|\bsc\b|pwd|osca/i (Malvar's non-exempt "PWDDiscount" was used in the PC-0 window).
 *   selectableBillDiscounts<T extends { name?: string | null; vatExempt?: boolean | null }>(discounts: T[]): T[]
 *       - the popover's preset list: a NEW array without any statutory discount, original order, same objects.
 *   checkCustomBillDiscount(input: { name?: string | null }): { ok: true } | { ok: false; message: string }
 *       - a custom discount whose name is statutory is refused with STATUTORY_DISCOUNT_REFUSAL; a blank name or "Custom Discount" is fine.
 *   assertBillDiscountAllowed(discount: { name?: string | null; vatExempt?: boolean | null } | null): void
 *       - throws Error(STATUTORY_DISCOUNT_REFUSAL) for a statutory discount; null and ordinary discounts pass. The session screen calls it before it
 *         writes a bill discount, so a stale preset or a custom entry cannot reach Firestore.
 *   `components/cashier/bill-adjustments.tsx` must LIST presets through selectableBillDiscounts and APPLY through checkCustomBillDiscount /
 *   assertBillDiscountAllowed (guarded below by reading the source: a component test needs a DOM this project does not have).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMod, need } from '@/test-helpers/statutoryOracle';

const SENTENCE = 'Use the Senior / PWD button so the name and ID are recorded.';
const P = '@/components/cashier/statutory-presets';
const W = 'apps/pos/src/components/cashier/statutory-presets.ts';
const fn = async <T>(name: string) => need<T>(await loadMod(P), name, W);
type D = { name?: string | null; vatExempt?: boolean | null; id?: string };

describe('which presets count as senior/PWD', () => {
  it('the refusal sentence is exactly the one the spec names', async () => {
    expect((await loadMod(P)).STATUTORY_DISCOUNT_REFUSAL).toBe(SENTENCE);
  });

  it.each([
    ['a vatExempt preset with an innocent name', { name: 'Special 20%', vatExempt: true }],
    ['Malvar\'s non-exempt "PWDDiscount"', { name: 'PWDDiscount', vatExempt: false }],
    ['"Senior Citizen 20%"', { name: 'Senior Citizen 20%' }],
    ['"SC Discount" (the word SC)', { name: 'SC Discount' }],
    ['"sc"', { name: 'sc' }],
    ['"OSCA card"', { name: 'OSCA card' }],
    ['lower-case "pwd"', { name: 'pwd 20' }],
    ['"Senior" inside a longer name', { name: 'Seniors night' }],
  ])('%s is statutory', async (_l, d) => {
    expect((await fn<(d: D) => boolean>('isStatutoryDiscount'))(d)).toBe(true);
  });

  it.each([
    ['"Birthday 10%"', { name: 'Birthday 10%', vatExempt: false }],
    ['"Staff meal"', { name: 'Staff meal' }],
    ['"Scone promo" (sc inside a word is not the word SC)', { name: 'Scone promo' }],
    ['a blank name', { name: '' }],
    ['no name at all', {}],
    ['"Custom Discount"', { name: 'Custom Discount' }],
  ])('%s is not statutory', async (_l, d) => {
    expect((await fn<(d: D) => boolean>('isStatutoryDiscount'))(d)).toBe(false);
  });
});

describe('the popover list (Acceptance 6)', () => {
  it('hides every vatExempt preset and every preset named like senior / SC / PWD / OSCA; keeps the rest in order, same objects', async () => {
    const list: D[] = [
      { id: '1', name: 'Birthday 10%' },
      { id: '2', name: 'Senior 20%', vatExempt: true },
      { id: '3', name: 'PWDDiscount', vatExempt: false },
      { id: '4', name: 'Staff meal' },
      { id: '5', name: 'Exempt promo', vatExempt: true },
      { id: '6', name: 'OSCA' },
      { id: '7', name: 'SC' },
      { id: '8', name: 'Opening week' },
    ];
    const frozen = JSON.parse(JSON.stringify(list));
    const out = (await fn<(d: D[]) => D[]>('selectableBillDiscounts'))(list);
    expect(out.map((d) => d.id)).toEqual(['1', '4', '8']);
    expect(out[0]).toBe(list[0]);
    expect(out).not.toBe(list);
    expect(list).toEqual(frozen);
  });

  it('an empty list stays empty', async () => {
    expect((await fn<(d: D[]) => D[]>('selectableBillDiscounts'))([])).toEqual([]);
  });
});

describe('a custom discount named like senior/PWD is refused with the sentence', () => {
  it('checkCustomBillDiscount: "PWD" and "Senior 20" are refused; ordinary names and the default pass', async () => {
    const check = await fn<(i: { name?: string | null }) => { ok: boolean; message?: string }>('checkCustomBillDiscount');
    for (const name of ['PWD', 'senior 20', 'SC', 'osca discount']) {
      const r = check({ name });
      expect(r.ok, name).toBe(false);
      expect(r.message).toBe(SENTENCE);
    }
    for (const name of ['Custom Discount', 'Spilled drink', '', undefined, null]) expect(check({ name: name as any }), String(name)).toEqual({ ok: true });
  });

  it('assertBillDiscountAllowed throws the sentence for a statutory discount and lets null and ordinary discounts through', async () => {
    const assertOk = await fn<(d: D | null) => void>('assertBillDiscountAllowed');
    expect(() => assertOk({ name: 'Senior 20%', vatExempt: true })).toThrow(SENTENCE);
    expect(() => assertOk({ name: 'PWDDiscount' })).toThrow(SENTENCE);
    expect(() => assertOk({ name: 'x', vatExempt: true })).toThrow(SENTENCE);
    expect(() => assertOk({ name: 'Birthday 10%' })).not.toThrow();
    expect(() => assertOk(null)).not.toThrow();
  });
});

describe('the popover and the session screen really use the guard (source check)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('bill-adjustments.tsx lists presets through selectableBillDiscounts and no longer maps the raw discounts list into the select', () => {
    const src = read('./bill-adjustments.tsx');
    expect(src).toMatch(/from\s+['"]\.\/statutory-presets['"]|from\s+['"]@\/components\/cashier\/statutory-presets['"]/);
    expect(src).toContain('selectableBillDiscounts(');
    expect(src).not.toMatch(/\{\s*discounts\.map\(\s*\(?d\)?\s*=>\s*<SelectItem/);
    expect(src).toMatch(/checkCustomBillDiscount\(|assertBillDiscountAllowed\(/);
  });

  it('session-detail-view.tsx calls assertBillDiscountAllowed before it writes a bill discount', () => {
    const src = read('./session-detail-view.tsx');
    expect(src).toContain('assertBillDiscountAllowed(');
  });
});
