import { describe, expect, it } from 'vitest';

import { CAPABILITIES, CAPABILITY_MATRIX, ROLE_ONLY_CAPABILITIES } from '../src/capabilities';

/**
 * T-508 R10 - kitchen stations and routes ride on `manage_store_settings` (store-scoped), pinned by hand as LITERALS.
 * Each yes is proven, and each no is the cell the domain test (packages/domain/tests/integration/t508-s2-kitchen-domain.test.ts)
 * fires: staff refused, a manager of another store refused. A new `manage_kitchen` capability was NOT added (R10).
 */
const CAP = 'manage_store_settings';

describe('T-508 R10 - manage_store_settings, cell by cell (literal)', () => {
  it('is registered and the matrix row is exactly super yes, admin yes, manager yes, staff no', () => {
    expect((CAPABILITIES as readonly string[]).includes(CAP)).toBe(true);
    expect((CAPABILITY_MATRIX as Record<string, Record<string, boolean>>)[CAP]).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
  });

  it('is not role-only: a store-scoped grant works, which is what scopes a manager to their own store', () => {
    expect(ROLE_ONLY_CAPABILITIES.has(CAP as never)).toBe(false);
  });

  it('no kitchen-specific capability exists (R10: reuse, do not add)', () => {
    expect((CAPABILITIES as readonly string[]).filter((c) => /kitchen/.test(c))).toEqual([]);
  });
});
