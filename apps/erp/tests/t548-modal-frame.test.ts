/**
 * T-548 - the modal frame guard (docs/tasks/548-modal-fixed-header-footer.md). A source scan, so a modal added later
 * without the frame is caught. Each sweep slice (S1-S4) appends its files to SWEPT_FILES; for every swept file:
 *   1. every <form>/<CheckedForm> inside a <FormModal>/<Dialog> ends with <DialogActions>...</DialogActions>;
 *   2. no `overflow-y-auto`, `overflow-auto` or `max-h-` inside a modal's children (one scrollbar), except a named
 *      entry of MODAL_SCROLL_ALLOW.
 * The helpers are exported-by-shape and covered by the fixture tests below, so the guard cannot go vacuous.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Paths relative to apps/erp/src: every file that renders <DialogActions> (grep). */
export const SWEPT_FILES: readonly string[] = [
  'app/admin/stores/page.tsx',
  'app/ap/invoices/[id]/page.tsx',
  'app/ap/page.tsx',
  'app/ap/suppliers/[id]/AutoAllocatePaymentForm.tsx',
  'app/ap/suppliers/page.tsx',
  'app/attendance/leave/page.tsx',
  'app/cash-requests/[id]/page.tsx',
  'app/cash-requests/page.tsx',
  'app/commissary/catalogue/page.tsx',
  'app/commissary/orders/[id]/page.tsx',
  'app/commissary/orders/page.tsx',
  'app/customers/[customerId]/AutoAllocateCollectionForm.tsx',
  'app/customers/page.tsx',
  'app/customers/price-lists/[id]/page.tsx',
  'app/customers/price-lists/page.tsx',
  'app/cutover/opening/page.tsx',
  'app/inventory/counts/[id]/page.tsx',
  'app/inventory/counts/page.tsx',
  'app/inventory/deliveries/NewDeliveryForm.tsx',
  'app/inventory/locations/page.tsx',
  'app/inventory/pos-map/page.tsx',
  'app/inventory/production/page.tsx',
  'app/inventory/transfers/NewTransferForm.tsx',
  'app/inventory/usage/NewUsageForm.tsx',
  'app/items/page.tsx',
  'app/liabilities/[id]/page.tsx',
  'app/liabilities/page.tsx',
  'app/loans/[id]/page.tsx',
  'app/loans/page.tsx',
  'app/menu/DaypartsSection.tsx',
  'app/menu/items/[id]/page.tsx',
  'app/menu/page.tsx',
  'app/menu/prices/page.tsx',
  'app/menu/requests/page.tsx',
  'app/money-accounts/page.tsx',
  'app/money-transfers/RecordTransferForm.tsx',
  'app/money-transfers/SettleBetweenStoresForm.tsx',
  'app/owners/[id]/SettleForm.tsx',
  'app/owners/[id]/page.tsx',
  'app/owners/page.tsx',
  'app/payroll/page.tsx',
  'app/payroll/rates/StatutoryRateForm.tsx',
  'app/payroll/rates/page.tsx',
  'app/prepaid/[id]/page.tsx',
  'app/prepaid/page.tsx',
  'app/remittance/page.tsx',
  'app/service-charge/page.tsx',
  'app/settings/attendance/page.tsx',
  'app/settings/expense-categories/page.tsx',
  'app/settings/pos-link/page.tsx',
  'app/settings/usage-tolerance/page.tsx',
  'app/statutory-discounts/page.tsx',
  'app/trade/orders/NewOrderForm.tsx',
  'app/wastage/page.tsx',
  'components/forms/EditableRecord.tsx',
];

/** `file :: exact class fragment` entries that may keep a scroll area inside a modal, each with the reason. */
export const MODAL_SCROLL_ALLOW: readonly { readonly file: string; readonly fragment: string; readonly why: string }[] = [];

const SRC = join(__dirname, '..', 'src');

/** The inner text of every balanced `<Tag ...>...</Tag>` (the open tag's own attributes are excluded). */
export function regionsOf(src: string, tag: string): string[] {
  const open = new RegExp(`<${tag}(?=[\\s/>])`, 'g');
  const token = new RegExp(`<${tag}(?=[\\s/>])|</${tag}>`, 'g');
  const out: string[] = [];
  for (let m = open.exec(src); m; m = open.exec(src)) {
    let depth = 0;
    let start = -1;
    token.lastIndex = m.index;
    for (let t = token.exec(src); t; t = token.exec(src)) {
      if (t[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          out.push(src.slice(start, t.index));
          break;
        }
      } else {
        if (depth === 0) start = src.indexOf('>', t.index) + 1;
        depth += 1;
      }
    }
  }
  return out;
}

