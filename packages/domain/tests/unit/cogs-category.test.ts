import { describe, expect, it } from 'vitest';
import { cogsCategoryForItemKind } from '../../src/stock/usage-records';

/**
 * T-168 / DEF-135 — items carry no COGS-category column of their own
 * (`packages/db/schema/items.ts` has `kind` only), so `cogsCategoryForItemKind` is the one place
 * that bridges `ItemKind` to COA-ALIGNMENT §4.1. v1 posts every kind to one COGS line too, so this
 * mapping is parity, not a regression — COA-ALIGNMENT marks `5100` "drive to zero" for the items
 * this cannot place more precisely.
 */
describe('cogsCategoryForItemKind', () => {
  it('meat_slab and meat_sliced both map to meat (5110)', () => {
    expect(cogsCategoryForItemKind('meat_slab')).toBe('meat');
    expect(cogsCategoryForItemKind('meat_sliced')).toBe('meat');
  });

  it('retail maps to retail (5160)', () => {
    expect(cogsCategoryForItemKind('retail')).toBe('retail');
  });

  it('supply maps to packaging (5150)', () => {
    expect(cogsCategoryForItemKind('supply')).toBe('packaging');
  });

  it('raw_material falls to the food catch-all (5100)', () => {
    expect(cogsCategoryForItemKind('raw_material')).toBe('food');
  });

  it('⚠️ prepped is not yet a real ITEM_KIND, but INVENTORY_ACCOUNT_BY_ITEM_KIND already names it — also food', () => {
    expect(cogsCategoryForItemKind('prepped')).toBe('food');
  });

  it('an unrecognised kind falls to the food catch-all rather than throwing', () => {
    expect(cogsCategoryForItemKind('something-nobody-declared')).toBe('food');
  });
});
