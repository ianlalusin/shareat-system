import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FieldSuggestList } from '../src/components/documents/FieldSuggestList';
import { FIELD_DEFS, suggestFields } from '@shareat/domain/documents/doc';

/**
 * T-637 test 6 - what typing `{{` offers. The list component draws what the editor hands it; the editor hands it `suggestFields(query)`. Both halves are checked: the drawn list for no
 * query, for a prefix and for nothing matching, and (as source, because a real editor needs a browser) that the editor really wires `{{` to that filter and to the field node.
 */
const draw = (query: string, selected = 0) => renderToStaticMarkup(createElement(FieldSuggestList, { items: suggestFields(query), selected, onPick: () => undefined }));
const options = (html: string): string[] => [...html.matchAll(/<li role="option"[\s\S]*?<\/li>/g)].map((m) => m[0]);

describe('T-637 test 6 - the {{ suggestion list', () => {
  it('with nothing typed after {{ it lists EVERY field, each with its label, its tag name and a sample value [kills: a list that leaves fields out]', () => {
    const items = options(draw(''));
    expect(items).toHaveLength(FIELD_DEFS.length);
    for (const f of FIELD_DEFS) {
      const li = items.find((x) => x.includes(`{{${f.name}}}`));
      expect(li, f.name).toBeDefined();
      const esc = (t: string) => t.replace(/'/g, '&#x27;');
      expect(li).toContain(esc(f.label));
      expect(li).toContain(esc(f.sample));
    }
  });

  it('typing a prefix filters the list; the first item is the highlighted one; nothing matching says so [kills: a list that does not filter, a highlight that is lost]', () => {
    const emp = options(draw('employee.f'));
    expect(emp).toHaveLength(2);
    expect(emp[0]).toContain('aria-selected="true"');
    expect(emp[1]).toContain('aria-selected="false"');
    expect(options(draw('store')).every((li) => li.includes('{{store.'))).toBe(true);
    expect(options(draw('zzzz'))).toHaveLength(0);
    expect(draw('zzzz')).toContain('No field starts with that');
    expect(options(draw('', 3))[3]).toContain('aria-selected="true"');
  });

  it('the editor opens the list on {{, filters it with suggestFields, inserts a field node, and lets only the body and the letterhead hold fields [kills: an editor not wired to the list]', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'documents', 'DocumentEditor.tsx'), 'utf8');
    expect(src).toContain("char: '{{'");
    expect(src).toMatch(/items: \(\{ query \}\) => suggestFields\(query\)/);
    expect(src).toMatch(/insertContentAt\(range, \[\{ type: 'field', attrs: \{ name: f\.name \} \}/);
    expect(src).toMatch(/fields\s*\?\s*fieldNode\(/); // `fields={false}` (an issued document) builds no field node and no list
    const wording = readFileSync(join(__dirname, '..', 'src', 'components', 'documents', 'WordingField.tsx'), 'utf8');
    expect(wording).toContain('fields={false}');
    const ext = readFileSync(join(__dirname, '..', 'src', 'components', 'documents', 'editor-extensions.ts'), 'utf8');
    expect(ext).toMatch(/blockquote: false, code: false, codeBlock: false, strike: false, link: false/); // nothing the whitelist would refuse
  });
});
