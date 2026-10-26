import { describe, expect, it } from 'vitest';
import { grantableCapabilitiesFor } from '../src/app/admin/users/lib';
import { CAPABILITY_MATRIX } from '../../../packages/auth/src/capabilities';

/**
 * T-475 S3 - "Ian's answers" Q3=A: verify_own_supplier_invoice is NOT grantable; "the grant screen hides it".
 * The picker is `grantableCapabilitiesFor(role)` (apps/erp/src/app/admin/users/lib.ts). Today it offers every capability the role's
 * matrix cell denies, so a manager would be offered this one; the builder must exclude it for EVERY role, including the null-role case
 * (which returns all capabilities today). Control: an ordinary admin-only capability is still offered to a manager.
 * The first leg pins the matrix row's existence so the exclusion legs cannot pass on a missing capability. RED today: that leg.
 */
const CAP = 'verify_own_supplier_invoice';

describe('T-475 S3 - the grant screen never offers verify_own_supplier_invoice', () => {
  it('precondition: the capability exists in the matrix (so the legs below are not vacuous)', () => {
    expect((CAPABILITY_MATRIX as Record<string, unknown>)[CAP], 'RED today: capability absent').toBeDefined();
  });

  for (const role of ['manager', 'staff', 'admin', 'super_admin', null] as const) {
    it(`${String(role)}: grantableCapabilitiesFor does not list it. Mutant: picker purely derived from the matrix`, () => {
      expect((CAPABILITY_MATRIX as Record<string, unknown>)[CAP], 'capability must exist for this leg to mean anything').toBeDefined();
      expect((grantableCapabilitiesFor(role) as readonly string[]).includes(CAP)).toBe(false);
    });
  }

  it('control: an ordinary admin-only capability is still offered to a manager (the exclusion is targeted, not a blanket)', () => {
    expect((grantableCapabilitiesFor('manager') as readonly string[]).includes('manage_fixed_assets')).toBe(true);
  });
});
