import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-418 case 10 (TESTER) - a draft delete is ONE click (Ian 16 Oct, answer 2): on each of the three pages the delete control is a
 * plain submit button inside its form, with no onClick, no browser confirm(), no ConfirmDestructive, no dialog and no
 * "Are you sure" / "Click again" text; the page file holds no confirm( at all.
 * docs/tasks/418-draft-delete-without-pin.md. Source-level (a page needs a database to render), like the census.
 *
 * RED TODAY: all three pages render <ConfirmDestructive tier="admin-pin"> in that form (its component reveals a panel with a
 * PIN box, i.e. a second step), and hold no plain danger <Button> with the label.
 *
 * MUTANTS: M1 wrap the button in ConfirmDestructive again -> red. M2 add onClick={() => confirm('Sure?')} -> red.
 * M3 add a "Click again to delete" state/text -> red. M4 make the button type="button" (never submits) -> red.
 */
const SRC = join(__dirname, '..', 'src');
const BS = String.fromCharCode(92);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const pages = [
  { file: 'app/expenses/[id]/page.tsx', action: 'deleteDraftAction', label: 'Delete draft' },
  { file: 'app/inventory/usage/[id]/page.tsx', action: 'deleteUsageDraftAction', label: 'Delete usage draft' },
  { file: 'app/expenses/recurring/page.tsx', action: 'deleteTemplateAction', label: 'Delete template' },
];

function formOf(src: string, action: string): string | undefined {
  const at = src.search(new RegExp('action=' + BS + '{' + action + BS + '}'));
  if (at < 0) return undefined;
  const start = src.lastIndexOf('<form', at);
  const end = src.indexOf('</form>', at);
  return start < 0 || end < 0 ? undefined : src.slice(start, end);
}

describe.each(pages)('T-418 case 10: $file - $label is one click', ({ file, action, label }) => {
  const raw = readFileSync(join(SRC, file), 'utf8');
  const src = stripComments(raw);
  const form = formOf(src, action);

  it(`the <form action={${action}}> exists`, () => {
    expect(form, `a form submitting to ${action}`).toBeDefined();
  });

  it('its delete control is a plain submit <Button variant="danger"> carrying the label', () => {
    const buttons = [...(form ?? '').matchAll(/<Button\b[^>]*>[\s\S]*?<\/Button>/g)].map((m) => m[0]);
    const mine = buttons.find((b) => b.includes(label));
    expect(mine, `a <Button> labelled "${label}" inside the form`).toBeDefined();
    expect(mine!, 'danger variant').toMatch(/variant="danger"/);
    expect(mine!, 'it submits (no type="button")').not.toMatch(/type="button"/);
    expect(mine!, 'no onClick on it').not.toMatch(/onClick/);
  });

  it('no ConfirmDestructive, no dialog, no second-step text in the form or its button', () => {
    expect(form ?? '').not.toContain('ConfirmDestructive');
    expect(form ?? '').not.toMatch(/role="(?:alert)?dialog"|<dialog\b|<details\b/);
    expect(form ?? '').not.toMatch(/onClick|onSubmit/);
    expect(form ?? '').not.toMatch(/Are you sure|Click again|Tap again|Press again/i);
    expect(form ?? '', 'no PIN box in the form').not.toMatch(/adminPin|name="confirmName"/);
  });

  it('the whole page file holds no confirm( and no "Are you sure"', () => {
    expect(src).not.toMatch(/(?<![A-Za-z.])confirm\(/);
    expect(src).not.toMatch(/window\.confirm/);
    expect(src).not.toMatch(/Are you sure/i);
  });
});
