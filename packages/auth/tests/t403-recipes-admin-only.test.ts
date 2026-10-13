import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// ONE module, not the `@shareat/auth` barrel (same posture as super-admin-capability-set.test.ts).
import { CAPABILITIES, CAPABILITY_AREA, CAPABILITY_LABEL, CAPABILITY_MATRIX, CAPABILITY_SCOPE } from '../src/capabilities';

/**
 * T-403 R4 (+ the matrix half of R1/R2/R3) - recipes and the v1 POS mapping are admin-only.
 * RED today: `manage_recipes` does not exist (missing-symbol failures: the matrix/scope/area/label/doc lookups find
 * nothing), and `manage_pos_map` is still manager-true (assertion failure).
 */
type Cap = (typeof CAPABILITIES)[number];
const cap = (name: string) => name as Cap;
const MATRIX_DOC = readFileSync(resolve(__dirname, '../../../docs/decisions/CAPABILITY-MATRIX.md'), 'utf8');
const docRow = (name: string) => MATRIX_DOC.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));

describe('T-403 R4 - manage_recipes exists and is admin-only', () => {
  it('is a registered capability', () => {
    expect(CAPABILITIES).toContain('manage_recipes');
  });
  it('super_admin yes, admin yes, manager NO, staff NO', () => {
    expect(CAPABILITY_MATRIX[cap('manage_recipes')]).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });
  it('is org-scoped, in the production area, and has a label', () => {
    expect(CAPABILITY_SCOPE[cap('manage_recipes')]).toBe('org');
    expect(CAPABILITY_AREA[cap('manage_recipes')]).toBe('production');
    expect(CAPABILITY_LABEL[cap('manage_recipes')]).toBeTruthy();
  });
  it('manage_items is UNCHANGED (managers keep the item master)', () => {
    expect(CAPABILITY_MATRIX.manage_items).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
  });
});

describe('T-403 R2/R3 - manage_pos_map is admin-only; requesting and deciding keep their cells', () => {
  it('manage_pos_map: manager is NO, and it keeps its store scope', () => {
    expect(CAPABILITY_MATRIX.manage_pos_map).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
    expect(CAPABILITY_SCOPE.manage_pos_map).toBe('store');
  });
  it('request_pos_map and decide_pos_map_request are unchanged', () => {
    expect(CAPABILITY_MATRIX.request_pos_map).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
    expect(CAPABILITY_MATRIX.decide_pos_map_request).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
  });
});

describe('T-403 R4 - CAPABILITY-MATRIX.md agrees with capabilities.ts', () => {
  it('has a manage_recipes row: org, yes, yes, no, no', () => {
    const row = docRow('manage_recipes');
    expect(row, 'no manage_recipes row in CAPABILITY-MATRIX.md').toBeDefined();
    expect(row).toMatch(/^\| `manage_recipes` \| org \| ✅ \| ✅ \| ✗ \| ✗ \|/);
  });
  it('the manage_pos_map row reads store, yes, yes, no, no', () => {
    expect(docRow('manage_pos_map')).toMatch(/^\| `manage_pos_map` \| store \| ✅ \| ✅ \| ✗ \| ✗ \|/);
  });
});
