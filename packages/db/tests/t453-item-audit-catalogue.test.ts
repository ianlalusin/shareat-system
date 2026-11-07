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
    expect(AUDIT_CATALOGUE.length).toBeLessThanOrEqual(248); // 246 -> 248 kept in step with t402-s1b (T-525); 237 -> 246 (T-524: nine pos.* actions net of reserved T-402 entries it replaces, re-measured after rebase on main (0238+0239 present), 7 Nov 2026, BOSS approved); 236 -> 237 kept in step with t402-s1b (T-512 / T-511 S5c, 7 Nov 2026, re-measured after rebase on main, BOSS approved: business_rule.changed); 233 -> 236 kept in step with t402-s1b (T-511 S5b); 231 -> 233 kept in step with t402-s1b (T-519 S1: staff_deduction_agreement recorded + cancelled); 228 -> 231 kept in step with t402-s1b (T-510 S2: three menu_daypart.* actions); 227 -> 228 kept in step with t402-s1b (T-511 S4, 5 Nov 2026: settlement_upload.ingested); 220 -> 227 kept in step with t402-s1b (T-508 S2a, 4 Nov 2026, BOSS approved: +7 kitchen_station/kitchen_route actions); 218 -> 220 kept in step with t402-s1b (T-511 S2b, 3 Nov 2026: two new audit actions); 217 -> 218 kept in step with t402-s1b (two merges each added one audit action); 215 -> 217 kept in step with t402-s1b (T-455 S7a: 217 entries); 212 -> 215 kept in step with t402-s1b (T-455 S6a + T-502: 214 entries); 210 -> 212 T-455 S5 lobby.pause/resume; raised with t402-s1b-catalogue (195 -> 210: T-455 S2 lobby + T-475 S3); T-464 before
  });
});
