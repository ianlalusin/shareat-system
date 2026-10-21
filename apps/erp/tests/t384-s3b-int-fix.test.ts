/**
 * Integration fix after the full gate on 922dd60. Tester file.
 *  F1: EditableRecord lives in components/forms (a client component; components/ui must stay server-safe).
 *  F2: FormGrid styles label text with house tokens, no raw hue.
 *  F3: the items/[id] "Name and code" rename section is an EditableRecord with FormGrid/Field, no fixed widths.
 */
import { existsSync } from 'node:fs';
import { readControlSource } from './helpers/control-source';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..', 'src');
const read = (...p: string[]) => readControlSource(resolve(SRC, ...p), 'utf8');

describe('F1: EditableRecord is in components/forms, not components/ui', () => {
  it('the file moved', () => {
    expect(existsSync(resolve(SRC, 'components', 'forms', 'EditableRecord.tsx'))).toBe(true);
    expect(existsSync(resolve(SRC, 'components', 'ui', 'EditableRecord.tsx'))).toBe(false);
  });
  it('components/forms/index.ts exports it; components/ui/index.ts does not', () => {
    expect(read('components', 'forms', 'index.ts')).toMatch(/EditableRecord/);
    expect(read('components', 'ui', 'index.ts')).not.toMatch(/EditableRecord/);
  });
  it('it is still a client component', () => {
    expect(read('components', 'forms', 'EditableRecord.tsx')).toMatch(/^\s*['"]use client['"]/m);
  });
});

describe('F2: FormGrid label colour uses a house token', () => {
  it('no raw neutral hue in FormGrid.tsx', () => {
    expect(read('components', 'ui', 'FormGrid.tsx')).not.toMatch(/neutral-\d/);
  });
});

describe('F3: items/[id] rename section is built on EditableRecord + FormGrid', () => {
  const page = () => read('app', 'items', '[id]', 'page.tsx');
  it('imports EditableRecord from components/forms and FormGrid/Field from components/ui', () => {
    expect(page()).toMatch(/from ['"]@\/components\/forms(\/EditableRecord)?['"]/);
    expect(page()).toMatch(/FormGrid/);
    expect(page()).toMatch(/<EditableRecord[\s\S]*renameItemAction/);
  });
  it('the rename form is gone as a raw form; no fixed widths on the page', () => {
    expect(page()).not.toMatch(/<form action=\{renameItemAction\}/);
    expect(page()).not.toMatch(/\bw-(64|40)\b/);
    expect(page()).not.toMatch(/>Rename</);
  });
  it('name and code fields sit inside a FormGrid', () => {
    expect(page()).toMatch(/<FormGrid[\s\S]*name="name"[\s\S]*name="code"[\s\S]*<\/FormGrid>/);
  });
  it('editing state: Save submit and Cancel, name/code editable (EditableRecordView at the new path)', async () => {
    const { EditableRecordView } = await import('../src/components/forms/EditableRecord');
    const html = renderToStaticMarkup(
      createElement(EditableRecordView as never, {
        mode: 'editing', action: async () => {}, label: 'Coke', hidden: { itemId: 'i1' }, saveLabel: 'Save',
        children: createElement('input', { name: 'name', defaultValue: 'Coke' }),
      } as never),
    );
    expect(html).not.toContain('<fieldset disabled');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
  });
});
