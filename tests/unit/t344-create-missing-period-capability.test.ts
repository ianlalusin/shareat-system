import { describe, expect, it } from 'vitest';
import { CAPABILITY_MATRIX, CAPABILITY_SCOPE, type Capability } from '../../packages/auth/src/capabilities';
import { OFFERABLE_TO_POSITIONS } from '../../packages/domain/src/people/position-defaults';

/**
 * T-344 / DEF-422 §3.4 — `create_missing_period`: admin/super_admin only, org-scoped, never
 * offerable to a position. `docs/tasks/344-def-422-fiscal-period-holes.md` §4, File 3.
 *
 * ⛔ RED until the builder adds `create_missing_period` to the `Capability` union and every table
 * `capabilities.ts`'s header enumerates — today `'create_missing_period'` is not a member of
 * `Capability` at all, so `CAPABILITY_MATRIX['create_missing_period' as Capability]` reads
 * `undefined`, and indexing `OFFERABLE_TO_POSITIONS`/`CAPABILITY_SCOPE` similarly finds nothing.
 * (The literal-object-key form below would fail to compile with TS2353 — "object literal may only
 * specify known properties" — before this file even runs; the `as Capability` cast sidesteps that
 * so the runtime assertions below get to run and fail on their own, real terms instead.)
 */

describe('create_missing_period — the capability matrix row', () => {
  it('super_admin and admin hold it; manager and staff do not', () => {
    const cap = 'create_missing_period' as Capability;
    expect(CAPABILITY_MATRIX[cap]).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });

  it('is org-scoped', () => {
    const cap = 'create_missing_period' as Capability;
    expect(CAPABILITY_SCOPE[cap]).toBe('org');
  });

  it('is not offerable to a position — it changes closed books, same as close_period', () => {
    expect(OFFERABLE_TO_POSITIONS).not.toContain('create_missing_period' as Capability);
  });
});

describe('override_period_lock — unchanged by this task', () => {
  it('still admin/super_admin only, org-scoped', () => {
    expect(CAPABILITY_MATRIX.override_period_lock).toEqual({
      super_admin: true,
      admin: true,
      manager: false,
      staff: false,
    });
    expect(CAPABILITY_SCOPE.override_period_lock).toBe('org');
  });
});
