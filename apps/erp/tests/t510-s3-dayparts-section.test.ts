import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * T-510 S3 - the Lunch and dinner hours section on the store page, and the plain-words helpers behind it.
 * docs/tasks/510-menu-dayparts.md R9. The controls are drawn only when `canManage` (manage_store_settings): presentation, the domain gates the writes.
 */
vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));
vi.mock('../src/app/admin/stores/actions', () => ({
  createDaypartAction: async () => {},
  updateDaypartAction: async () => {},
  retireDaypartAction: async () => {},
}));

import { daysText, windowText } from '../src/app/menu/daypart-text';
import { DaypartsSection } from '../src/app/menu/DaypartsSection';

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const LUNCH = { id: 'd1', name: 'Lunch', days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00', status: 'active' as const };
const DINNER = { id: 'd2', name: 'Dinner', days: [1, 2, 3, 4, 5], start: '17:00', end: '08:00', status: 'active' as const };
const OLD = { id: 'd3', name: 'Brunch', days: [0, 6], start: '09:00', end: '11:00', status: 'retired' as const };

describe('plain words', () => {
  it('days', () => {
    expect(daysText([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(daysText([1, 2, 3, 4, 5])).toBe('Mon to Fri');
    expect(daysText([6, 0])).toBe('Sat, Sun');
    expect(daysText([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(daysText([])).toBe('No days');
  });
  it('hours, overnight says next day', () => {
    expect(windowText('08:00', '17:00')).toBe('08:00 to 17:00');
    expect(windowText('17:00', '08:00')).toBe('17:00 to 08:00 next day');
  });
});

describe('DaypartsSection', () => {
  const draw = (canManage: boolean, dayparts = [LUNCH, DINNER, OLD]) => renderToStaticMarkup(DaypartsSection({ storeId: 's1', dayparts, canManage }) as never);

  it('lists name, hours (overnight shown) and days to anyone; retired ones carry a Retired badge', () => {
    const t = plain(draw(false));
    expect(t).toContain('Lunch and dinner hours');
    expect(t).toContain('Lunch 08:00 to 17:00 Every day');
    expect(t).toContain('Dinner 17:00 to 08:00 next day Mon to Fri');
    expect(t).toContain('Retired hours (1)');
    expect(t).toContain('Brunch');
    expect(t).toContain('Retired');
  });

  it('a viewer without manage_store_settings gets no controls, only a plain note', () => {
    const html = draw(false);
    const t = plain(html);
    expect(html).not.toContain('Add hours');
    expect(html).not.toMatch(/<form/);
    expect(t).toContain('Only an admin or this store');
  });

  it('a manager of the store gets add, edit, retire (each a form with the store and the daypart)', () => {
    const html = draw(true);
    expect(html).toContain('>Add hours<');
    expect(html.match(/name="daypartId"/g)?.length).toBe(4); // edit + retire for each of the two active rows
    expect(html).toContain('name="storeId" value="s1"');
    expect(html.match(/>Retire hours</g)?.length).toBe(2); // retiring is for good: a retype-the-name button, one per active row
    expect(html.match(/name="days"/g)?.length).toBe(7 * 3); // two edit forms and the add form, seven day boxes each
  });

  it('no hours yet says every price is all day', () => {
    expect(plain(draw(false, []))).toContain('No hours yet. Every price here applies all day.');
  });
});
