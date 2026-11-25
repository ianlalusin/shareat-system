import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// One module (capabilities.ts imports nothing), same posture as t640-ai-hub-capability-cell.test.ts.
import { CAPABILITIES, CAPABILITY_AREA, CAPABILITY_LABEL, CAPABILITY_MATRIX, CAPABILITY_SCOPE, ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER, ROLE_ONLY_CAPABILITIES, SUPER_ADMIN_ONLY_CAPABILITIES } from '../src/capabilities';

/**
 * T-641 (Ian, 25 Nov 2026): `use_ask_erp` opens the Ask ERP door. Org scope, area books. Super admin, admin and manager yes; STAFF NO by default (the matrix keeps staff off, as it does for every
 * working right since T-318) and grantable to a person or a position, so an owner decides who may ask. Pinned by hand: the matrix test only proves code = document, so a wrong cell written into
 * BOTH would pass it. The refusals against the real feature (a person with no right is refused before any model is called; a staff member WITH the grant reaches only the knowledge tools) are in
 * packages/domain/tests/integration/t641-ask-erp.test.ts.
 */
const NAME = 'use_ask_erp';
const MATRIX_DOC = readFileSync(resolve(__dirname, '../../../docs/decisions/CAPABILITY-MATRIX.md'), 'utf8');
const docRow = MATRIX_DOC.split('\n').find((l) => l.startsWith(`| \`${NAME}\` |`));

describe('use_ask_erp cell, pinned by hand', () => {
  it('is registered once', () => {
    expect(CAPABILITIES.filter((c) => c === NAME)).toHaveLength(1);
  });
  it('super admin, admin and manager yes; staff no [kills: staff allowed by default; manager locked out]', () => {
    expect(CAPABILITY_MATRIX.use_ask_erp).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
  });
  it('org scope, area books, with a label [kills: store scope (a store grant would be needed at every store); a missing label]', () => {
    expect(CAPABILITY_SCOPE.use_ask_erp).toBe('org');
    expect(CAPABILITY_AREA.use_ask_erp).toBe('books');
    expect(CAPABILITY_LABEL.use_ask_erp.length).toBeGreaterThan(10);
  });
  it('it is grantable (not role-only, not super-admin-only), so a position or a person can be given it [kills: a role-only cell that no owner can extend to staff]', () => {
    expect(ROLE_ONLY_CAPABILITIES.has(NAME)).toBe(false);
    expect(SUPER_ADMIN_ONLY_CAPABILITIES).not.toContain(NAME);
  });
  it('a manager already holds it, so it is not part of the elevated set an admin-less manager is given [kills: a cell that makes manager lose it]', () => {
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).not.toContain(NAME);
  });
  it('has a row in CAPABILITY-MATRIX.md: org, yes, yes, yes, no [kills: code and document drifting]', () => {
    expect(docRow, 'no use_ask_erp row in CAPABILITY-MATRIX.md').toBeDefined();
    expect(docRow).toMatch(/^\| `use_ask_erp` \| org \| ✅ \| ✅ \| ✅ \| ✗ \|/);
  });
});
