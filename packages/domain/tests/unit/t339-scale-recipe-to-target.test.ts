import { describe, expect, it } from 'vitest';
import { scaleRecipeToTarget } from '../../src/production';

/**
 * T-339 slice 2 (DEF-165) — `scaleRecipeToTarget`'s private `scaleQuantity` divides by an EXTRA
 * `1000n` after the real result is already in thousandths, making every scaled line 1000x too
 * small. Zero callers today (`docs/tasks/339-small-defects-batch-1.md` slice 2), so this is the
 * first test to exercise it at all.
 *
 * Half-up form proven correct in `packages/domain/src/pos/plan.ts`'s `scaleIngredient` — the fix
 * this task ports into `production/index.ts`.
 */
describe('scaleRecipeToTarget (DEF-165)', () => {
  it('red: 0.500 kg scaled from a 1.000 output to a 2.000 target is 1.000, not 0.001', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'flour', quantity: '0.500', unit: 'kg', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '1.000',
      targetOutputQuantity: '2.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('1.000');
  });

  it('converts units while scaling: 500.000 g (base kg) from output 4.000 to target 10.000 is 1.250', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'sugar', quantity: '500.000', unit: 'g', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '4.000',
      targetOutputQuantity: '10.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('1.250');
  });

  it('rounds half up: 0.001 x 1.000 / 2.000 -> 0.001 (0.0005 rounds up)', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'salt', quantity: '0.001', unit: 'kg', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '2.000',
      targetOutputQuantity: '1.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('0.001');
  });

  // ⚠️ POST-FIX PIN, not part of the red set: 0.00033's half-up rounding lands on '0.000' under
  // BOTH the buggy (1000x-too-small) and the fixed arithmetic, so this case is already green
  // today. It stays to pin the rounds-down behaviour once the fix lands, not to prove the fix.
  it('post-fix pin (already green today): 0.001 x 1.000 / 3.000 -> 0.000 (0.00033 rounds down)', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'salt', quantity: '0.001', unit: 'kg', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '3.000',
      targetOutputQuantity: '1.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('0.000');
  });

  it('negative half: a zero target is refused, before and after the fix', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'flour', quantity: '0.500', unit: 'kg', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '1.000',
      targetOutputQuantity: '0.000',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/greater than zero/);
  });

  it('negative half: an inconvertible unit pairing is refused, before and after the fix', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'eggs', quantity: '2.000', unit: 'pcs', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '1.000',
      targetOutputQuantity: '2.000',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/cannot be converted/);
  });

  // ⭐ /code-review finding — recipeOutputQuantity is not validated at all: only `target` is
  // checked with `isPositiveQuantity`. A zero recipeOutputQuantity hits `d === 0n` in
  // `scaleQuantity` and returns silent zeros for every line rather than refusing (the DEF-412
  // "out of scope" note names this exact gap: "recipeOutputQuantity = 0 returns zeros silently").
  it('red: a zero recipeOutputQuantity is refused, not silently zeroed', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'flour', quantity: '0.500', unit: 'kg', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '0.000',
      targetOutputQuantity: '2.000',
    });
    expect(result.ok).toBe(false);
  });

  it('red: a negative recipeOutputQuantity is refused', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'flour', quantity: '0.500', unit: 'kg', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '-1.000',
      targetOutputQuantity: '2.000',
    });
    expect(result.ok).toBe(false);
  });

  // ⭐ /code-review finding — scaling happens in the LINE's own unit, THEN converts to the item's
  // base unit (`production/index.ts:207-210`). When the line's own unit is coarser than its base
  // unit, the intermediate scaled value can round to zero at 3dp BEFORE the unit conversion ever
  // gets a chance to give it more room — a precision loss the plain 1000x-too-small bug (DEF-165)
  // does not explain and its arithmetic fix alone does not cure: converting 0.001 kg to grams
  // FIRST (1.000 g) then scaling by 4/10 gives 0.400 g; scaling 0.001 kg by 4/10 first (0.0004,
  // rounds to 0.000 kg) then converting gives 0.000 g regardless of the /1000n fix.
  it('red: scaling a coarse-unit line loses precision that converting first would keep (0.001 kg -> g, x0.4 should be 0.400 g, not 0.000)', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'yeast', quantity: '0.001', unit: 'kg', itemBaseUnit: 'g' }],
      recipeOutputQuantity: '10.000',
      targetOutputQuantity: '4.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('0.400');
  });

  // ⭐ /code-review regression — the convert-first fix above cures the COARSE-to-FINE direction
  // (kg line, g base) but the reverse, FINE-to-COARSE direction (g line, kg base) now loses
  // precision it did not lose before: converting 1.500 g to kg FIRST rounds to the nearest gram
  // (kg only has 3dp = 1g resolution) as `0.002` kg, baking in a rounding error BEFORE scaling
  // ever runs — 1.500 g scaled by 2/1 should be 3.000 g = 0.003 kg, not 0.004. Scaling FIRST, in
  // the line's own (finer) unit, keeps the precision the coarser base unit would otherwise round
  // away. Neither a fixed order is right for both directions; this pins the currently-wrong one.
  it('red: scaling a fine-unit line into a coarser base unit — convert-first rounds too early (1.500 g -> kg, x2 should be 0.003, not 0.004)', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'vanilla', quantity: '1.500', unit: 'g', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '1.000',
      targetOutputQuantity: '2.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('0.003');
  });

  it('red: same fine-to-coarse regression at a different target (1.500 g -> kg, x10 should be 0.015, not 0.020)', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'vanilla', quantity: '1.500', unit: 'g', itemBaseUnit: 'kg' }],
      recipeOutputQuantity: '1.000',
      targetOutputQuantity: '10.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('0.015');
  });

  // ml/ltr twin — `unit-conversion.ts`'s `CONVERTIBLE_UNITS` covers ml<->ltr with the same 1:1000
  // factor as g<->kg, so the same fine-to-coarse regression applies identically.
  it('red: ml/ltr twin of the fine-to-coarse regression (1.500 ml -> ltr, x2 should be 0.003, not 0.004)', () => {
    const result = scaleRecipeToTarget({
      recipeLines: [{ itemId: 'extract', quantity: '1.500', unit: 'ml', itemBaseUnit: 'ltr' }],
      recipeOutputQuantity: '1.000',
      targetOutputQuantity: '2.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines[0]!.quantity).toBe('0.003');
  });
});
