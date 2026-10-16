import { describe, expect, it } from 'vitest';
import { validateProductionLines, type ProductionInputLine, type ProductionOutputLine } from '../../src/production/validate';

/**
 * T-409 S1 (unit half) - invariants 1, 2, 4: the slice category rule lives in the SHARED validator, so draft save, post and
 * `editPostedProduction` all refuse. `docs/tasks/409-production-slice-pickers.md` R1.
 *
 * TESTER. Red on HEAD because the validator never looks at `category` for a slice: every refusal case below comes back
 * `ok: true`. Built with Q1 = (a) BLOCK (the recommended option).
 *
 * Assumption (spec gap): the validator's line type carries no item NAME, only `itemId`; R1's sentence names the item, so
 * the builder either adds an optional name to the line or the name is added by the caller. The unit half therefore asserts
 * only that the refusal talks about slab / sliced meat; the integration half asserts the item NAME in the sentence.
 */
const inLine = (over: Partial<ProductionInputLine> = {}): ProductionInputLine => ({
  itemId: 'in-1', quantity: '10', unit: 'kg', resolved: true, isActive: true, parentSlabItemId: null, category: 'meat_slab', ...over,
});
const outLine = (over: Partial<ProductionOutputLine> = {}): ProductionOutputLine => ({
  itemId: 'out-1', quantity: '9', unit: 'kg', resolved: true, isActive: true, parentSlabItemId: 'in-1', category: 'meat_sliced', ...over,
});

describe('T-409 R1 - slicing takes only a meat slab and makes only sliced meat (HARD)', () => {
  it('invariant 4: slab in, sliced out -> ok. Control: the rule must not refuse the everyday run', () => {
    const r = validateProductionLines({ kind: 'slice', inputs: [inLine()], outputs: [outLine()] });
    expect(r.ok).toBe(true);
  });

  for (const bad of ['raw_material', 'supply', 'retail', 'meat_sliced'] as const) {
    it(`invariant 1: a slice input of kind ${bad} is refused with a sentence about slabs. Mutant: input leg removed -> ok -> red`, () => {
      const r = validateProductionLines({ kind: 'slice', inputs: [inLine({ category: bad })], outputs: [outLine()] });
      expect(r.ok, 'a non-slab input was let through').toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/slab/i);
    });
  }

  for (const bad of ['raw_material', 'supply', 'retail', 'meat_slab'] as const) {
    it(`invariant 2: a slice output of kind ${bad} is refused with a sentence about sliced meat. Mutant: output leg removed -> ok -> red`, () => {
      const r = validateProductionLines({ kind: 'slice', inputs: [inLine()], outputs: [outLine({ category: bad })] });
      expect(r.ok, 'a non-sliced output was let through').toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/sliced/i);
    });
  }

  it('a slice line with NO category at all (null / absent) is refused, never waved through as "unknown"', () => {
    const noIn = validateProductionLines({ kind: 'slice', inputs: [inLine({ category: null })], outputs: [outLine()] });
    expect(noIn.ok, 'null input category passed').toBe(false);
    const noOut = validateProductionLines({ kind: 'slice', inputs: [inLine()], outputs: [outLine({ category: undefined })] });
    expect(noOut.ok, 'absent output category passed').toBe(false);
  });

  it('ONE bad line among several is enough: two slab inputs plus one raw_material is refused. Mutant: only the first line checked', () => {
    const r = validateProductionLines({
      kind: 'slice',
      inputs: [inLine({ itemId: 'a' }), inLine({ itemId: 'b', category: 'raw_material' })],
      outputs: [outLine({ itemId: 'o1' }), outLine({ itemId: 'o2' })],
    });
    expect(r.ok).toBe(false);
    const r2 = validateProductionLines({
      kind: 'slice',
      inputs: [inLine()],
      outputs: [outLine({ itemId: 'o1' }), outLine({ itemId: 'o2', category: 'raw_material' })],
    });
    expect(r2.ok).toBe(false);
  });

  it('the rule is for SLICE only: a cook with raw_material in and out still validates here (cook is guarded by its recipe, R2). Mutant: rule applied to every kind', () => {
    const r = validateProductionLines({
      kind: 'cook',
      inputs: [inLine({ category: 'raw_material' })],
      outputs: [outLine({ category: 'raw_material' })],
    });
    expect(r.ok).toBe(true);
  });

  it('the rule is for SLICE only: a convert is judged by its own lineage rule, not this one. Mutant: rule applied to convert', () => {
    const r = validateProductionLines({
      kind: 'convert',
      inputs: [inLine({ category: 'meat_sliced', parentSlabItemId: 's' })],
      outputs: [outLine({ category: 'meat_sliced', parentSlabItemId: 's' })],
    });
    expect(r.ok).toBe(true);
  });

  it('invariant 4: a slab-to-sliced run whose output names a DIFFERENT source slab still passes the validator (the lineage mismatch stays soft). Mutant: warning promoted to a block', () => {
    const r = validateProductionLines({
      kind: 'slice',
      inputs: [inLine()],
      outputs: [outLine({ parentSlabItemId: 'some-other-slab' })],
    });
    expect(r.ok, 'a lineage mismatch must not be a block').toBe(true);
  });

  it('invariant 4: a sliced output with NO source slab set still passes, with its existing soft warning. Mutant: that warning promoted to a block', () => {
    const r = validateProductionLines({ kind: 'slice', inputs: [inLine()], outputs: [outLine({ parentSlabItemId: null })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/no source slab/i);
  });
});
