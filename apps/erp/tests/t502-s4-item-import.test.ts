/**
 * T-502 S4 (TESTER, red until built) - the /items/import screen (apps/erp). Domain behaviour is in
 * packages/domain/tests/integration/t502-s4-item-import.test.ts; this file pins the screen's own contract.
 *
 * Assumed files (builder may rename; tell the tester):
 *   apps/erp/src/app/items/import/lib.ts      exports safeCell(text), IMPORT_STATUS_LABELS, MAX_UPLOAD_BYTES
 *   apps/erp/src/app/items/import/page.tsx    server page, admin only
 *   apps/erp/src/app/items/import/actions.ts  'use server' previewImportAction / confirmImportAction
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'src', 'app', 'items', 'import');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const STATUSES = ['new', 'exists', 'alias_clash', 'category_not_found', 'subcategory_not_found', 'subcategory_required', 'invalid', 'duplicate_in_file'];

describe('S4 screen - files exist', () => {
  it('page, actions and lib are there', () => {
    for (const f of ['page.tsx', 'actions.ts', 'lib.ts']) expect(existsSync(join(DIR, f)), f).toBe(true);
  });
});

describe('S4 screen - formula-injection-safe display', () => {
  it('a cell starting with = + - @ (or tab/CR) is shown as text: prefixed with an apostrophe', async () => {
    const { safeCell } = await import('../src/app/items/import/lib');
    for (const bad of ['=SUM(A1:A9)', '+1 foil', '-cmd|calc', '@SUM(1)', '\tTabbed', '\rCR']) {
      expect(safeCell(bad), JSON.stringify(bad)).toBe(`'${bad}`);
    }
  });
  it('ordinary text and plain numbers are left alone', async () => {
    const { safeCell } = await import('../src/app/items/import/lib');
    for (const ok of ['Pork belly', 'Liempo|Pork liempo', '12', '-12', '1,234.50', '']) expect(safeCell(ok)).toBe(ok);
  });
  it('the page renders every user cell through safeCell, never raw, and never with dangerouslySetInnerHTML', () => {
    const page = read('page.tsx');
    expect(page).toMatch(/safeCell\(/);
    expect(page).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

describe('S4 screen - plain-language statuses and the upload limit', () => {
  it('every domain status has a plain label (no snake_case shown to a person)', async () => {
    const { IMPORT_STATUS_LABELS } = await import('../src/app/items/import/lib');
    for (const s of STATUSES) {
      const label = (IMPORT_STATUS_LABELS as Record<string, string>)[s];
      expect(label, s).toMatch(/^[A-Z][^_]{5,}$/);
    }
  });
  it('the upload limit equals the domain limit and is checked on the server BEFORE the file is read into text', async () => {
    const { MAX_UPLOAD_BYTES } = await import('../src/app/items/import/lib');
    const { ITEM_IMPORT_MAX_BYTES } = (await import('@shareat/domain')) as unknown as { ITEM_IMPORT_MAX_BYTES: number };
    expect(MAX_UPLOAD_BYTES).toBe(ITEM_IMPORT_MAX_BYTES);
    const actions = read('actions.ts');
    expect(actions).toMatch(/\.size\s*>\s*MAX_UPLOAD_BYTES|MAX_UPLOAD_BYTES\s*<\s*[\w.]*\.size/);
    expect(actions.indexOf('MAX_UPLOAD_BYTES')).toBeLessThan(actions.search(/\.text\(\)|arrayBuffer\(\)/));
  });
});

describe('S4 screen - actions go through the domain, and confirm never trusts the preview', () => {
  const actions = () => read('actions.ts');
  it("is a 'use server' module calling previewItemImport and confirmItemImport, each inside a transaction", () => {
    const a = actions();
    expect(a).toMatch(/^['"]use server['"]/m);
    expect(a).toMatch(/previewItemImport/);
    expect(a).toMatch(/confirmItemImport/);
    expect(a).toMatch(/transaction\(|withActor|runAs|withOrgPrincipal/);
  });
  it('the confirm action re-reads the CSV (file or hidden text field) and does not accept a client-built list of rows', () => {
    const a = actions();
    expect(a).not.toMatch(/JSON\.parse\(\s*String\(\s*formData\.get\(['"](rows|preview)/);
    expect(a).toMatch(/formData\.get\(['"](csv|file)['"]\)/);
  });
  it('the page is admin-only: it gates on approve_item_request (not a role-name check)', () => {
    const page = read('page.tsx');
    expect(page).toMatch(/approve_item_request/);
    expect(page).not.toMatch(/role\s*===\s*['"]admin['"]/);
  });
  it('the Confirm button is shown only when the preview says canConfirm, and is a pending-aware SubmitButton', () => {
    const page = read('page.tsx');
    expect(page).toMatch(/canConfirm/);
    expect(page).toMatch(/SubmitButton/);
  });
});
