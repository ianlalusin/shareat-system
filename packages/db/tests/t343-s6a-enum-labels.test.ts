/**
 * T-343 S6a — label maps + lookup functions beside ITEM_KINDS, DISCREPANCY_DISPOSITIONS and
 * ORDER_WASTAGE_DISPOSITIONS. docs/tasks/343-def-417-human-readable-refusals.md §S6a.
 *
 * ⛔ Written as TESTER, not BUILDER, before S6a landed. `ITEM_KIND_LABEL`/`itemKindLabel`,
 * `DISCREPANCY_DISPOSITION_LABEL`/`discrepancyDispositionLabel` and
 * `ORDER_WASTAGE_DISPOSITION_LABEL`/`orderWastageDispositionLabel` did not exist on their schema
 * files yet — the imports resolved fine (Vitest's esbuild transform does not fail a named import
 * missing from an existing module) and each name was simply `undefined`, which is why the raw red
 * was an assertion failure ("undefined to deeply equal …") and a "is not a function" TypeError,
 * never a module-resolution error. Imported from the defining schema files, not the `@shareat/db`
 * barrel, so a missing barrel export line could not mask or fake a red (spec's own TESTER-paths
 * note).
 */
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_LABEL, itemKindLabel } from '../schema/items';
import {
  DISCREPANCY_DISPOSITIONS,
  DISCREPANCY_DISPOSITION_LABEL,
  discrepancyDispositionLabel,
} from '../schema/trade-discrepancies';
import {
  ORDER_WASTAGE_DISPOSITIONS,
  ORDER_WASTAGE_DISPOSITION_LABEL,
  orderWastageDispositionLabel,
} from '../schema/order-wastage';

describe('L1 — label maps match the S6a contract exactly, exhaustive over their enum', () => {
  it('ITEM_KIND_LABEL', () => {
    expect(ITEM_KIND_LABEL).toEqual({
      raw_material: 'Raw material',
      supply: 'Supply',
      retail: 'Retail item',
      meat_slab: 'Meat (slab)',
      meat_sliced: 'Meat (sliced)',
    });
    expect(Object.keys(ITEM_KIND_LABEL).sort()).toEqual([...ITEM_KINDS].sort());
  });

  it('DISCREPANCY_DISPOSITION_LABEL', () => {
    expect(DISCREPANCY_DISPOSITION_LABEL).toEqual({
      audit: 'Audit only',
      loss: 'Loss',
      charge: 'Charged to a person',
      late_receipt: 'Late receipt',
      // T-372 S6 (DEF-513): the over-receipt dispositions.
      extra_dispatch: 'Commissary sent more — book the extra',
      return: 'Returned to commissary / branch recount',
    });
    expect(Object.keys(DISCREPANCY_DISPOSITION_LABEL).sort()).toEqual([...DISCREPANCY_DISPOSITIONS].sort());
  });

  it('ORDER_WASTAGE_DISPOSITION_LABEL', () => {
    expect(ORDER_WASTAGE_DISPOSITION_LABEL).toEqual({
      platform_paid: 'Platform paid',
      absorbed: 'Store absorbed',
      charged: 'Charged',
    });
    expect(Object.keys(ORDER_WASTAGE_DISPOSITION_LABEL).sort()).toEqual([...ORDER_WASTAGE_DISPOSITIONS].sort());
  });
});

describe('L2 — lookup functions agree with their map for every enum value', () => {
  it('itemKindLabel', () => {
    for (const kind of ITEM_KINDS) expect(itemKindLabel(kind)).toBe(ITEM_KIND_LABEL[kind]);
  });

  it('discrepancyDispositionLabel', () => {
    for (const d of DISCREPANCY_DISPOSITIONS) {
      expect(discrepancyDispositionLabel(d)).toBe(DISCREPANCY_DISPOSITION_LABEL[d]);
    }
  });

  it('orderWastageDispositionLabel', () => {
    for (const d of ORDER_WASTAGE_DISPOSITIONS) {
      expect(orderWastageDispositionLabel(d)).toBe(ORDER_WASTAGE_DISPOSITION_LABEL[d]);
    }
  });
});

describe('L3 — totality: a value outside the enum never throws, and no output carries "_" or a newline', () => {
  it("itemKindLabel('prepped') humanises the ETL's out-of-enum value (stock/receipt-posting.ts:63-71)", () => {
    expect(itemKindLabel('prepped')).toBe('Prepped');
  });

  it("discrepancyDispositionLabel('constructor') returns humanised text, never a prototype member", () => {
    expect(discrepancyDispositionLabel('constructor')).toBe('Constructor');
  });

  it('no output of any db label function contains "_" or a newline', () => {
    const outputs = [
      ...ITEM_KINDS.map((k) => itemKindLabel(k)),
      ...DISCREPANCY_DISPOSITIONS.map((d) => discrepancyDispositionLabel(d)),
      ...ORDER_WASTAGE_DISPOSITIONS.map((d) => orderWastageDispositionLabel(d)),
      itemKindLabel('prepped'),
      discrepancyDispositionLabel('constructor'),
    ];
    for (const s of outputs) {
      expect(s.includes('_')).toBe(false);
      expect(s.includes('\n')).toBe(false);
    }
  });
});

describe('L5 — form: every label is one line, starts upper-case, no underscore; no map has two equal values', () => {
  const maps: Record<string, Readonly<Record<string, string>>> = {
    ITEM_KIND_LABEL,
    DISCREPANCY_DISPOSITION_LABEL,
    ORDER_WASTAGE_DISPOSITION_LABEL,
  };

  for (const [name, map] of Object.entries(maps)) {
    it(name, () => {
      const values = Object.values(map);
      for (const v of values) {
        expect(v.includes('\n')).toBe(false);
        expect(/^[A-Z]/.test(v)).toBe(true);
        expect(v.includes('_')).toBe(false);
      }
      expect(new Set(values).size).toBe(values.length);
    });
  }
});
