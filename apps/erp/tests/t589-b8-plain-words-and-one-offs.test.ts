/**
 * T-589 B8 - plain words and the one-off screen fixes. Each test names the MUTANT it kills: undo that one change and it goes red.
 * Source-level promises are read from the files (the pages are async server components needing a session).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETTINGS_ORG_TOLERANCE_RULES } from '@shareat/domain/field-rules';
import { Field } from '../src/components/ui/FormGrid';
import { Input } from '../src/components/ui/Input';
import { Button } from '../src/components/ui/Button';
import { SalesDayForm } from '../src/app/sales-days/SalesDayForm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const src = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('F3 - the fingerprint test form is development only', () => {
  const page = src('app/staff/[employmentId]/credentials/page.tsx');
  const actions = src('app/staff/[employmentId]/credentials/actions.ts');
  // MUTANT: drop the NODE_ENV condition around the section -> the block renders in production.
  it('the screen draws the block only when NODE_ENV is development', () => {
    const guard = page.indexOf("process.env.NODE_ENV === 'development'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(page.indexOf('Enrol a fingerprint (testing only)'));
    expect(guard).toBeGreaterThan(page.indexOf('Enrol card'));
  });
  // MUTANT: drop the guard in the action -> a hand-made POST enrols a fake fingerprint in production.
  it('the server action refuses outside development, before it reads or writes anything', () => {
    const body = actions.slice(actions.indexOf('export async function enrolFingerprintAction'));
    const guard = body.indexOf("process.env.NODE_ENV !== 'development'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('withOrgPrincipal'));
  });
});

describe('G2 - the upload button is a primary button with its words', () => {
  // MUTANT: remove variant="primary" -> the default secondary button is a bare round icon.
  it('UploadForm submits with a primary Button that shows its words', () => {
    expect(src('app/channel-settlements/upload/UploadForm.tsx')).toMatch(/<Button type="submit" variant="primary"/);
    expect(renderToStaticMarkup(createElement(Button, { variant: 'primary', type: 'submit' }, 'Upload the files'))).toContain('Upload the files');
  });
});

describe('G3 - the commissary empty state carries the Link store button', () => {
  // MUTANT: remove the FormModal from the empty branch -> a sentence with no action.
  it('the no-commissary branch renders a Link store modal that posts the link action', () => {
    const page = src('app/commissary/catalogue/page.tsx');
    const empty = page.slice(page.indexOf('if (!commissaryStoreId)'), page.indexOf('const [{ links, offerings'));
    expect(empty).toContain('<FormModal trigger="+ Link store"');
    expect(empty).toContain('action={upsertLinkAction}');
    expect(empty).toContain('name="commissaryStoreId"');
    expect(empty).toContain('<div className="mt-3">'); // MUTANT: drop the wrapper margin -> the button touches the sentence above
  });
});

describe('G4 - the count sheet Cancel count button shows its words', () => {
  // MUTANT: remove icon={null} -> a lone red round X with no visible label.
  it('Cancel count keeps its words', () => {
    expect(src('app/inventory/counts/[id]/page.tsx')).toMatch(/variant="danger" icon=\{null\}>\s*Cancel count/);
    expect(renderToStaticMarkup(createElement(Button, { variant: 'danger', icon: null }, 'Cancel count'))).toContain('>Cancel count<');
  });
});

describe('G6 - /sales-days/new names the store once', () => {
  const props = { businessDate: '2026-01-01', dateEditable: false, channels: [], wallets: [], submitLabel: 'Save draft', draft: { personId: 'p', storeId: 's' } };
  // MUTANT: render the Store block unconditionally -> two Store fields beside the switcher.
  it('SalesDayForm draws the Store field only when given a storeLabel', () => {
    expect(renderToStaticMarkup(createElement(SalesDayForm, { ...props, storeLabel: 'Lipa (LP)' }))).toContain('Lipa (LP)');
    expect(renderToStaticMarkup(createElement(SalesDayForm, props))).not.toMatch(/>Store</);
  });
  it('the New page leaves the label out when the switcher is showing', () => {
    expect(src('app/sales-days/new/page.tsx')).toContain('storeLabel={stores.length > 1 ? undefined');
  });
});

describe('G7 - a wrapped required label keeps its asterisk beside the last word', () => {
  // MUTANT: put the asterisk back as a sibling of the label text -> it becomes its own flex item and floats away.
  it('the label words and the asterisk share one inline wrapper', () => {
    const html = renderToStaticMarkup(
      createElement(Field, { label: 'Allowed difference (type 0.10 for 10%)', rule: SETTINGS_ORG_TOLERANCE_RULES.tolerance }, createElement(Input, { name: 'tolerance' })),
    );
    expect(html).toMatch(/<span>Allowed difference \(type 0\.10 for 10%\)<span[^>]*>\*<\/span><\/span>/);
  });
});

describe('G8 - the sales day form keeps its save in view', () => {
  // MUTANT: remove the sticky wrapper -> Save sits at the bottom of a very long phone form.
  it('the submit button sits in a sticky bottom bar', () => {
    const form = src('app/sales-days/SalesDayForm.tsx');
    expect(form).toMatch(/sticky bottom-0[^"]*">\s*<Button type="submit" variant="primary">\s*\{submitLabel\}/);
  });
});

describe('stock count - a spanning add form is not headed by the joined column names', () => {
  // MUTANT: delete the rule -> every uncounted phone card repeats "Quantity · Cost per unit · Value · Count".
  it('the phone-card CSS hides the label of a multi-column actions cell', () => {
    expect(src('app/globals.css')).toContain('[data-phone-table-root] [data-card-slot="actions"][colspan]::before { content: none; }');
  });
});

describe('expense approve - the unmet reasons are listed once, not repeated under the button', () => {
  // MUTANT: remove pointerSummary from the Approve & post form -> "To save:" repeats every red reason above it.
  it('the Approve & post CheckedForm points at what is marked above', () => {
    const page = src('app/expenses/[id]/page.tsx');
    const form = page.slice(page.indexOf('rules={EXPENSE_APPROVE_RULES}') - 40, page.indexOf('rules={EXPENSE_APPROVE_RULES}') + 200);
    expect(form).toContain('pointerSummary');
  });
});
