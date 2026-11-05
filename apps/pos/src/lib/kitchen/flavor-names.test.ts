/** T-508 S6 - kitchen "Flv:" badges: ERP flavour ids resolve to names; firestore mode keeps its own map. */
import { describe, expect, it } from 'vitest';
import { adaptFlavors } from '@/lib/menu/from-erp';
import { sampleMenu } from '@/test-helpers/menuFixture';
import { kitchenFlavorMap, flavorNamesOf } from './flavor-names';

describe('kitchen flavour names', () => {
  it('erp mode: an ERP flavour id renders its name, not Unknown', () => {
    const erp = { flavors: adaptFlavors(sampleMenu()) };
    const map = kitchenFlavorMap(erp, new Map());
    expect(flavorNamesOf(['fv-spicy'], map)).toEqual([erp.flavors.find((f) => f.flavorId === 'fv-spicy')!.flavorName]);
    expect(flavorNamesOf(['fv-spicy'], map)).not.toContain('Unknown');
  });
  it('erp mode: a stale firestore map cannot override the ERP names', () => {
    const map = kitchenFlavorMap({ flavors: adaptFlavors(sampleMenu()) }, new Map([['fv-spicy', 'WRONG']]));
    expect(flavorNamesOf(['fv-spicy'], map)).not.toContain('WRONG');
  });
  it('firestore mode: the Firestore map is used untouched, unknown ids still say Unknown', () => {
    const fs = new Map([['f1', 'Garlic']]);
    expect(kitchenFlavorMap(null, fs)).toBe(fs);
    expect(flavorNamesOf(['f1', 'zz'], fs)).toEqual(['Garlic', 'Unknown']);
  });
});
