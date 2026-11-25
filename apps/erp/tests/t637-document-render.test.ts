import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocumentBlock, DocumentDoc, DocumentSheet } from '../src/components/documents/DocumentDoc';
import { FONT_STACKS, type DocJson, type DocNode, type DocPage } from '@shareat/domain/documents/doc';

/**
 * T-637 - the renderer and the A4 sheet (docs/tasks/637-document-editor.md tests 2 and 7). Real renders with react-dom/server: what a person reads on screen and on paper.
 */
const ROOT = join(__dirname, '..', '..', '..');
const doc = (...content: DocNode[]): DocJson => ({ type: 'doc', content });
const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const html = (d: DocJson) => renderToStaticMarkup(createElement(DocumentDoc, { doc: d }));
const sheet = (page: DocPage | null, children = 'BODY', extra: { legacyHeader?: string; voided?: boolean } = {}) =>
  renderToStaticMarkup(createElement(DocumentSheet, { page, ...extra, children }));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('T-637 test 2 - the renderer never emits raw HTML', () => {
  it('a text node reading <script> prints the literal characters, escaped, with no tag in the output [kills: an innerHTML or raw-markup renderer]', () => {
    const out = html(doc(p(t('<script>alert(1)</script>')), p(t('<img src=x onerror=alert(1)>', [{ type: 'bold' }]))));
    expect(out).not.toMatch(/<script|<img/);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
  });

  it('a field tag draws its plain label, and an unknown name draws a neutral label, never the typed name as markup [kills: a tag name echoed raw]', () => {
    const out = html(doc(p({ type: 'field', attrs: { name: 'employee.full_name' } }, { type: 'field', attrs: { name: '<b>x</b>' } })));
    expect(out).toContain('Employee full name');
    expect(out).toContain('Unknown field');
    expect(out).not.toContain('<b>x');
  });

  it('only listed style values are ever written: a made-up font, size, colour, alignment, link or node draws no style, no href and no element [kills: a style or link injected through the document]', () => {
    const out = html(
      doc(
        { type: 'paragraph', attrs: { textAlign: 'expression(alert(1))', lineHeight: '9' }, content: [t('plain', [{ type: 'textStyle', attrs: { fontFamily: 'evil, url(x)', fontSize: '1000px', color: 'red' } }, { type: 'link', attrs: { href: 'javascript:alert(1)' } }])] },
        { type: 'iframe' },
        { type: 'image', attrs: { src: 'https://example.com/x.png' } },
      ),
    );
    expect(out).not.toMatch(/style=|href=|<iframe|<img|javascript|evil|1000px|red/);
    expect(out).toContain('plain');
  });

  it('a listed font, size, alignment and line spacing are drawn; the heading level sets the element; a list, table and rule are real elements [kills: formatting that does not reach the page]', () => {
    const out = html(
      doc(
        { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [t('H')] },
        { type: 'paragraph', attrs: { textAlign: 'right', lineHeight: '1.5' }, content: [t('x', [{ type: 'textStyle', attrs: { fontFamily: FONT_STACKS[2], fontSize: '14pt' } }, { type: 'italic' }, { type: 'underline' }])] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }] },
        { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('three'))] }] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('A'))] }, { type: 'tableCell', content: [p(t('B'))] }] }] },
        { type: 'horizontalRule' },
      ),
    );
    expect(out).toMatch(/<h1 style="[^"]*font-size:20pt/);
    expect(out).toContain('text-align:center');
    expect(out).toContain('text-align:right');
    expect(out).toContain('line-height:1.5');
    expect(out).toContain('font-size:14pt');
    expect(out).toContain('font-family:&quot;Courier New&quot;');
    expect(out).toContain('<u><em><span');
    expect(out).toMatch(/<ul><li><p>one<\/p><\/li><\/ul>/);
    expect(out).toContain('<ol start="3">');
    expect(out).toMatch(/<table class="doc-table"><tbody><tr><th><p>A<\/p><\/th><td><p>B<\/p><\/td><\/tr><\/tbody><\/table>/);
    expect(out).toContain('<hr/>');
  });

  it('no file that draws a document uses dangerouslySetInnerHTML or sets innerHTML [kills: an XSS door in a screen that prints other people\'s words]', () => {
    const dirs = [join(ROOT, 'apps/erp/src/components/documents'), join(ROOT, 'apps/erp/src/app/documents')];
    for (const d of dirs) {
      for (const f of walk(d).filter((x) => /\.(tsx?|ts)$/.test(x))) {
        expect(readFileSync(f, 'utf8'), relative(ROOT, f)).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write/);
      }
    }
  });
});

