import { describe, expect, it } from 'vitest';
// The pure half of R1/R2 (no database). THE MODULE AND NAME ARE THE TESTER'S ASSUMPTION (the spec names this test file but no
// pure function): packages/domain/src/production/recipe-shape.ts exporting validateRecipeShape. Red today: module not found.
import { validateRecipeShape } from '../../src/production/recipe-shape';

/**
 * T-413 S1 (unit half) - the shape rules that need no database: figures (R1: 0 < qty <= 10,000, at most 3 decimals), the name,
 * the line count, duplicates, output-as-ingredient. `validateRecipeShape(input)` returns { ok: true } or { ok: false, reason }.
 * Item existence / status / org / base unit need the database and are the integration file's.
 * Mutants: `<` for `<=`; the cap missing on lines; the 50-line limit off by one; a name not trimmed before the length test.
 */
type Line = { itemId: string; quantity: string };
const lines = (n: number): Line[] => Array.from({ length: n }, (_, i) => ({ itemId: `item-${i}`, quantity: '1' }));
const base = { name: 'Stew', outputItemId: 'out', outputQuantity: '2', lines: lines(2) };
const check = (over: Partial<typeof base> = {}) => validateRecipeShape({ ...base, ...over });
const refused = (r: { ok: boolean }) => r.ok === false;

describe('figures: 0 < qty <= 10,000, at most 3 decimals - output and every line', () => {
  for (const bad of ['0', '-1', '10000.001', '', ' ', 'abc', '1.2345', '1e3', '0.0001']) {
    it(`output '${bad}' is refused`, () => expect(refused(check({ outputQuantity: bad }))).toBe(true));
    it(`line '${bad}' is refused`, () => expect(refused(check({ lines: [{ itemId: 'a', quantity: bad }] }))).toBe(true));
  }
  for (const good of ['10000', '0.001', '1', '9999.999', '10000.000']) {
    it(`output '${good}' is accepted`, () => expect(check({ outputQuantity: good }).ok).toBe(true));
    it(`line '${good}' is accepted`, () => expect(check({ lines: [{ itemId: 'a', quantity: good }] }).ok).toBe(true));
  }
  it('a refusal is a plain sentence', () => {
    const r = check({ outputQuantity: '0' }) as { ok: false; reason: string };
    expect(r.reason.length).toBeGreaterThan(10);
    expect(r.reason).not.toMatch(/violates|constraint|SQLSTATE/i);
  });
});

describe('name: required, trimmed, at most 80 characters', () => {
  it('blank and whitespace-only are refused', () => {
    expect(refused(check({ name: '' }))).toBe(true);
    expect(refused(check({ name: '   ' }))).toBe(true);
  });
  it('80 characters pass, 81 do not, and the length is judged AFTER trimming', () => {
    expect(check({ name: 'x'.repeat(80) }).ok).toBe(true);
    expect(refused(check({ name: 'x'.repeat(81) }))).toBe(true);
    expect(check({ name: `  ${'x'.repeat(80)}  ` }).ok).toBe(true);
  });
});

describe('lines: 1 to 50, no duplicate item, the output is not an ingredient', () => {
  it('0 lines refused; 1 and 50 accepted; 51 refused', () => {
    expect(refused(check({ lines: [] }))).toBe(true);
    expect(check({ lines: lines(1) }).ok).toBe(true);
    expect(check({ lines: lines(50) }).ok).toBe(true);
    expect(refused(check({ lines: lines(51) }))).toBe(true);
  });
  it('the same ingredient twice is refused', () => {
    expect(refused(check({ lines: [{ itemId: 'a', quantity: '1' }, { itemId: 'a', quantity: '2' }] }))).toBe(true);
  });
  it('the output item as an ingredient is refused', () => {
    expect(refused(check({ lines: [{ itemId: 'out', quantity: '1' }, { itemId: 'a', quantity: '1' }] }))).toBe(true);
  });
  it('control: a valid recipe is ok', () => expect(check().ok).toBe(true));
});
