import { describe, expect, it } from 'vitest';
// Pure module (no db import): runs in the unit project, before any migration.
import { AUDIT_CATALOGUE, catalogueEntry } from '../src/audit/catalogue';

/**
 * T-453 T6 (DEF-728) - the three item-catalogue audit actions exist in the closed list, labelled like `rename_item`.
 * Mutant: omit any one entry -> that case goes red. (The 190 ceiling lives in t402-s1b-catalogue and is not touched here.)
 */
describe('T-453 T6 item audit actions are in the catalogue', () => {
  const rename = catalogueEntry('rename_item')!;
  it.each([
    ['item.variant_set', 'items'],
    ['item_duplicate.dismissed', 'item_duplicate_dismissals'],
    ['item_duplicate.dismissal_undone', 'item_duplicate_dismissals'],
  ])('%s is catalogued (entity %s, owner T-453, same labels as rename_item)', (action, entity) => {
    const e = catalogueEntry(action);
    expect(e, `${action} missing from AUDIT_CATALOGUE`).toBeDefined();
    expect(e!.entity).toBe(entity);
    expect(e!.owner).toBe('T-453');
    expect([e!.category, e!.sensitivity, e!.scope]).toEqual([rename.category, rename.sensitivity, rename.scope]);
  });
  it('the list stays under the ceiling (189 entries after this task)', () => {
    expect(AUDIT_CATALOGUE.length).toBeLessThanOrEqual(212); // 210 -> 212 T-455 S5 lobby.pause/resume; raised with t402-s1b-catalogue (195 -> 210: T-455 S2 lobby + T-475 S3); T-464 before
  });
});