describe('T-637 test 7 - the print view: A4, margins, header and footer, page breaks', () => {
  const page = (margins: DocPage['margins'], withSides = true): DocPage => ({
    margins,
    headerDoc: withSides ? doc(p(t('HEADER TEXT'))) : null,
    footerDoc: withSides ? doc(p(t('FOOTER TEXT'))) : null,
  });

  it('the @page rule is A4 with the chosen margin: narrow 12 mm, normal 20 mm, wide 30 mm [kills: a print that ignores the page settings]', () => {
    expect(sheet(page('narrow'))).toContain('@page { size: A4; margin: 12mm; }');
    expect(sheet(page('normal'))).toContain('@page { size: A4; margin: 20mm; }');
    expect(sheet(page('wide'))).toContain('@page { size: A4; margin: 30mm; }');
    expect(sheet(page('wide'))).toContain('padding: 30mm');
    expect(sheet(null)).toContain('@page { size: A4; margin: 20mm; }'); // a version from before T-637: normal
  });

  it('the header sits in the table header group and the footer in the footer group (they repeat on every sheet), the body between [kills: a header printed once or not at all]', () => {
    const out = sheet(page('normal'), 'BODY TEXT');
    expect(out).toMatch(/<thead><tr><td><div class="doc-header">.*HEADER TEXT.*<\/div><\/td><\/tr><\/thead><tbody><tr><td>BODY TEXT<\/td><\/tr><\/tbody><tfoot><tr><td><div class="doc-footer">.*FOOTER TEXT.*<\/div><\/td><\/tr><\/tfoot>/);
    expect(out).toContain('display: table-header-group');
    expect(out).toContain('display: table-footer-group');
  });

  it('no header or footer draws empty cells; a version from before T-637 draws its built-in company block instead [kills: a missing legacy letterhead]', () => {
    const plain = sheet(page('normal', false));
    expect(plain).not.toContain('doc-header');
    expect(plain).not.toContain('doc-footer');
    const legacy = sheet(null, 'BODY', { legacyHeader: 'LEGACY COMPANY BLOCK' });
    expect(legacy).toContain('<thead><tr><td>LEGACY COMPANY BLOCK</td></tr></thead>');
  });

  it('a page-break node becomes a CSS page break in print and a dashed marker on screen [kills: page breaks ignored]', () => {
    const out = sheet(page('normal'), '') + html(doc(p(t('one')), { type: 'pageBreak' }, p(t('two'))));
    expect(out).toContain('<div class="doc-page-break" aria-label="Page break"></div>');
    expect(out).toContain('break-after: page');
    expect(out).toContain('border-top: 2px dashed');
  });

  it('only the sheet prints: everything else on the screen is hidden in print, and only when a sheet exists [kills: app chrome on paper, or a blank print of any other page]', () => {
    const out = sheet(page('normal'));
    expect(out).toContain('body:has(.doc-print-root) *:not(:has(.doc-print-root)):not(.doc-print-root):not(.doc-print-root *) { display: none !important; }');
    expect(out).toContain('class="doc-print-root');
    const block = renderToStaticMarkup(createElement(DocumentBlock, { doc: doc(p(t('x'))) }));
    expect(block).not.toContain('@page');
    expect(block).not.toContain('doc-print-root');
  });

  it('a void document draws VOID across the sheet [kills: a void document that looks live]', () => {
    expect(sheet(page('normal'), 'BODY', { voided: true })).toContain('VOID');
    expect(sheet(page('normal'), 'BODY')).not.toContain('VOID');
  });
});
