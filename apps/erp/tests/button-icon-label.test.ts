/**
 * DEF-754 (T-473): an icon Button keeps its accessible name when a caller passes `aria-label={undefined}`.
 * `.ts` + createElement on purpose: the unit project only picks up `apps/**\/*.test.ts` (see filter-row.test.ts).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/ap',
  useSearchParams: () => new URLSearchParams(),
}));

import { Button } from '../src/components/ui/Button';
import { FormModal } from '../src/components/ui/Dialog';

describe('DEF-754 icon Button accessible name', () => {
  it('aria-label={undefined} does not erase the computed action name', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { 'aria-label': undefined, children: '+ Log invoice' }),
    );
    expect(html).toContain('aria-label="Log invoice"');
  });

  it('an explicit aria-label still wins', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { 'aria-label': 'Add a supplier invoice', children: '+ Log invoice' }),
    );
    expect(html).toContain('aria-label="Add a supplier invoice"');
    expect(html).not.toContain('aria-label="Log invoice"');
  });

  it('FormModal with no triggerLabel renders a named trigger', () => {
    const html = renderToStaticMarkup(
      createElement(FormModal, { trigger: '+ Log invoice', title: 'Log invoice', children: null }),
    );
    expect(html).toContain('aria-label="Log invoice"');
  });
});
