/**
 * T-502 S1 (TESTER, red until built). Unit level, no database: the service kind exists and has its label.
 * Companion to t343-s6a-enum-labels.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { ITEM_KINDS, ITEM_KIND_LABEL, itemKindLabel } from '@shareat/db/schema';

describe('T-502 S1 - ITEM_KINDS += service', () => {
  it('lists service exactly once and keeps the five existing kinds', () => {
    const kinds = ITEM_KINDS as readonly string[];
    expect(kinds.filter((k) => k === 'service')).toHaveLength(1);
    for (const k of ['raw_material', 'supply', 'retail', 'meat_slab', 'meat_sliced']) expect(kinds).toContain(k);
  });
  it('labels it "Service" (the label map is exhaustive over ITEM_KINDS)', () => {
    expect(itemKindLabel('service')).toBe('Service');
    expect(Object.keys(ITEM_KIND_LABEL).sort()).toEqual([...ITEM_KINDS].sort());
  });
});
