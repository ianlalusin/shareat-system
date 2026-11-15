/**
 * T-589 B2 - EditableRecord shows what is saved while the record is locked, and its Edit button says "Edit".
 * Spec: docs/tasks/589-app-ui-fixes.md section B2.
 *
 * Named mutant: if the summary stayed visible while editing, or an empty value did not read "Not set", the
 * matching test below fails; if the pencil lost its word, the Edit-word test fails.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditableRecordView } from '../src/components/forms/EditableRecord';

const base = {
  action: async () => {},
  label: 'Gcash',
  hidden: { id: 't-1' },
  typed: null,
  children: createElement('input', { name: 'name', defaultValue: 'Gcash' }),
};
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(EditableRecordView as never, { ...base, ...props } as never));

const SUMMARY = [
  { label: 'Name', value: 'Gcash' },
  { label: 'Sort order', value: '' },
  { label: 'Notes', value: null },
];

describe('EditableRecord summary (T-589 B2)', () => {
  it('shows the saved values in a <dl> while locked', () => {
    const html = render({ mode: 'locked', summary: SUMMARY });
    expect(html).toContain('<dl');
    expect(html).toMatch(/<dt[^>]*>Name<\/dt><dd[^>]*>Gcash<\/dd>/);
  });
  it('hides the summary while editing (MUTANT: summary left on in edit mode)', () => {
    const html = render({ mode: 'editing', summary: SUMMARY });
    expect(html).not.toContain('<dl');
    expect(html).not.toContain('Not set');
  });
  it('an empty or missing value reads "Not set" in muted italic (MUTANT: blank cell)', () => {
    const html = render({ mode: 'locked', summary: SUMMARY });
    expect(html.match(/<dd class="text-muted italic">Not set<\/dd>/g)).toHaveLength(2);
  });
  it('a record with no summary renders no list and the same markup as an empty one', () => {
    const none = render({ mode: 'locked' });
    expect(none).not.toContain('<dl');
    expect(render({ mode: 'locked', summary: [] })).toBe(none);
  });
  it('the Edit button shows the word Edit beside its pencil, accessible name unchanged (MUTANT: icon only)', () => {
    const html = render({ mode: 'locked' });
    expect(html).toContain('aria-label="Edit Gcash"');
    expect(html).toContain('<span aria-hidden="true">Edit</span>');
  });
  it('a plain-text value is escaped, not injected', () => {
    const html = render({ mode: 'locked', summary: [{ label: 'Name', value: '<b>x</b>' }] });
    expect(html).not.toContain('<b>x</b>');
  });
});
