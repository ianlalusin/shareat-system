/**
 * T-589 B7 (C): Select never passes its container and is full width on a phone. A native select already sizes to its
 * widest option; `min-width: min(100%, max-content)` is invalid CSS (dropped by the browser), so there is no min-w token.
 * `.ts` + createElement on purpose (the unit project only picks up `*.test.ts`, see filter-row.test.ts).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Select } from '../src/components/ui/Select';
import { Field } from '../src/components/ui/FormGrid';

describe('T-589 B7 Select width', () => {
  const html = renderToStaticMarkup(createElement(Select, { name: 'k', className: 'w-40' }, createElement('option', { value: 'a' }, 'Goes into service')));
  const classes = /class="([^"]*)"/.exec(html)?.[1]?.split(/\s+/) ?? [];

  it('keeps the caller width, never exceeds its container, and is full width on a phone', () => {
    expect(classes).toContain('w-40');
    expect(classes).toContain('max-w-full');
    expect(classes).toContain('max-sm:w-full');
  });

  it('a Field whose control is a select never gets a width cap that would cut it (kind, code, amount names)', () => {
    for (const name of ['kind', 'itemCode', 'feeAmount']) {
      const html = renderToStaticMarkup(createElement(Field, { label: 'L' }, createElement(Select, { name }, createElement('option', { value: 'a' }, 'A long option text'))));
      expect(html, name).not.toMatch(/erp-field-(code|short|date)/);
    }
    // an Input with the same name keeps its code width (the rule still works for text controls)
    expect(renderToStaticMarkup(createElement(Field, { label: 'L' }, createElement('input', { name: 'kind' })))).toContain('erp-field-code');
  });
});
