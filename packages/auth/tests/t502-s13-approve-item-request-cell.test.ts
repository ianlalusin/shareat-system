import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  ROLE_ONLY_CAPABILITIES,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  grantsConfer,
} from '../src/capabilities';

/**
 * T-502 section 13 ruling A4 - `approve_item_request`, pinned by hand (LITERALS, not derived from ROLE_ONLY_CAPABILITIES).
 * The adminless-manager fallback set is DERIVED as "admin yes, manager no, not role-only". If someone drops the capability from
 * ROLE_ONLY_CAPABILITIES the derivation would silently hand it to a stand-in manager; this file fails first.
 */
const CAP = 'approve_item_request';

describe('T-502 A4 - approve_item_request, cell by cell (literal)', () => {
  it('is registered and the matrix row is exactly super yes, admin yes, manager no, staff no', () => {
    expect((CAPABILITIES as readonly string[]).includes(CAP)).toBe(true);
    const row = (CAPABILITY_MATRIX as Record<string, Record<string, boolean>>)[CAP];
    expect(row).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });

  it('is NOT in the adminless-manager fallback (literal assertion, independent of ROLE_ONLY_CAPABILITIES)', () => {
    expect((ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).includes(CAP)).toBe(false);
    // control: the set is still the derived delta for a sibling capability that admin holds and manager does not
    expect((ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).includes('manage_users')).toBe(true);
  });

  it('is role-only: a person grant cannot confer it', () => {
    expect(ROLE_ONLY_CAPABILITIES.has(CAP as never)).toBe(true);
    expect(grantsConfer(CAP as never)).toBe(false);
    expect(grantsConfer('manage_fixed_assets' as never), 'control: an ordinary capability is grantable').toBe(true);
  });

  it('is not super-admin-only (admin holds it), while approve_item (create, merge) stays super-admin only', () => {
    expect((SUPER_ADMIN_ONLY_CAPABILITIES as readonly string[]).includes(CAP)).toBe(false);
    expect((SUPER_ADMIN_ONLY_CAPABILITIES as readonly string[]).includes('approve_item')).toBe(true);
  });
});
