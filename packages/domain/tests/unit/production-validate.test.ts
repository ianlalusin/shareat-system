import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { quantity } from '../../src/stock/quantity';
import { convertUnit, isConvertibleUnit } from '../../src/production/unit-conversion';
import {
  computeValueIdentity,
  PRODUCTION_QTY_EPS,
  validateConvertLineage,
  validateProductionLines,
  type ProductionInputLine,
  type ProductionOutputLine,
} from '../../src/production/validate';

/** T-176 §9 test 4 / §8 invariant 4 — the pure conversion table. */
describe('unit-conversion.ts — the single copy (DEF-093)', () => {
  it('g<->kg converts', () => {
    expect(convertUnit(quantity('500'), 'g', 'kg')).toBe(quantity('0.500'));
    expect(convertUnit(quantity('2.5'), 'kg', 'g')).toBe(quantity('2500'));
  });

  it('ml<->ltr converts', () => {
    expect(convertUnit(quantity('750'), 'ml', 'ltr')).toBe(quantity('0.750'));
    expect(convertUnit(quantity('1.2'), 'ltr', 'ml')).toBe(quantity('1200'));
  });

  it('same unit is a no-op pass-through', () => {
    expect(convertUnit(quantity('10'), 'kg', 'kg')).toBe(quantity('10'));
  });

  it('⛔ pcs<->pack, pcs<->box and kg<->ltr all refuse — a per-item factor this module will not guess', () => {
    expect(convertUnit(quantity('1'), 'pcs', 'pack')).toBeNull();
    expect(convertUnit(quantity('1'), 'pcs', 'box')).toBeNull();
    expect(convertUnit(quantity('1'), 'kg', 'ltr')).toBeNull();
  });

  it('⚠️ a blank unit on either side is never an implicit match', () => {
    expect(convertUnit(quantity('1'), '', 'kg')).toBeNull();
    expect(convertUnit(quantity('1'), 'kg', '  ')).toBeNull();
  });

  it('isConvertibleUnit recognises exactly the base-unit vocabulary', () => {
    expect(isConvertibleUnit('kg')).toBe(true);
    expect(isConvertibleUnit('pack')).toBe(false);
  });

  it('⭐ test 5 — ONE conversion implementation: no second unit table exists in the package', () => {
    // Greps every .ts file under packages/domain/src for a second literal g/kg/ml/ltr conversion
    // table — the exact shape DEF-093 names (`production-recipe.actions.ts` duplicating
    // `recipe-units.ts`). This file (unit-conversion.ts) is the one and only hit expected.
    const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          // The tell-tale shape: a literal 1000-scaling between g/kg or ml/ltr, written as a
          // conversion RULE (not merely a schema enum mentioning the unit names).
          if (/from\s*===\s*'g'.*to\s*===\s*'kg'|from\s*===\s*'kg'.*to\s*===\s*'g'/s.test(text)) {
            hits.push(full);
          }
        }
      }
    };
    walk(srcRoot);
    expect(hits).toEqual([join(srcRoot, 'production', 'unit-conversion.ts')]);
  });
});

const resolved = (itemId: string, over: Partial<ProductionInputLine & ProductionOutputLine> = {}): ProductionInputLine & ProductionOutputLine => ({
  itemId,
  quantity: '10',
  unit: 'kg',
  resolved: true,
  isActive: true,
  parentSlabItemId: null,
  category: null,
  ...over,
});

