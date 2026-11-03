import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// ONE module, not the `@shareat/auth` barrel (same posture as t403-recipes-admin-only.test.ts).
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
 * T-511 S2a (TESTER, 2026-11-03) - three new capabilities for the settlement-upload feature. docs/tasks/511-settlement-upload-s2-spec.md
 * "Capabilities and audit (2a)"; BOSS ruling: all three are STORE scope.
 *
 *   upload_settlement_files    super_admin yes, admin yes, manager YES, staff no   (area sales; manager uploads their store's statements)
 *   edit_platform_store_code   super_admin yes, admin yes, manager NO,  staff no   (area admin; precedent set_channel_payout)
 *   edit_loan_repayment_amount super_admin yes, admin yes, manager NO,  staff no   (area admin; precedent set_channel_payout)
 *
 * RED today: none of the three exists, so every lookup finds nothing. Each cell is pinned on its own so a mutant that flips one
 * cell (manager true on an edit, staff true on the upload) fails exactly that test.
 */
type Cap = (typeof CAPABILITIES)[number];
const cap = (name: string) => name as Cap;
const MATRIX_DOC = readFileSync(resolve(__dirname, '../../../docs/decisions/CAPABILITY-MATRIX.md'), 'utf8');
const docRow = (name: string) => MATRIX_DOC.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));

const UPLOAD = 'upload_settlement_files';
const EDIT_CODE = 'edit_platform_store_code';
const EDIT_AMOUNT = 'edit_loan_repayment_amount';

describe('T-511 S2a - upload_settlement_files', () => {
  it('is a registered capability', () => {
    expect(CAPABILITIES).toContain(UPLOAD);
  });
  it('super_admin yes, admin yes, manager YES, staff NO [kills: staff true (a waiter uploads statements); manager false]', () => {
    expect(CAPABILITY_MATRIX[cap(UPLOAD)]).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
  });
  it('is store-scoped, in the sales area, and has a label', () => {
    expect(CAPABILITY_SCOPE[cap(UPLOAD)]).toBe('store');
    expect(CAPABILITY_AREA[cap(UPLOAD)]).toBe('sales');
    expect(CAPABILITY_LABEL[cap(UPLOAD)]).toBeTruthy();
  });
  it('is position-grantable (not role-only, not super-admin-only) and is NOT in the admin-less-manager elevated set (a manager already holds it)', () => {
    expect(ROLE_ONLY_CAPABILITIES.has(cap(UPLOAD))).toBe(false);
    expect(SUPER_ADMIN_ONLY_CAPABILITIES).not.toContain(UPLOAD);
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).not.toContain(UPLOAD);
  });
});

describe('T-511 S2a - edit_platform_store_code', () => {
  it('is a registered capability', () => {
    expect(CAPABILITIES).toContain(EDIT_CODE);
  });
  it('super_admin yes, admin yes, manager NO, staff NO [kills: manager true (a manager changes which store a Grab/Foodpanda file maps to)]', () => {
    expect(CAPABILITY_MATRIX[cap(EDIT_CODE)]).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });
  it('is store-scoped, in the admin area, and has a label', () => {
    expect(CAPABILITY_SCOPE[cap(EDIT_CODE)]).toBe('store');
    expect(CAPABILITY_AREA[cap(EDIT_CODE)]).toBe('admin');
    expect(CAPABILITY_LABEL[cap(EDIT_CODE)]).toBeTruthy();
  });
  it('joins the derived admin-less-manager elevated set (admin yes, manager no) and is position-grantable', () => {
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).toContain(EDIT_CODE);
    expect(ROLE_ONLY_CAPABILITIES.has(cap(EDIT_CODE))).toBe(false);
  });
});

describe('T-511 S2a - edit_loan_repayment_amount', () => {
  it('is a registered capability', () => {
    expect(CAPABILITIES).toContain(EDIT_AMOUNT);
  });
  it('super_admin yes, admin yes, manager NO, staff NO [kills: manager true (a manager changes the figure the loan check compares against)]', () => {
    expect(CAPABILITY_MATRIX[cap(EDIT_AMOUNT)]).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });
  it('is store-scoped, in the admin area, and has a label', () => {
    expect(CAPABILITY_SCOPE[cap(EDIT_AMOUNT)]).toBe('store');
    expect(CAPABILITY_AREA[cap(EDIT_AMOUNT)]).toBe('admin');
    expect(CAPABILITY_LABEL[cap(EDIT_AMOUNT)]).toBeTruthy();
  });
  it('joins the derived admin-less-manager elevated set (admin yes, manager no) and is position-grantable', () => {
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).toContain(EDIT_AMOUNT);
    expect(ROLE_ONLY_CAPABILITIES.has(cap(EDIT_AMOUNT))).toBe(false);
  });
});

describe('T-511 S2a - CAPABILITY-MATRIX.md agrees with capabilities.ts', () => {
  // The doc marks a deliberately-denied manager cell in bold (`**✗**`, see set_channel_payout), so the regex allows the bold on that cell.
  it('has an upload_settlement_files row: store, yes, yes, yes, no', () => {
    const row = docRow(UPLOAD);
    expect(row, 'no upload_settlement_files row in CAPABILITY-MATRIX.md').toBeDefined();
    expect(row).toMatch(/^\| `upload_settlement_files` \| store \| ✅ \| ✅ \| ✅ \| ✗ \|/);
  });
  it('has an edit_platform_store_code row: store, yes, yes, no, no', () => {
    const row = docRow(EDIT_CODE);
    expect(row, 'no edit_platform_store_code row in CAPABILITY-MATRIX.md').toBeDefined();
    expect(row).toMatch(/^\| `edit_platform_store_code` \| store \| ✅ \| ✅ \| (?:\*\*)?✗(?:\*\*)? \| ✗ \|/);
  });
  it('has an edit_loan_repayment_amount row: store, yes, yes, no, no', () => {
    const row = docRow(EDIT_AMOUNT);
    expect(row, 'no edit_loan_repayment_amount row in CAPABILITY-MATRIX.md').toBeDefined();
    expect(row).toMatch(/^\| `edit_loan_repayment_amount` \| store \| ✅ \| ✅ \| (?:\*\*)?✗(?:\*\*)? \| ✗ \|/);
  });
});