export const modalRegions = (src: string): string[] => [...regionsOf(src, 'FormModal'), ...regionsOf(src, 'Dialog')];
export const formRegions = (modal: string): string[] => [...regionsOf(modal, 'form'), ...regionsOf(modal, 'CheckedForm')];

/** True when the last child of the form is a closed DialogActions, or one wrapped in `{cond ? (...) : null}` / `{cond && (...)}` (EditableRecord: locked renders no actions). */
export const endsWithActions = (form: string): boolean => /<\/DialogActions>\s*(\)\s*(:\s*null\s*)?\}\s*)?$/.test(form);

const SCROLL = /overflow-y-auto|overflow-auto|max-h-/;

export function frameProblems(file: string, src: string): string[] {
  const problems: string[] = [];
  for (const modal of modalRegions(src)) {
    for (const form of formRegions(modal)) {
      if (!endsWithActions(form)) problems.push(`${file}: a modal form does not end with <DialogActions>`);
    }
    for (const line of modal.split('\n')) {
      if (!SCROLL.test(line)) continue;
      const allowed = MODAL_SCROLL_ALLOW.some((a) => a.file === file && line.includes(a.fragment));
      if (!allowed) problems.push(`${file}: a second scroll area inside a modal: ${line.trim()}`);
    }
  }
  return problems;
}

describe('T-548 the scan helpers (fixtures)', () => {
  const good = `<FormModal title="x"><form action={a}><input/><DialogActions><SubmitButton>Save</SubmitButton></DialogActions></form></FormModal>`;
  it('accepts a form that ends with DialogActions, plain or CheckedForm', () => {
    expect(frameProblems('f', good)).toEqual([]);
    expect(frameProblems('f', good.replaceAll('form', 'CheckedForm').replace('<CheckedForm action', '<CheckedForm rules={r} action'))).toEqual([]);
  });
  it('accepts a conditionally rendered action band that is still last', () => {
    expect(frameProblems('f', `<Dialog><form>{on ? (<DialogActions><b/></DialogActions>) : null}</form></Dialog>`)).toEqual([]);
    expect(frameProblems('f', `<Dialog><form>{on && (<DialogActions><b/></DialogActions>)}</form></Dialog>`)).toEqual([]);
    expect(frameProblems('f', `<Dialog><form>{on ? (<DialogActions><b/></DialogActions>) : null}<p/></form></Dialog>`)).toHaveLength(1);
  });
  it('rejects a form whose action row is bare, or not last', () => {
    expect(frameProblems('f', `<FormModal title="x"><form><SubmitButton>Save</SubmitButton></form></FormModal>`)).toHaveLength(1);
    expect(frameProblems('f', `<Dialog open><form><DialogActions><b/></DialogActions><p>after</p></form></Dialog>`)).toHaveLength(1);
  });
  it('does not mistake DialogActions for a Dialog, and ignores forms outside a modal', () => {
    expect(modalRegions(`<DialogActions>x</DialogActions>`)).toEqual([]);
    expect(frameProblems('f', `<form><b/></form>`)).toEqual([]);
  });
  it('rejects a nested vertical scroll area inside a modal, not outside it', () => {
    expect(frameProblems('f', `<FormModal><div className="max-h-64 overflow-y-auto">x</div></FormModal>`)).toHaveLength(1);
    expect(frameProblems('f', `<div className="overflow-auto">x</div><FormModal><p/></FormModal>`)).toEqual([]);
  });
  it('handles a nested tag of the same name', () => {
    const nested = `<Dialog><div><Dialog><form><DialogActions>a</DialogActions></form></Dialog></div></Dialog>`;
    expect(regionsOf(nested, 'Dialog')).toHaveLength(2);
  });
});

describe('T-548 swept files keep the frame', () => {
  it('SWEPT_FILES: every modal form ends with DialogActions; no second scroll area', () => {
    const problems = SWEPT_FILES.flatMap((f) => frameProblems(f, readFileSync(join(SRC, ...f.split('/')), 'utf8')));
    expect(problems).toEqual([]);
  });
});
