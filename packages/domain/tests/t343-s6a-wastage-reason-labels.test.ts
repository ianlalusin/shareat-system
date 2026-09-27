/**
 * T-343 S6a — WASTAGE_REASON_LABEL / wastageReasonLabel beside WASTAGE_REASONS.
 * docs/tasks/343-def-417-human-readable-refusals.md §S6a.
 *
 * ⛔ Written as TESTER, not BUILDER, before S6a landed. `WASTAGE_REASON_LABEL`/`wastageReasonLabel`
 * did not exist on `stock/wastage-reasons.ts` yet — the import resolved fine (Vitest's esbuild
 * transform does not fail a named import missing from an existing module) and each name was
 * simply `undefined`, which is why the raw red was an assertion failure ("undefined to deeply
 * equal …") and a "is not a function" TypeError, never a module-resolution error. Imported from
 * the defining file, not the `@shareat/domain` barrel, so a missing barrel export line could not
 * mask or fake a red (spec's own TESTER-paths note).
 */
import { describe, expect, it } from 'vitest';
import { WASTAGE_REASONS, WASTAGE_REASON_LABEL, wastageReasonLabel } from '../src/stock/wastage-reasons';

describe('L1 — WASTAGE_REASON_LABEL matches the S6a contract exactly, exhaustive over WASTAGE_REASONS', () => {
  it('matches the table', () => {
    expect(WASTAGE_REASON_LABEL).toEqual({
      spoilage: 'Spoilage',
      expiry: 'Expired',
      damage_storage: 'Damaged in storage',
      damage_handling: 'Damaged in handling',
      prep_loss: 'Prep loss (trim, peel, bone)',
      overproduction: 'Overproduction',
      theft: 'Theft or unexplained loss',
      quality_reject: 'Failed quality check',
      customer_return_unsellable: 'Customer return, not resellable',
      other: 'Other',
    });
    expect(Object.keys(WASTAGE_REASON_LABEL).sort()).toEqual([...WASTAGE_REASONS].sort());
  });
});

describe('L2 — wastageReasonLabel agrees with the map for every WASTAGE_REASON', () => {
  it('every reason', () => {
    for (const reason of WASTAGE_REASONS) {
      expect(wastageReasonLabel(reason)).toBe(WASTAGE_REASON_LABEL[reason]);
    }
  });
});

describe('L3 — totality: an unrecognised code never throws, and no output carries "_" or a newline', () => {
  it("wastageReasonLabel('some_old_code') humanises rather than throwing", () => {
    expect(wastageReasonLabel('some_old_code')).toBe('Some old code');
  });

  it('no output contains "_" or a newline', () => {
    const outputs = [...WASTAGE_REASONS.map((r) => wastageReasonLabel(r)), wastageReasonLabel('some_old_code')];
    for (const s of outputs) {
      expect(s.includes('_')).toBe(false);
      expect(s.includes('\n')).toBe(false);
    }
  });
});

describe('L5 — form: every label is one line, starts upper-case, no underscore, no duplicate value', () => {
  it('WASTAGE_REASON_LABEL', () => {
    // Typed explicitly: while the import is unresolved (pre-builder), TS infers the failed
    // named import as `any`, and `Object.values<T>` cannot infer `T` from an `any` argument —
    // strict mode then defaults it to `unknown`, not `any`, which fails typecheck for reasons
    // that have nothing to do with the missing export. The db test's L5 avoids the same trap by
    // typing its map dictionary the same way.
    const map: Readonly<Record<string, string>> = WASTAGE_REASON_LABEL;
    const values = Object.values(map);
    for (const v of values) {
      expect(v.includes('\n')).toBe(false);
      expect(/^[A-Z]/.test(v)).toBe(true);
      expect(v.includes('_')).toBe(false);
    }
    expect(new Set(values).size).toBe(values.length);
  });
});
