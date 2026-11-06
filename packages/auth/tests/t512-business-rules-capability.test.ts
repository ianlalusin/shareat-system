import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// ONE module, not the `@shareat/auth` barrel (same posture as t511-s2-settlement-capabilities.test.ts).
import {
  CAPABILITIES,
  CAPABILITY_AREA,
  CAPABILITY_LABEL,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  ROLE_ONLY_CAPABILITIES,
  SUPER_ADMIN_ONLY_CAPABILITIES,
} from '../src/capabilities';

/**
 * T-512 (T-511 S5c) TESTER - the capability `manage_business_rules`, pinned by hand. docs/tasks/512-business-rules-s5c-spec.md "Capability, audit, screen":
 * all six touchpoints in capabilities.ts (union, CAPABILITIES, SCOPE org, AREA, MATRIX admin only, LABEL) and a row in docs/decisions/CAPABILITY-MATRIX.md.
 * The matrix test proves code = document; a wrong cell written into BOTH would pass it, so the cell is pinned here independently (the t401 / t511-s2 pattern).
 * The DB-backed refusals (manager, staff, another org) are in packages/domain/tests/integration/t512-business-rules.test.ts.
 *
 * RED today: the capability does not exist, so every lookup finds nothing.
 *
 * ASSUMPTIONS beyond the agreed list: area is `admin` (precedent edit_platform_store_code, edit_loan_repayment_amount, set_channel_payout); scope is `org` (a rule is the
 * organisation's, not a store's); the capability is position-grantable (not role-only, not super-admin-only), and joins the derived admin-less-manager elevated set
 * (admin yes, manager no), like the other admin-only edits.
 */
type Cap = (typeof CAPABILITIES)[number];
const NAME = 'manage_business_rules';
const cap = NAME as Cap;
const MATRIX_DOC = readFileSync(resolve(__dirname, '../../../docs/decisions/CAPABILITY-MATRIX.md'), 'utf8');
const docRow = MATRIX_DOC.split('\n').find((l) => l.startsWith(`| \`${NAME}\` |`));

describe('T-512 - manage_business_rules, cell by cell', () => {
  it('is a registered capability', () => {
    expect(CAPABILITIES).toContain(NAME);
  });

  it('super_admin yes, admin yes, manager NO, staff NO [kills: manager true (whoever is measured by the tolerance moves it); staff true]', () => {
    expect(CAPABILITY_MATRIX[cap]).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });

  it('is ORG-scoped (a rule is the organisation\'s), in the admin area, and has a label [kills: store scope - a manager scoped to one store could then move a company-wide figure]', () => {
    expect(CAPABILITY_SCOPE[cap]).toBe('org');
    expect(CAPABILITY_AREA[cap]).toBe('admin');
    expect(CAPABILITY_LABEL[cap]).toBeTruthy();
    expect(String(CAPABILITY_LABEL[cap])).not.toContain('_');
  });

  it('is position-grantable, not super-admin-only, and joins the derived admin-less-manager elevated set (admin yes, manager no)', () => {
    expect(ROLE_ONLY_CAPABILITIES.has(cap)).toBe(false);
    expect(SUPER_ADMIN_ONLY_CAPABILITIES).not.toContain(NAME);
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).toContain(NAME);
  });
});

describe('T-512 - CAPABILITY-MATRIX.md agrees with capabilities.ts', () => {
  it('has a manage_business_rules row: org, yes, yes, no, no (the deliberately denied manager cell may be bold)', () => {
    expect(docRow, 'no manage_business_rules row in CAPABILITY-MATRIX.md').toBeDefined();
    expect(docRow).toMatch(/^\| `manage_business_rules` \| org \| ✅ \| ✅ \| (?:\*\*)?✗(?:\*\*)? \| ✗ \|/);
  });

  it('the row says why in a sentence (the notes column is not empty) [kills: a cell nobody can review]', () => {
    const cells = (docRow ?? '').split('|').map((c) => c.trim());
    expect(cells.length).toBeGreaterThanOrEqual(8);
    expect((cells[7] ?? '').length).toBeGreaterThan(20);
  });
});
