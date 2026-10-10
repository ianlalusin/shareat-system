import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlashBanner } from '../src/components/ui/FlashBanner';

/**
 * T-387 S4 (TESTER) - field errors in the three pilot forms. Spec: S4 "Field errors". Other forms follow in S8.
 *
 * API pinned:
 *   FlashBanner({ flash: { error?, warning?, notice?, field? }, fieldLabels?: Record<string, string> })
 *     - on the ERROR banner only, when `flash.field` is set AND `fieldLabels[flash.field]` exists, renders the Banner's
 *       "Go to <label>" anchor to `#<field>`. No label -> no link (never a dangling "Go to undefined").
 *   Pilot field ids (kebab, they must satisfy ^[a-z0-9-]{1,40}$, so the camelCase input NAMES cannot be the ids):
 *     /cash-requests (list page carries the new form):  store, requested-for
 *     /sales-days/new:                                  store
 *     /expenses/new:                                    store
 *   The control keeps its `name` (the action reads it unchanged); only `id` is added.
 *
 * Page assertions are SOURCE PINS: the pages need a session and a database to render.
 */

const APP = resolve(__dirname, '../src/app');
const read = (p: string) => readFileSync(resolve(APP, p), 'utf8');

function body(file: string, fn: string): string {
  const src = read(file);
  const start = src.search(new RegExp(`export async function ${fn}\\b`));
  if (start < 0) throw new Error(`${file}: no ${fn}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport (async )?(function|const)\b/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

const render = (props: object) => renderToStaticMarkup(createElement(FlashBanner as never, props as never));

describe('FlashBanner links an error to its field', () => {
  it('error + field + label -> a "Go to <label>" anchor to #<field>', () => {
    const html = render({ flash: { error: 'Choose a store.', field: 'store' }, fieldLabels: { store: 'Store' } });
    expect(html).toContain('Choose a store.');
    expect(html).toContain('href="#store"');
    expect(html).toContain('Go to Store');
  });

  it('no label for that field -> the message shows, no link', () => {
    const html = render({ flash: { error: 'Choose a store.', field: 'store' }, fieldLabels: {} });
    expect(html).toContain('Choose a store.');
    expect(html).not.toContain('href="#store"');
    expect(html).not.toContain('Go to');
  });

  it('no field -> no link, exactly as before S4', () => {
    const html = render({ flash: { error: 'Something failed.' }, fieldLabels: { store: 'Store' } });
    expect(html).toContain('Something failed.');
    expect(html).not.toContain('Go to');
  });

  it('a warning or notice never links, even when a field is present', () => {
    const html = render({ flash: { warning: 'Careful.', notice: 'FYI.', field: 'store' }, fieldLabels: { store: 'Store' } });
    expect(html).toContain('Careful.');
    expect(html).toContain('FYI.');
    expect(html).not.toContain('Go to');
  });

  it('ok is still not rendered by the banner (the Toaster shows it)', () => {
    expect(render({ flash: { ok: 'Saved.' } })).not.toContain('Saved.');
  });
});

describe('pilot: /cash-requests', () => {
  it('createRequestAction names the field of each refusal that names one', () => {
    const b = body('cash-requests/actions.ts', 'createRequestAction');
    expect(b).toMatch(/Choose a store\.[\s\S]*field:\s*'store'|field:\s*'store'[\s\S]*Choose a store\./);
    expect(b).toMatch(/field:\s*'requested-for'/);
  });

  it('the page gives the controls those ids, marks the flagged one invalid, and shows the error through FlashBanner with labels', () => {
    const p = read('cash-requests/page.tsx');
    expect(p).toMatch(/id="store"/);
    expect(p).toMatch(/id="requested-for"/);
    expect(p).toMatch(/name="storeId"/); // the action still reads the same names
    expect(p).toMatch(/name="requestedFor"/);
    expect(p).toMatch(/invalid=\{[^}]*\.field\s*===\s*'store'[^}]*\}|invalid=\{[^}]*store[^}]*\}/);
    expect(p).toMatch(/invalid=\{[^}]*requested-for[^}]*\}/);
    expect(p).toMatch(/<FlashBanner\b[^>]*fieldLabels=/);
  });
});

describe('pilot: /sales-days/new', () => {
  it('createSalesDayAction sends the field of its store refusal', () => {
    const b = body('sales-days/actions.ts', 'createSalesDayAction');
    expect(b).toMatch(/field:\s*'store'/);
  });

  it('the page id, invalid and labelled banner', () => {
    const p = read('sales-days/new/page.tsx');
    expect(p).toMatch(/id="store"/);
    expect(p).toMatch(/invalid=\{[^}]*store[^}]*\}/);
    expect(p).toMatch(/<FlashBanner\b[^>]*fieldLabels=/);
  });
});

describe('pilot: /expenses/new', () => {
  it('the create action sends the field of its store refusal', () => {
    const src = read('expenses/actions.ts');
    expect(src).toMatch(/field:\s*'store'/);
  });

  it('createExpenseAction passes the field through its redirect on a parse refusal', () => {
    const b = body('expenses/actions.ts', 'createExpenseAction');
    // the catch around parseExpenseForm builds its flash from the refusal, not just { error }
    expect(b).toMatch(/field/);
  });

  it('the page id, invalid and labelled banner', () => {
    const p = read('expenses/new/page.tsx');
    expect(p).toMatch(/id="store"/);
    expect(p).toMatch(/invalid=\{[^}]*store[^}]*\}/);
    expect(p).toMatch(/<FlashBanner\b[^>]*fieldLabels=/);
  });
});

describe('S4 field ids are legal flash fields', () => {
  it.each(['store', 'requested-for'])('%s matches ^[a-z0-9-]{1,40}$', (id) => {
    expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});
