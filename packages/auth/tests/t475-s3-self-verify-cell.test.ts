import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_AREA,
  CAPABILITY_LABEL,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  type Capability,
} from '../src/capabilities';

/**
 * T-475 S3 - the capability cell, pinned by hand (docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md 5.1, "Ian's answers": Q3=A, Q4=A).
 * TESTER file, unit project. RED today: the capability does not exist (every lookup is undefined).
 *
 *   verify_own_supplier_invoice | org | super OK | admin OK | manager NO | staff NO | area suppliers
 *
 * Q4=A: it is NOT in ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER even though the set is DERIVED as "admin yes, manager no" - the builder must
 * subtract it explicitly. Mutant for the pin: the derived set left as-is (a stand-in manager gets it).
 */
const CAP = 'verify_own_supplier_invoice';
const row = () => (CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[CAP];

describe('T-475 S3 - verify_own_supplier_invoice, cell by cell', () => {
  it('is a Capability (compile-time via the cast) and is listed in CAPABILITIES. Mutant: capability not registered', () => {
    expect((CAPABILITIES as readonly string[]).includes(CAP)).toBe(true);
    const typed: Capability = CAP as Capability;
    expect(typed).toBe(CAP);
  });

  it('super_admin OK, admin OK, manager NO, staff NO. Mutant: manager true (a manager would verify what they logged)', () => {
    expect(row(), `${CAP} is not in CAPABILITY_MATRIX`).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });

  it('org scope (a store-scoped cell would let a store grant widen it). Mutant: scope store', () => {
    expect((CAPABILITY_SCOPE as Record<string, string | undefined>)[CAP]).toBe('org');
  });

  it('area suppliers; label "verify a supplier invoice you logged yourself". Mutant: wrong area / blank label', () => {
    expect((CAPABILITY_AREA as Record<string, string | undefined>)[CAP]).toBe('suppliers');
    expect((CAPABILITY_LABEL as Record<string, string | undefined>)[CAP]).toBe('verify a supplier invoice you logged yourself');
  });

  it('Q4=A: it is NOT in ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER (a stand-in manager does not get it). Mutant: the set stays purely derived', () => {
    expect((ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).includes(CAP)).toBe(false);
    // control: the set is still the derived delta for a sibling capability that admin holds and manager does not
    expect((ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).includes('manage_users')).toBe(true);
  });

  it('it does not change the super-admin-only set (admin holds it too). Mutant: super_admin only', () => {
    expect((SUPER_ADMIN_ONLY_CAPABILITIES as readonly string[]).includes(CAP)).toBe(false);
  });

  it('stays strictly narrower than verifying at all: nobody holds it who cannot verify a supplier invoice', () => {
    const m = CAPABILITY_MATRIX as Record<string, Record<string, boolean>>;
    for (const role of ['super_admin', 'admin', 'manager', 'staff']) {
      if (m[CAP]?.[role]) expect(m.verify_supplier_invoice![role], role).toBe(true);
    }
  });

  it('CAPABILITY-MATRIX.md carries the row in the Suppliers section with the same scope and cells', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'decisions', 'CAPABILITY-MATRIX.md'), 'utf8');
    const line = doc.split('\n').find((l) => l.startsWith(`| \`${CAP}\``));
    expect(line, `no row for ${CAP} in CAPABILITY-MATRIX.md`).toBeDefined();
    const cells = line!.split('|').map((c) => c.trim()).slice(2, 7);
    expect(cells).toEqual(['org', '✅', '✅', '✗', '✗']);
  });
});
