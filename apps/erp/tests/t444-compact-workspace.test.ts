import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SplitWorkspace } from '../src/components/ui/SplitWorkspace';

describe('T-444 form and details workspace', () => {
  it('keeps both named regions reachable and preserves form-before-details reading order', () => {
    const html = renderToStaticMarkup(h(SplitWorkspace, {
      form: h('form', null, h('label', null, 'Item name', h('input', { name: 'name' }))),
      details: h('section', null, 'Catalogue and prices'),
      formTitle: 'Item entry', detailsTitle: 'Item catalogue',
    }));
    expect(html).toContain('aria-label="Item entry"');
    expect(html).toContain('aria-label="Item catalogue"');
    expect(html.indexOf('Item name')).toBeLessThan(html.indexOf('Catalogue and prices'));
    expect((html.match(/<form/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/aria-hidden|hidden=/);
  });
  it('has usable default region names for callers without custom labels', () => {
    const html = renderToStaticMarkup(h(SplitWorkspace, { form: 'Form content', details: 'Details content' }));
    expect(html).toContain('aria-label="Form"');
    expect(html).toContain('aria-label="Details"');
  });
});
