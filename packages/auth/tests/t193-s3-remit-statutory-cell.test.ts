import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_AREA,
  CAPABILITY_LABEL,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  CONDITIONAL_CAPABILITIES,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  ROLE_ONLY_CAPABILITIES,
  SUPER_ADMIN_ONLY_CAPABILITIES,
} from '../src/capabilities';

/**
 * T-193 S3 - the `remit_statutory` cell, pinned by hand (the matrix test only proves code = document; a wrong cell written
 * into BOTH would pass it). docs/tasks/193-statutory-remittance/REFRESH.md s1 + C9:
 *   remit_statutory   org   super_admin yes   admin yes   manager NO   staff NO   area 'staff'
 * The DB-backed refusals (a manager and a staff member each refused, nothing written) are in
 * packages/domain/tests/integration/t193-s3-authorization.test.ts.
 *
 * RED until the builder adds the code row: today the key is in CAPABILITY-MATRIX.md only, so every lookup is undefined.
 * MUTANTS: store scope (a store manager would then pay for every store); manager yes; area missing (the access grid crashes);
 * label missing; document row absent or different from the code; capability made conditional or role-only (grants stop working).
 */
type Cap = (typeof CAPABILITIES)[number];
const CAP = 'remit_statutory' as string as Cap;
const MATRIX_DOC = readFileSync(resolve(__dirname, '../../../docs/decisions/CAPABILITY-MATRIX.md'), 'utf8');
const docRows = MATRIX_DOC.split('\n').filter((l) => l.startsWith(`| \`${CAP}\` |`));

describe('T-193 S3 - remit_statutory: org scope, admin and up only', () => {
  it('is a registered capability (kills: not added)', () => {
    expect(CAPABILITIES as readonly string[]).toContain(CAP);
  });

  it('super_admin yes, admin yes, manager NO, staff NO (kills: manager yes)', () => {
    expect(CAPABILITY_MATRIX[CAP]).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });

  it('org scope (kills: store scope)', () => {
    expect(CAPABILITY_SCOPE[CAP]).toBe('org');
  });

  it("area 'staff', like the other payroll capabilities (kills: no area)", () => {
    expect(CAPABILITY_AREA[CAP]).toBe('staff');
  });

  it('has a label a person can read (kills: no label)', () => {
    expect((CAPABILITY_LABEL[CAP] ?? '').length).toBeGreaterThan(8);
  });

  it('is an ordinary capability: not conditional, not role-only, not super-admin-only (so a grant works and admin holds it)', () => {
    expect(CONDITIONAL_CAPABILITIES.has(CAP)).toBe(false);
    expect(ROLE_ONLY_CAPABILITIES.has(CAP)).toBe(false);
    expect(SUPER_ADMIN_ONLY_CAPABILITIES as readonly string[]).not.toContain(CAP);
  });

  it('joins the adminless-manager fallback by derivation (admin yes, manager no)', () => {
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).toContain(CAP);
  });

  it('CAPABILITY-MATRIX.md has exactly one row: org, yes, yes, no, no (kills: document row missing or different)', () => {
    expect(docRows, 'exactly one remit_statutory row in CAPABILITY-MATRIX.md').toHaveLength(1);
    expect(docRows[0]).toMatch(/^\| `remit_statutory` \| org \| ✅ \| ✅ \| \*{0,2}✗\*{0,2} \| ✗ \|/);
  });

  it('manage_payroll_rates is unchanged: the employer numbers stay under it, admin only', () => {
    expect(CAPABILITY_MATRIX.manage_payroll_rates).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });
});
