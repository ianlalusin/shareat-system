import { describe, expect, it } from 'vitest';
import { CAPABILITY_AREA, CAPABILITY_MATRIX, CAPABILITY_SCOPE } from '../src/capabilities';

/** T-510 S2 (Ian, 2026-11-05): `pair_menu_dayparts` is org scope, super admin ONLY, in the sales area. The DB-backed refusals are in packages/domain/tests/integration/t510-s2-writers.test.ts. */
describe('pair_menu_dayparts cell, pinned by hand', () => {
  it('super admin yes; admin, manager and staff no; org scope; sales area', () => {
    expect(CAPABILITY_MATRIX.pair_menu_dayparts).toEqual({ super_admin: true, admin: false, manager: false, staff: false });
    expect(CAPABILITY_SCOPE.pair_menu_dayparts).toBe('org');
    expect(CAPABILITY_AREA.pair_menu_dayparts).toBe('sales');
  });
  it('daypart windows stay manage_store_settings and prices stay set_menu_price (manager yes, store scope)', () => {
    expect(CAPABILITY_MATRIX.manage_store_settings).toMatchObject({ super_admin: true, admin: true, manager: true, staff: false });
    expect(CAPABILITY_MATRIX.set_menu_price).toMatchObject({ super_admin: true, admin: true, manager: true, staff: false });
    expect(CAPABILITY_SCOPE.set_menu_price).toBe('store');
  });
});
