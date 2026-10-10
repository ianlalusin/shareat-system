/**
 * T-387 S3 — Table, Th, Td, NumTd (components/ui/Table.tsx; one file, four named exports).
 *
 * Pinned: Table = `<div class="overflow-x-auto ..."><table class="w-full ...">children</table></div>`;
 * Th = `<th scope="col" class="bg-canvas text-left ...">` (the header row is bg-canvas; `numeric` flips it to
 * text-right); Td = a plain cell (no tabular-nums, no text-right); NumTd = `tabular-nums text-right`.
 * A caller className is appended on every part.
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NumTd, Table, Td, Th } from '../src/components/ui/Table';

const cls = (html: string, tag: string): string[] =>
  ((new RegExp(`<${tag}\\b[^>]*?class="([^"]*)"`).exec(html)?.[1]) ?? '').split(/\s+/).filter(Boolean);
const R = (el: unknown) => renderToStaticMarkup(el as never);

const full = R(
  h(Table as never, null,
    h('thead', null, h('tr', null, h(Th as never, null, 'Item'), h(Th as never, { numeric: true }, 'Qty'))),
    h('tbody', null, h('tr', null, h(Td as never, null, 'Beef'), h(NumTd as never, null, '1,250.00'))),
  ),
);

describe('Table', () => {
  it('scrolls in an overflow-x-auto box: the OUTERMOST element is the scroller, the <table> is inside it', () => {
    expect(full).toMatch(/^<div\b/);
    expect(cls(full, 'div')).toContain('overflow-x-auto');
    expect(full.indexOf('<div')).toBeLessThan(full.indexOf('<table'));
    expect(full.trimEnd().endsWith('</div>')).toBe(true);
  });
  it('the table is full width', () => {
    expect(cls(full, 'table')).toContain('w-full');
  });
  it('renders valid table markup (thead/tbody/th/td in order)', () => {
    expect(full).toMatch(/<table[\s\S]*<thead>[\s\S]*<th[\s\S]*<\/thead>[\s\S]*<tbody>[\s\S]*<td[\s\S]*<\/tbody>[\s\S]*<\/table>/);
  });
  it('appends a caller className (to the table, not replacing the wrapper)', () => {
    const html = R(h(Table as never, { className: 'min-w-[640px]' }, h('tbody', null)));
    expect([...cls(html, 'div'), ...cls(html, 'table')]).toContain('min-w-[640px]');
    expect(cls(html, 'div')).toContain('overflow-x-auto');
  });
});

describe('Th', () => {
  it('is a column header with bg-canvas, left aligned by default', () => {
    const t = cls(full, 'th');
    expect(full).toContain('scope="col"');
    expect(t).toContain('bg-canvas');
    expect(t).toContain('text-left');
    expect(t).not.toContain('text-right');
  });
  it('numeric flips to text-right and keeps bg-canvas', () => {
    const html = R(h('table', null, h('thead', null, h('tr', null, h(Th as never, { numeric: true }, 'Qty')))));
    expect(cls(html, 'th')).toEqual(expect.arrayContaining(['text-right', 'bg-canvas']));
    expect(cls(html, 'th')).not.toContain('text-left');
  });
  it('NEGATIVE: no stock hue or raw hex in the header cell', () => {
    expect(full).not.toMatch(/\b(?:gray|slate|zinc|neutral|stone)-\d{2,3}\b/);
    expect(full).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('Td and NumTd', () => {
  const td = (el: unknown) => R(h('table', null, h('tbody', null, h('tr', null, el as never))));
  it('NumTd is tabular-nums and right aligned', () => {
    const c = cls(td(h(NumTd as never, null, '9')), 'td');
    expect(c).toEqual(expect.arrayContaining(['tabular-nums', 'text-right']));
  });
  it('NEGATIVE: a plain Td is neither tabular-nums nor right aligned (the numeric column is a choice)', () => {
    const c = cls(td(h(Td as never, null, 'x')), 'td');
    expect(c).not.toContain('tabular-nums');
    expect(c).not.toContain('text-right');
  });
  it('appends a caller className on Td and NumTd, keeping the NumTd tokens', () => {
    expect(cls(td(h(Td as never, { className: 'w-24' }, 'x')), 'td')).toContain('w-24');
    const n = cls(td(h(NumTd as never, { className: 'w-24' }, '1')), 'td');
    expect(n).toEqual(expect.arrayContaining(['w-24', 'tabular-nums', 'text-right']));
  });
  it('passes colSpan through', () => {
    expect(td(h(Td as never, { colSpan: 3 }, 'x'))).toMatch(/colspan="3"/i);
  });
});
