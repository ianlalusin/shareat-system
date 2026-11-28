import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTE_CAPABILITY } from '../src/lib/route-capability';
import { crumbSteps, CRUMB_PAGES } from '../src/components/nav-crumbs';
import { MENU_CATEGORY_RULES, MENU_ITEM_EDIT_RULES } from '@shareat/domain/field-rules';

/**
 * T-651 screen guards (source-level; the page is an async server component that needs a session): the gate, the tablet-sized named buttons, the one-form-per-list
 * save, and that the bare "Sort order" boxes are gone from the category and item forms.
 */
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'menu');
const read = (f: string) => readFileSync(resolve(app, f), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (l.includes('//') ? l.slice(0, l.indexOf('//')) : l)).join('\n');

describe('T-651 /menu/arrange', () => {
  const page = code(read('arrange/page.tsx'));
  const list = code(read('arrange/ArrangeList.tsx'));
  const actions = code(read('arrange/actions.ts'));

  it('is gated by the page check, with the same word the writes check (manage_menu), and has a breadcrumb [kills: an open page]', () => {
    expect(page).toContain("requirePageAccess('/menu/arrange')");
    expect(page).toContain('if (refusal) return refusal');
    expect(ROUTE_CAPABILITY['/menu/arrange']).toBe('manage_menu');
    expect(CRUMB_PAGES).toContain('/menu/arrange');
    expect(crumbSteps('/menu/arrange').map((s) => s.label)).toEqual(['Menu', 'Arrange order']);
  });

  it('every row has Move up / Move down buttons named with the row, at least 44px tall, and nothing is saved until Save [kills: a drag-only list]', () => {
    expect(list).toContain('aria-label={`Move ${r.label} up`}');
    expect(list).toContain('aria-label={`Move ${r.label} down`}');
    expect(list).toMatch(/const BTN = '[^']*min-h-11 min-w-11/);
    expect(list).toMatch(/>\s*Save\s*<\/SubmitButton>/);
    expect(list).toContain('name="ids"');
  });

  it('each list posts to its own domain function through a thin action, and redirects outside the try [kills: an action that skips the domain gate]', () => {
    for (const fn of ['reorderMenuCategories', 'reorderMenuItems', 'reorderMenuVariants', 'reorderMenuOptionValues']) expect(actions).toContain(`${fn}(actor,`);
    expect(actions.match(/redirectWithFlash\(PATH, nav, \{ ok:/g)).toHaveLength(4);
  });

  it('the category and item forms no longer carry a bare Sort order box; they link to Arrange order instead [kills: the number box coming back]', () => {
    expect(Object.keys(MENU_CATEGORY_RULES)).not.toContain('sortOrder');
    expect(Object.keys(MENU_ITEM_EDIT_RULES)).not.toContain('sortOrder');
    for (const f of ['page.tsx', 'items/[id]/page.tsx']) {
      expect(code(read(f)), f).not.toMatch(/Sort order/);
      expect(code(read(f)), f).toContain('Arrange order');
    }
  });
});