describe('validateProductionLines — HARD blocks (§10.3)', () => {
  it('⭐ test 15 — zero outputs is refused, and the error names a wastage instead', () => {
    const result = validateProductionLines({ kind: 'slice', inputs: [resolved('slab')], outputs: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/wastage/);
  });

  it('zero inputs is refused', () => {
    const result = validateProductionLines({ kind: 'slice', inputs: [], outputs: [resolved('out1')] });
    expect(result.ok).toBe(false);
  });

  it('an unresolvable source is a HARD reject', () => {
    const result = validateProductionLines({
      kind: 'slice', inputs: [resolved('ghost', { resolved: false })], outputs: [resolved('out1', { quantity: '5' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/does not resolve/);
  });

  it('an unresolvable output is a HARD reject', () => {
    const result = validateProductionLines({
      kind: 'slice', inputs: [resolved('slab')], outputs: [resolved('ghost', { resolved: false })],
    });
    expect(result.ok).toBe(false);
  });

  it('non-positive quantity is refused', () => {
    const result = validateProductionLines({
      kind: 'slice', inputs: [resolved('slab', { quantity: '0' })], outputs: [resolved('out1', { quantity: '5' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/greater than zero/);
  });

  it('non-numeric quantity is refused, separately from non-positive', () => {
    const result = validateProductionLines({
      kind: 'slice', inputs: [resolved('slab', { quantity: 'abc' })], outputs: [resolved('out1', { quantity: '5' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/non-numeric/);
  });

  it('⭐ test 2 — output exceeding input is a HARD block', () => {
    const result = validateProductionLines({
      kind: 'slice', inputs: [resolved('slab', { quantity: '10' })], outputs: [resolved('out1', { quantity: '15' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cannot exceed input/);
  });

  it('⭐ test 16 — the same product cannot be both input and output', () => {
    const result = validateProductionLines({
      kind: 'slice', inputs: [resolved('same', { quantity: '10' })], outputs: [resolved('same', { quantity: '5' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/both an input and an output/);
  });

  it('⭐ test 4 — a pcs<->pack pairing is refused with a readable error', () => {
    const result = validateProductionLines({
      kind: 'slice',
      inputs: [resolved('slab', { unit: 'pcs', quantity: '10' })],
      outputs: [resolved('out1', { unit: 'pack', quantity: '5' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cannot be converted/);
  });

  it('g<->kg mixed units convert cleanly and post', () => {
    const result = validateProductionLines({
      kind: 'slice',
      inputs: [resolved('slab', { unit: 'kg', quantity: '10' })],
      outputs: [resolved('out1', { unit: 'g', quantity: '9500' })],
    });
    expect(result.ok).toBe(true);
  });

  it('⭐ test 18 — the SCALE tolerance holds both ways on the output-exceeds-input check', () => {
    // Outputs totalling 0.005 above input are ALLOWED (within PRODUCTION_QTY_EPS = 0.01).
    const ok = validateProductionLines({
      kind: 'slice', inputs: [resolved('slab', { quantity: '10.000' })], outputs: [resolved('out1', { quantity: '10.005' })],
    });
    expect(ok.ok).toBe(true);
    // But 0.02 above is refused — past tolerance.
    const refused = validateProductionLines({
      kind: 'slice', inputs: [resolved('slab', { quantity: '10.000' })], outputs: [resolved('out1', { quantity: '10.02' })],
    });
    expect(refused.ok).toBe(false);
  });
});

describe('validateProductionLines — SOFT warnings (§10.4), never block', () => {
  it('⭐ test 3 / test 19 — a lineage mismatch (no source slab on the output) WARNS and posts', () => {
    const result = validateProductionLines({
      kind: 'slice',
      inputs: [resolved('slab', { quantity: '10' })],
      outputs: [resolved('out1', { quantity: '5', parentSlabItemId: null })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('an inactive input or output item warns, never blocks', () => {
    const result = validateProductionLines({
      kind: 'slice',
      inputs: [resolved('slab', { quantity: '10', isActive: false })],
      outputs: [resolved('out1', { quantity: '5', parentSlabItemId: 'slab' })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes('inactive'))).toBe(true);
  });
});

describe('validateConvertLineage — §10.5, five checks', () => {
  it('⭐ test 6 — between two children of the SAME slab, posts', () => {
    const result = validateConvertLineage({
      sourceItemId: 'child-a', targetItemId: 'child-b',
      sourceParentSlabItemId: 'slab-1', targetParentSlabItemId: 'slab-1',
    });
    expect(result.ok).toBe(true);
  });

  it('⭐ test 6 — between children of DIFFERENT slabs, refused', () => {
    const result = validateConvertLineage({
      sourceItemId: 'child-a', targetItemId: 'child-b',
      sourceParentSlabItemId: 'slab-1', targetParentSlabItemId: 'slab-2',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/SAME slab/);
  });

  it('refuses the same product as both source and target', () => {
    const result = validateConvertLineage({
      sourceItemId: 'same', targetItemId: 'same',
      sourceParentSlabItemId: 'slab-1', targetParentSlabItemId: 'slab-1',
    });
    expect(result.ok).toBe(false);
  });

  it('⚠️ a null slab on both sides does NOT compare equal — both "has a slab" checks are separate', () => {
    const result = validateConvertLineage({
      sourceItemId: 'child-a', targetItemId: 'child-b',
      sourceParentSlabItemId: null, targetParentSlabItemId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no parent slab/);
  });

  it('requires both a source and a target id', () => {
    const result = validateConvertLineage({
      sourceItemId: null, targetItemId: 'child-b', sourceParentSlabItemId: null, targetParentSlabItemId: 'slab-1',
    });
    expect(result.ok).toBe(false);
  });
});

describe('PRODUCTION_QTY_EPS — §10.2, a SCALE tolerance, not a float defence', () => {
  it('is exactly 0.01 base units', () => {
    expect(PRODUCTION_QTY_EPS).toBe(quantity('0.01'));
  });
});

describe('computeValueIdentity — invariant 2 / §3 / §10.1', () => {
  it('⭐ reduces to T-133\'s own ₱310/kg when there is no yield loss (labour, no gap)', () => {
    // 100 kg in at ₱300/kg = ₱30,000, ₱1,000 labour, 100 kg out — no gap. T-133 states this is
    // exactly ₱310/kg, and this is the one part of the spec's worked numbers this implementer
    // could verify independently (see validate.ts's own spec-defect note on test 1's figures).
    const result = computeValueIdentity({
      inputCost: money('30000.00'), labourCost: money('1000.00'),
      sourceQuantity: quantity('100'), outputQuantity: quantity('100'),
    });
    expect(result.yieldGapQuantity).toBe(quantity('0'));
    expect(result.yieldLossValue).toBe(money('0.00'));
    expect(result.outputTotalValue).toBe(money('31000.00'));
  });

  it('a real yield gap costs the loss at the input\'s own blended rate and clamps at zero (invariant 19)', () => {
    // 100 kg in at ₱300/kg, 97 kg out — a 3 kg gap valued at ₱300/kg = ₱900. Output absorbs
    // labour in full; the gap does not inflate the output's own unit cost (§3).
    const result = computeValueIdentity({
      inputCost: money('30000.00'), labourCost: money('1000.00'),
      sourceQuantity: quantity('100'), outputQuantity: quantity('97'),
    });
    expect(result.yieldGapQuantity).toBe(quantity('3'));
    expect(result.yieldLossValue).toBe(money('900.00'));
    expect(result.outputTotalValue).toBe(money('30100.00'));
  });

  it('⭐ invariant 19 — outputs exceeding input by a hair clamp the gap to ZERO, never negative', () => {
    const result = computeValueIdentity({
      inputCost: money('1000.00'), labourCost: money('0.00'),
      sourceQuantity: quantity('10.000'), outputQuantity: quantity('10.005'),
    });
    expect(result.yieldGapQuantity).toBe(quantity('0'));
    expect(result.yieldLossValue).toBe(money('0.00'));
  });

  it('the plug never exceeds what came in, even for a pathological gap', () => {
    const result = computeValueIdentity({
      inputCost: money('100.00'), labourCost: money('0.00'),
      sourceQuantity: quantity('10'), outputQuantity: quantity('0.001'),
    });
    expect(Number(result.outputTotalValue)).toBeGreaterThanOrEqual(0);
  });
});
