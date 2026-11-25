import { describe, expect, it } from 'vitest';
// One module (capabilities.ts imports nothing), same reason as super-admin-capability-set.test.ts.
import { CAPABILITY_AREA, CAPABILITY_LABEL, CAPABILITY_MATRIX, CAPABILITY_SCOPE, ROLE_ONLY_CAPABILITIES, SUPER_ADMIN_ONLY_CAPABILITIES } from '../src/capabilities';

/**
 * T-640 (Ian, 25 Nov 2026): `manage_ai_hub` is org scope, SUPER ADMIN ONLY, area admin. Pinned by hand, because the matrix test only proves code = document: a wrong cell
 * written into BOTH would pass it. The refusals for admin, manager and staff against the real hub functions are in packages/domain/tests/integration/t640-ai-hub.test.ts.
 */
describe('manage_ai_hub cell, pinned by hand', () => {
  it('super admin yes; admin, manager and staff no [kills: admin allowed to open the hub]', () => {
    expect(CAPABILITY_MATRIX.manage_ai_hub).toEqual({ super_admin: true, admin: false, manager: false, staff: false });
  });
  it('org scope, area admin, and it has a label [kills: store scope (a store grant would widen it); a missing label]', () => {
    expect(CAPABILITY_SCOPE.manage_ai_hub).toBe('org');
    expect(CAPABILITY_AREA.manage_ai_hub).toBe('admin');
    expect(CAPABILITY_LABEL.manage_ai_hub.length).toBeGreaterThan(10);
  });
  it('it is a member of the derived super-admin-only set, so new owners get it at creation and 0284 backfills the old ones [kills: a cell edit that silently drops it from the set]', () => {
    expect(SUPER_ADMIN_ONLY_CAPABILITIES).toContain('manage_ai_hub');
  });
  it('it is NOT role-only: owners hold super-admin-only capabilities as owner grants, so role-only would lock the owner out', () => {
    expect(ROLE_ONLY_CAPABILITIES.has('manage_ai_hub')).toBe(false);
  });
});
