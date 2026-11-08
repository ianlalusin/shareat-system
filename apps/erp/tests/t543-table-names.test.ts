/**
 * T-543 — give ERP tables a name a screen reader can announce.
 *
 * An unnamed `<table>` is announced as just "table". `Table` (the shared component) gained an
 * optional `label` prop in this task, and 19 hand-written `<table>` elements got an `aria-label`
 * directly. This guard pins both halves:
 *
 * 1. `Table label="…"` really renders `aria-label="…"` on the `<table>`, and **without** `label`
 *    the attribute is absent (so every existing `Table` call site is byte-identical);
 * 2. every real `<table>` tag in each converted page carries an `aria-label`, and the first one's
 *    label is a short plain-English name (≤ 4 words, no task/defect codes).
 *
 * Comments are stripped before looking for the tag: `admin/access-defaults/grid.tsx` explains the
 * table split in a `//` comment that contains the literal text `` `<table>` ``, and a raw
 * `indexOf('<table')` would read that as the tag.
 *
 * ⚠️ `apps/erp/src/app/ap/page.tsx` is one of the work order's 20 and is deliberately **not** in
 * the list below: it has no hand-written `<table>` any more — it renders the shared `<Table>` with
 * `<caption className="sr-only">Supplier invoices</caption>`, which already gives it an accessible
 * name. Adding `aria-label` over the caption would replace one name with another for no gain.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Table } from '../src/components/ui/Table';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', 'src', 'app');

/** The pages whose first `<table>` T-543 named, with the label each now carries. */
const NAMED: ReadonlyArray<{ readonly file: string; readonly label: string }> = [
  { file: 'page.tsx', label: 'POS usage drafts' },
  { file: 'admin/access-defaults/grid.tsx', label: 'Position access defaults' },
  { file: 'admin/prerequisite-refusals/page.tsx', label: 'Prerequisite walls' },
  { file: 'admin/stores/page.tsx', label: 'Stores' },
  { file: 'admin/users/page.tsx', label: 'Users and roles' },
  { file: 'ap/invoices/[id]/page.tsx', label: 'Invoice lines' },
  { file: 'ap/suppliers/page.tsx', label: 'Suppliers' },
  { file: 'ap/suppliers/[id]/page.tsx', label: 'Open items' },
  { file: 'ap/vat/page.tsx', label: 'VAT summary' },
  { file: 'attendance/page.tsx', label: 'Attendance days' },
  { file: 'attendance/lane/page.tsx', label: 'Recently resolved' },
  { file: 'attendance/terminals/page.tsx', label: 'Terminals' },
  { file: 'channel-settlements/page.tsx', label: 'Days to settle' },
  { file: 'cash-requests/page.tsx', label: 'Cash requests' },
  { file: 'customers/page.tsx', label: 'Customers' },
  { file: 'customers/[customerId]/page.tsx', label: 'Charges' },
  { file: 'commissary/catalogue/page.tsx', label: 'Linked branches' },
  { file: 'wastage/page.tsx', label: 'Open wastage' },
  { file: 'commissary/orders/page.tsx', label: 'Branch orders' },
];

/** `//` and block comments out, newlines kept so a line number stays true. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ''));
}

function firstTableTag(rel: string): string {
  const src = stripComments(readFileSync(resolve(appRoot, rel), 'utf8'));
  const m = /<table\b[^>]*>/.exec(src);
  return m ? m[0] : '';
}

/** Every `<table …>` opening tag in the file, not just the first (Codex F1). */
function allTableTags(rel: string): string[] {
  const src = stripComments(readFileSync(resolve(appRoot, rel), 'utf8'));
  return src.match(/<table\b[^>]*>/g) ?? [];
}

function ariaLabelOf(tag: string): string | undefined {
  return /\baria-label="([^"]*)"/.exec(tag)?.[1];
}

describe('T-543 — the Table component names itself', () => {
  it('renders aria-label when given a label, and none when it is not', () => {
    const withLabel = renderToStaticMarkup(
      h(Table as never, { label: 'Suppliers' }, h('tbody', null, h('tr', null, h('td', null, 'x')))),
    );
    const tableTag = /<table\b[^>]*>/.exec(withLabel)?.[0] ?? '';
    expect(tableTag).toContain('aria-label="Suppliers"');

    const withoutLabel = renderToStaticMarkup(h(Table as never, null, h('tbody', null)));
    expect(withoutLabel).not.toContain('aria-label');
  });
});

describe('T-543 — the named tables carry their name', () => {
  it('every <table> in every converted page has an aria-label', () => {
    const problems: string[] = [];
    for (const { file } of NAMED) {
      const tags = allTableTags(file);
      if (tags.length === 0) problems.push(`${file}: no <table ...> tag found`);
      tags.forEach((tag, i) => {
        if (!/\baria-label=/.test(tag)) problems.push(`${file}: <table> #${i + 1} has no aria-label`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('every label is short, plain English with no task or defect code', () => {
    const problems: string[] = [];
    for (const { file, label } of NAMED) {
      const words = label.trim().split(/\s+/);
      if (words.length > 4) problems.push(`${file}: "${label}" is ${words.length} words (max 4)`);
      if (!/^[A-Za-z0-9][A-Za-z0-9 /&'-]*$/.test(label)) problems.push(`${file}: "${label}" is not plain English`);
      if (/\b(?:T|DEF)-\d/.test(label)) problems.push(`${file}: "${label}" carries a code`);
      const actual = ariaLabelOf(firstTableTag(file));
      if (actual !== label) problems.push(`${file}: expected aria-label="${label}", found ${actual === undefined ? 'none' : `"${actual}"`}`);
    }
    expect(problems).toEqual([]);
  });
});
