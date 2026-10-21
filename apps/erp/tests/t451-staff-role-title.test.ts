import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardWall, Roster } from '../src/app/staff/StaffViews';
import { staffRoleTitle } from '../src/app/staff/role-title';

describe('T-451 role-first staff presentation', () => {
  it('only staff uses a primary position; absent roles and missing primaries stay explicit', () => {
    expect(staffRoleTitle(null, 'Cashier')).toBe('No active role');
    expect(staffRoleTitle(undefined, 'Cashier')).toBe('No active role');
    expect(staffRoleTitle('staff', null)).toBe('No primary position');
  });
  it.each([['super_admin', 'Super admin'], ['admin', 'Admin'], ['manager', 'Manager'], ['staff', 'Cashier']])('%s uses %s before legacy assignments', (role, expected) => {
    const people = [{ id: 'e', displayName: 'Synthetic Person', role, primaryPosition: 'Cashier', employmentStatus: 'regular', startedOn: '2026-01-01', photoFileId: null }];
    for (const component of [CardWall, Roster]) {
      const html = renderToStaticMarkup(createElement(component as never, { people, storeName: 'Test', today: '2026-10-21', now: new Date('2026-10-21T04:00:00Z'), states: null } as never));
      expect(html).toContain(expected);
      if (role !== 'staff') expect(html).not.toContain('Cashier');
    }
  });
  it('uses compact flat cards without hanging badges', () => {
    const html = renderToStaticMarkup(createElement(CardWall, { people: [{ id: 'e', displayName: 'Synthetic Person', primaryPosition: 'Cashier', employmentStatus: 'regular', startedOn: '2026-01-01', photoFileId: null }], storeName: 'Test', today: '2026-10-21', states: null }));
    expect(html).toContain('data-staff-card');
    expect(html).toContain('erp-staff-summary');
    expect(html).not.toContain('rounded-t-[14px]');
    expect(html).not.toContain('hover:-rotate');
  });
});
