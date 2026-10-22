import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardWall, Roster } from '../src/app/staff/StaffViews';
import { positionHolders, staffRoleTitle } from '../src/app/staff/role-title';

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
  it('preserves the lanyard ID-card design with role-first titles', () => {
    const html = renderToStaticMarkup(createElement(CardWall, { people: [{ id: 'e', displayName: 'Synthetic Person', primaryPosition: 'Cashier', employmentStatus: 'regular', startedOn: '2026-01-01', photoFileId: null }], storeName: 'Test', today: '2026-10-21', states: null }));
    expect(html).toContain('data-staff-card');
    expect(html).toContain('rounded-b-[50%]');
    expect(html).toContain('rounded-t-[14px]');
    expect(html).toContain('hover:-rotate');
  });
});

describe('T-453 T7 who holds a position (DEF-729)', () => {
  const at = (positionId: string) => [{ positionId }];
  const row = (id: string, displayName: string, role: string | null, positions = at('p1')) => ({ id, displayName, role, positions });
  it('lists every holder whatever the role, staff first then flagged, each by name, with the specified notes', () => {
    const roster = [
      row('sa', 'Zed Super', 'super_admin'),
      row('nr', 'Nina Norole', null),
      row('st2', 'Bea Staff', 'staff'),
      row('ad', 'Ada Admin', 'admin'),
      row('mg', 'Mo Manager', 'manager'),
      row('st1', 'Al Staff', 'staff'),
      row('other', 'Elsewhere Staff', 'staff', at('p2')),
    ];
    const holders = positionHolders(roster as never, 'p1');
    expect(holders).toHaveLength(6);
    expect(holders.map((h) => h.id)).toEqual(['st1', 'st2', 'ad', 'mg', 'nr', 'sa']);
    const note = (id: string) => holders.find((h) => h.id === id)!.note;
    expect(note('st1')).toBeNull();
    expect(note('st2')).toBeNull();
    expect(note('mg')).toBe('Manager — legacy position, grants still apply');
    expect(note('ad')).toBe('Admin — legacy position, grants still apply');
    expect(note('sa')).toBe('Super admin — legacy position, grants still apply');
    expect(note('nr')).toBe('No active role — legacy position');
  });
  it('a position nobody holds has no holders', () => {
    expect(positionHolders([row('a', 'A', 'admin', at('p2'))] as never, 'p1')).toEqual([]);
  });
});
