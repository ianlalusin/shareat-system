// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

describe('T461 action-only forms', () => {
  it('hides locked record fields but retains their values and Edit action', async () => {
    const { EditableRecordView } = await import('../src/components/forms/EditableRecord');
    const html = renderToStaticMarkup(h(EditableRecordView, { mode: 'locked', action: async () => {}, label: 'name', hidden: { id: 'one' }, typed: null,
      children: h('input', { name: 'lastName', defaultValue: 'Lalusin' }) }));
    expect(html).toMatch(/<fieldset[^>]*hidden=""/);
    expect(html).toContain('value="Lalusin"');
    expect(html).toContain('Edit name');
  });
  it('shows fields and Save/Cancel only when the record was called', async () => {
    const { EditableRecordView } = await import('../src/components/forms/EditableRecord');
    const html = renderToStaticMarkup(h(EditableRecordView, { mode: 'editing', action: async () => {}, label: 'name', hidden: {}, typed: null, children: h('input', { name: 'lastName' }) }));
    expect(html).not.toMatch(/<fieldset[^>]*hidden/);
    expect(html).toContain('Cancel');
    expect(html).toContain('Save');
  });
  it('starts mutation entry fields in a closed native disclosure with their existing action label', async () => {
    const { ActionForm } = await import('../src/components/forms/ActionForm');
    const html = renderToStaticMarkup(h(ActionForm, { action: async () => {}, children: [h('input', { key: 'i', name: 'amount' }), h('button', { key: 'b', type: 'submit' }, 'Record settlement')] }));
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toMatch(/<summary[^>]*>.*Record settlement/);
    expect(html.match(/<form\b/g)).toHaveLength(1);
  });
  it('does not add a second reveal inside an existing disclosure', async () => {
    const { ActionForm } = await import('../src/components/forms/ActionForm');
    const { FormCalled } = await import('../src/components/forms/FormDisclosure');
    const html = renderToStaticMarkup(h(FormCalled, { children: h(ActionForm, { action: async () => {}, children: h('input', { name: 'name' }) }) }));
    expect(html).not.toContain('<details');
    expect(html).toContain('<form');
  });
  it('leaves a command with only hidden identifiers as its original button', async () => {
    const { ActionForm } = await import('../src/components/forms/ActionForm');
    const html = renderToStaticMarkup(h(ActionForm, { action: async () => {}, children: [h('input', { key: 'i', type: 'hidden', name: 'id', value: 'one' }), h('button', { key: 'b', type: 'submit' }, 'Retire')] }));
    expect(html).not.toContain('<details');
    expect(html).toContain('Retire');
  });
  it('uses the existing native disclosure action without a second prompt', async () => {
    const { FormDisclosure } = await import('../src/components/forms/FormDisclosure');
    const html = renderToStaticMarkup(h(FormDisclosure, { called: true, children: h('form', null, h('input', { name: 'amount' })) }));
    expect(html).not.toContain('<details');
    expect(html).toContain('name="amount"');
  });
  it('reopens retained typing after an in-place refusal, storing only the reveal id', async () => {
    const { FormDisclosure } = await import('../src/components/forms/FormDisclosure');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div'); document.body.append(host);
    const account = document.createElement('span'); account.dataset.screenState = 'account-one'; document.body.append(account);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(h(FormDisclosure, { children: h('form', { onSubmit: e => e.preventDefault() }, h('input', { name: 'name', defaultValue: 'Stored' })) })); });
      const details = host.querySelector('details'); const input = host.querySelector('input'); const form = host.querySelector('form');
      expect(details?.open).toBe(false);
      if (!details || !input || !form) throw new Error('Expected a mounted entry form');
      input.value = 'Retained typing';
      await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      const key = `erp-called-form:account-one:${window.location.pathname}`;
      expect(sessionStorage.getItem(key)).toBe(details.id.slice('form-'.length));
      expect(sessionStorage.getItem(key)).not.toContain('Retained');
      await act(async () => { const marker = document.createElement('span'); marker.dataset.formRefusal = 'true'; host.append(marker); await Promise.resolve(); });
      expect(details.open).toBe(true);
      expect(input.value).toBe('Retained typing');
      expect(sessionStorage.getItem(key)).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); account.remove(); sessionStorage.clear(); }
  });
  it('keeps native mutation entry forms behind a shared or existing explicit reveal across ERP', () => {
    const root = join(__dirname, '../src/app');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []);
    const exposed: string[] = [];
    for (const file of files(root)) {
      // Authentication is already explicitly called by opening the sign-in/clock page.
      if (file.includes(`${join('app', 'sign-in')}`) || file === join(root, 'clock/page.tsx')) continue;
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'form') {
          const attrs = node.openingElement.attributes.properties;
          const writes = attrs.some(a => ts.isJsxAttribute(a) && (a.name.getText(source) === 'onSubmit' || (a.name.getText(source) === 'action' && a.initializer && ts.isJsxExpression(a.initializer))));
          let fields = false;
          const scan = (n: ts.Node) => {
            if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
              const tag = n.tagName.getText(source);
              if (['input', 'select', 'textarea', 'Input', 'Select', 'Textarea', 'Checkbox', 'Field'].includes(tag) || /Input$|Fields$/.test(tag)) {
                const hidden = n.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(source) === 'type' && a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === 'hidden');
                fields ||= !hidden;
              }
            }
            ts.forEachChild(n, scan);
          };
          scan(node);
          let called = false;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isJsxElement(parent) && ['FormDisclosure', 'DisclosureCard', 'details', 'FormCalled'].includes(parent.openingElement.tagName.getText(source))) called = true;
          }
          if (writes && fields && !called) exposed.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(exposed).toEqual([]);
  });
});
