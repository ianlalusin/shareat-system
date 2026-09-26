import { describe, expect, it } from 'vitest';
import { CAPABILITY_MATRIX, CAPABILITY_SCOPE } from '../../packages/auth/src/capabilities';
import { OFFERABLE_TO_POSITIONS } from '../../packages/domain/src/people/position-defaults';

/**
 * T-345 §3.4 — `book_missed_month`: admin/super_admin only, org-scoped, never offerable to a
 * position. `docs/tasks/345-missed-month-depreciation-adjustment.md` §3.4, Amendment R3.5, File 2.
 *
 * ⭐ R3.5: asserts the REAL `CAPABILITY_MATRIX.book_missed_month` row directly — no spread-overwrite
 * `satisfies` trick. That trick existed only to force a TS2353 while the key was not yet a
 * `Capability` at all; now that the builder has landed it, a direct property read is both simpler
 * and the stronger proof (it fails to even COMPILE if the key is ever removed again, same as
 * `t344-create-missing-period-capability.test.ts`'s own style once its capability existed).
 */

describe('book_missed_month — the capability matrix row', () => {
  it('super_admin and admin hold it; manager and staff do not', () => {
    expect(CAPABILITY_MATRIX.book_missed_month).toEqual({
      super_admin: true,
      admin: true,
      manager: false,
      staff: false,
    });
  });

  it('is org-scoped', () => {
    expect(CAPABILITY_SCOPE.book_missed_month).toBe('org');
  });

  it('is not offerable to a position — it changes closed books, same as close_period and create_missing_period', () => {
    expect(OFFERABLE_TO_POSITIONS).not.toContain('book_missed_month');
  });
});
