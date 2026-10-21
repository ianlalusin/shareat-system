import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
function tableInventory() {
  const inventory: { file: string; tables: number; sharedTables: number; headerless: number }[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!path.endsWith('.tsx')) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let tables = 0, sharedTables = 0, headerless = 0;
      function visit(node: ts.Node) {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'table') {
          tables++;
          const text = node.getText(source);
          if (!text.includes('<thead') && !node.openingElement.getText(source).includes('data-card-columns=')) headerless++;
        }
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'Table') {
          sharedTables++;
          if (!node.getText(source).includes('<thead')) headerless++;
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      if (tables || sharedTables) inventory.push({ file: relative(repo, path).replaceAll('\\', '/'), tables, sharedTables, headerless });
    }
  }
  walk(join(repo, 'apps/erp/src')); return inventory.sort((a, b) => a.file.localeCompare(b.file));
}

describe('T-450 entire ERP table rollout', () => {
  it('mounts the adapter once around the authenticated app content', () => {
    const shell = read('apps/erp/src/components/shell/AppShell.tsx');
    expect(shell).toContain('<PhoneTableCards>{children}</PhoneTableCards>');
    const adapter = read('apps/erp/src/components/ui/PhoneTableCards.tsx');
    expect(adapter).toContain('observePhoneTables(root.current)');
    expect(adapter).toContain('data-phone-table-root');
  });
  it('keeps card layout screen-only below 768px, retaining tablet and print tables', () => {
    const css = postcss.parse(read('apps/erp/src/app/globals.css'));
    const cardDisplays: string[] = [];
    css.walkRules(rule => {
      if (!rule.selector.includes('[data-phone-cards]')) return;
      const parent = rule.parent;
      expect(parent?.type).toBe('atrule');
      if (parent?.type !== 'atrule') return;
      expect(parent.name).toBe('media');
      expect(parent.params).toBe('screen and (max-width: 767.98px)');
      rule.walkDecls('display', declaration => { cardDisplays.push(declaration.value); });
    });
    expect(cardDisplays).toContain('block');
    expect(read('apps/erp/src/app/globals.css')).toContain('content: attr(data-card-label) / ""');
  });
  it('uses the same phone/tablet boundary in both existing separate card layouts', () => {
    for (const file of ['apps/erp/src/app/admin/access-defaults/grid.tsx', 'apps/erp/src/app/liabilities/unpaid/page.tsx']) {
      const source = read(file);
      expect(source, file).toContain('md:hidden'); expect(source, file).toContain('md:block');
      expect(source, file).not.toContain('sm:hidden'); expect(source, file).not.toContain('sm:block');
    }
  });
  it('accounts for every native definition and labels each headerless data table', () => {
    const actual = tableInventory();
    const saved = JSON.parse(read('docs/reviews/t450-table-inventory.json')) as typeof actual;
    expect(actual).toEqual(saved);
    const unlabelled = actual.filter(row => row.headerless > 0);
    // The generic Table forwards the caller's headers; it does not own column labels.
    expect(unlabelled.map(row => row.file)).toEqual(['apps/erp/src/components/ui/Table.tsx']);
    expect(actual.reduce((count, row) => count + row.tables, 0)).toBeGreaterThan(100);
  });
});
