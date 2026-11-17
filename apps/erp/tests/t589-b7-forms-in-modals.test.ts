/**
 * T-589 B7 (B): the page-level add forms sit behind a header button (FormModal), as T-448 did for /ap/suppliers.
 * Source-level on purpose: the drawing moved, the form did not. Each case pins that the action is INSIDE a
 * `<FormModal` block and that the field names are the ones the form had before the move.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = (rel: string): string => readFileSync(join(__dirname, '..', 'src', 'app', rel), 'utf8');
/** Every `<FormModal ...>...</FormModal>` block. FormModals never nest, so a lazy match is exact. */
const modals = (src: string): string[] => src.match(/<FormModal[\s\S]*?<\/FormModal>/g) ?? [];
const modalWith = (src: string, needle: string): string => modals(src).find((m) => m.includes(needle)) ?? '';
const names = (src: string): string[] => [...new Set([...src.matchAll(/\bname="(\w+)"/g)].map((m) => m[1]!))].sort();

describe('T-589 B7 forms in modals', () => {
  it('documents/templates: saveTemplateAction for a NEW template is in a modal that reopens on a refill', () => {
    const src = app('documents/templates/page.tsx');
    const m = modalWith(src, 'action={saveTemplateAction}');
    expect(m).toContain('trigger="+ New template"');
    expect(m).toContain("defaultOpen={newTyped?.kind === 'typed'}");
    expect(m).toContain('<TemplateFields typed={newTyped} />');
    // the fields are unchanged (templateId belongs to the per-card edit form, not this one)
    expect(names(src.slice(src.indexOf('function TemplateFields'), src.indexOf('function TemplateCard')))).toEqual(['body', 'kind', 'name', 'slot']);
    expect(src).not.toContain('Write the first one above');
  });

  it('expenses/recurring: the create TemplateForm is in a header modal, with no templateId (create branch)', () => {
    const src = app('expenses/recurring/page.tsx');
    const m = modalWith(src, '<TemplateForm');
    expect(m).toContain('trigger="+ Add a template"');
    expect(m).not.toContain('templateId');
    const create = src.slice(src.indexOf('<CheckedForm rules={RECURRING_TEMPLATE_RULES} action={createTemplateAction}'));
    expect(names(create)).toEqual(['defaultMoneyAccountId', 'interval', 'storeId', 'tillIsDeliberate']);
    for (const rule of ['name', 'supplierId', 'categoryId', 'defaultAmount', 'anchorDay', 'startsOn']) expect(create).toContain(`nativeAttrs(RECURRING_TEMPLATE_RULES.${rule})`);
  });

  it('menu/usage-source: seed and link forms are in modals; the row Unlink stays inline', () => {
    const src = app('menu/usage-source/page.tsx');
    const seed = modalWith(src, 'action={seedLinkAction}');
    const link = modalWith(src, 'action={linkItemAction}');
    expect(seed).toContain('trigger="+ Link from the POS map"');
    expect(names(seed)).toEqual(['posItemKey', 'storeId', 'variantId']);
    expect(link).toContain('trigger="+ Link to a menu item"');
    expect(names(link)).toEqual(['locationId', 'posItemKey', 'storeId', 'variantId']);
    expect(modals(src).some((m) => m.includes('unlinkItemAction'))).toBe(false);
  });

  it('payroll/rates: both add forms are in modals, once each, with their fields', () => {
    const src = app('payroll/rates/page.tsx');
    const bracket = modalWith(src, 'action={addWithholdingBracketSetAction}');
    const wage = modalWith(src, 'action={addMinimumWageAction}');
    expect(bracket).toContain('trigger="+ Add table"');
    expect(names(bracket)).toEqual(['frequency']);
    for (const f of ['effectiveFrom', 'rows', 'sourceRef']) expect(bracket).toContain(`nativeAttrs(PAYROLL_BRACKET_SET_RULES.${f})`);
    expect(wage).toContain('trigger="+ Add wage"');
    expect(names(wage)).toEqual(['storeId']);
    for (const f of ['effectiveFrom', 'dailyRate', 'wageOrderRef']) expect(wage).toContain(`nativeAttrs(PAYROLL_MIN_WAGE_RULES.${f})`);
    expect(src.match(/action=\{addWithholdingBracketSetAction\}/g)).toHaveLength(1);
    expect(src.match(/action=\{addMinimumWageAction\}/g)).toHaveLength(1);
  });
});
