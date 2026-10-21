// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { enhancePhoneTables, observePhoneTables } from '../src/components/ui/phone-table-cards';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); document.body.replaceChildren(); });
function fixture(html: string) {
  const root = document.createElement('main'); root.innerHTML = html; document.body.append(root); return root;
}
function cell(root: HTMLElement, selector: string) {
  const found = root.querySelector<HTMLElement>(selector); if (!found) throw new Error(`Missing fixture ${selector}`); return found;
}
const sample = '<table id="orders"><thead><tr><th>Item</th><th>Amount</th><th></th></tr></thead><tbody><tr><td><a href="/items/sample">Rice</a></td><td>₱123,456,789.12</td><td><form><input name="qty" value="2"><input type="hidden" name="id" value="synthetic"><button>Save</button></form></td></tr></tbody></table>';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('T-450 original table nodes become labeled phone cards', () => {
  it('adds field labels and native roles without replacing controls, ids, values or handlers', () => {
    const root = fixture(sample), input = root.querySelector('input'), button = cell(root, 'button');
    if (!input) throw new Error('Missing input'); input.value = '17'; let clicks = 0;
    button.addEventListener('click', event => { event.preventDefault(); clicks++; });
    enhancePhoneTables(root);
    expect(cell(root, 'table').dataset.phoneCards).toBe('');
    expect(cell(root, 'tbody td').dataset.cardLabel).toBe('Item');
    expect(cell(root, 'tbody td:nth-child(2)').dataset.cardLabel).toBe('Amount');
    expect(cell(root, 'tbody td:nth-child(3)').dataset.cardLabel).toBe('Actions');
    expect(root.querySelector('input')).toBe(input); expect(input.value).toBe('17');
    expect(root.querySelectorAll('form')).toHaveLength(1); expect(root.querySelectorAll('[name="id"]')).toHaveLength(1);
    button.click(); expect(clicks).toBe(1);
    expect(cell(root, 'table').getAttribute('role')).toBe('table');
    expect(cell(root, 'tbody td').getAttribute('role')).toBe('cell');
    expect(cell(root, 'a').getAttribute('href')).toBe('/items/sample');
    expect(root.textContent).toContain('₱123,456,789.12');
  });
  it('is idempotent and retains custom grid roles and disabled states', () => {
    const root = fixture(sample.replace('<table id="orders">', '<table id="orders" role="grid">').replace('<button>', '<button disabled>'));
    enhancePhoneTables(root); const first = root.innerHTML; enhancePhoneTables(root);
    expect(root.innerHTML).toBe(first); expect(cell(root, 'table').getAttribute('role')).toBe('grid');
    expect(root.querySelector('button')?.disabled).toBe(true);
  });
  it('respects grouped column headers, row spans, explicit headers and total colspans', () => {
    const root = fixture('<table><thead><tr><th rowspan="2">Item</th><th colspan="2">Sales</th></tr><tr><th id="qty">Quantity</th><th id="total">Amount</th></tr></thead><tbody><tr><td>Rice</td><td>2</td><td headers="total">₱20.00</td></tr><tr><td colspan="2">Total</td><td>₱20.00</td></tr><tr><td colspan="3">No more rows</td></tr></tbody></table>');
    enhancePhoneTables(root);
    const labels = [...root.querySelectorAll<HTMLElement>('tbody tr:first-child td')].map(td => td.dataset.cardLabel);
    expect(labels).toEqual(['Item', 'Sales · Quantity', 'Amount']);
    expect(cell(root, 'tbody tr:nth-child(2) td:last-child').dataset.cardLabel).toBe('Sales · Amount');
    expect(cell(root, 'tbody tr:last-child td').dataset.cardSpan).toBe('full');
    expect(cell(root, '#total').id).toBe('total');
  });
  it('bounds malformed span dimensions before expanding the logical column grid', () => {
    // Two headings keep the negative control bounded even when span validation is deleted.
    const root = fixture('<table><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody><tr><td>Rice</td><td>₱1.00</td></tr></tbody></table>');
    const header = root.querySelector('th'); if (!header) throw new Error('Missing header');
    Object.defineProperty(header, 'colSpan', { value: Number.NaN });
    Object.defineProperty(header, 'rowSpan', { value: Number.POSITIVE_INFINITY });
    enhancePhoneTables(root);
    expect(cell(root, 'tbody td').dataset.cardLabel).toBe('Item');
    expect(root.querySelectorAll('tbody td')).toHaveLength(2);
  });
  it('keeps interactive header controls visible and omits their action text from field labels', () => {
    const root = fixture('<table><thead><tr><th>Position<form><button>Retire</button></form></th><th>Amount</th></tr></thead><tbody><tr><td>Cashier</td><td>0.00</td></tr></tbody></table>');
    enhancePhoneTables(root);
    expect(cell(root, 'thead').dataset.cardControls).toBe('');
    expect(cell(root, 'th').dataset.cardControl).toBe('');
    expect(cell(root, 'tbody td').dataset.cardLabel).toBe('Position');
    expect(root.querySelectorAll('button')).toHaveLength(1);
  });
  it('uses a sorting button title as the column label and preserves checkbox selection', () => {
    const root = fixture('<table><thead><tr><th><input type="checkbox" aria-label="Select all"></th><th><button>Name</button></th></tr></thead><tbody><tr><td><input type="checkbox" aria-label="Select Rice" checked></td><td>Rice</td></tr></tbody></table>');
    enhancePhoneTables(root);
    expect(cell(root, 'tbody td:last-child').dataset.cardLabel).toBe('Name');
    expect(cell(root, 'tbody td').dataset.cardLabel).toBe('Select');
    expect(root.querySelector<HTMLInputElement>('tbody input')?.checked).toBe(true);
  });
  it('labels headerless reports explicitly and keeps footer and empty rows', () => {
    const root = fixture('<table data-card-columns="Account|Amount"><tbody><tr><td>Cash</td><td>₱1.00</td></tr><tr><td colspan="2">Nothing unpaid</td></tr></tbody><tfoot><tr><td>Total</td><td>₱1.00</td></tr></tfoot></table>');
    enhancePhoneTables(root);
    expect(cell(root, 'tbody td:nth-child(2)').dataset.cardLabel).toBe('Amount');
    expect(cell(root, 'tfoot td:last-child').dataset.cardLabel).toBe('Amount');
    expect(cell(root, 'tbody tr:last-child td').dataset.cardSpan).toBe('full');
    expect(root.textContent).toContain('Nothing unpaid');
  });
  it('does not confuse a nested table header with its parent', () => {
    const root = fixture('<table><thead><tr><th>Outer</th></tr></thead><tbody><tr><td><table><thead><tr><th>Inner</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table></td></tr></tbody></table>');
    enhancePhoneTables(root);
    expect(cell(root, 'table > tbody > tr > td').dataset.cardLabel).toBe('Outer');
    expect(cell(root, 'td table td').dataset.cardLabel).toBe('Inner');
  });
  it('observes late rows, new tables and edited headers, then stops on cleanup', async () => {
    const root = fixture(sample), stop = observePhoneTables(root); stops.push(stop);
    const addedRow = document.createElement('tr'); addedRow.innerHTML = '<td>Beans</td><td>2.00</td><td><button>Edit</button></td>';
    cell(root, 'tbody').append(addedRow);
    cell(root, 'th').textContent = 'Product'; root.insertAdjacentHTML('beforeend', '<table data-card-columns="Name"><tbody><tr><td>New</td></tr></tbody></table>');
    await tick();
    expect(cell(root, '#orders tbody tr:last-child td').dataset.cardLabel).toBe('Product');
    expect(cell(root, 'table:last-child td').dataset.cardLabel).toBe('Name');
    stop(); cell(root, 'th').textContent = 'Not observed'; await tick();
    expect(cell(root, '#orders tbody td').dataset.cardLabel).toBe('Product');
  });
  it('survives React rerender and removal with entered control values intact', async () => {
    const host = fixture(''), react = createRoot(host);
    const render = (header: string, show: boolean) => h('table', null,
      h('thead', null, h('tr', null, h('th', null, header))),
      h('tbody', null, show && h('tr', { key: 'row' }, h('td', null, h('input', { defaultValue: 'Original' })))));
    await act(async () => react.render(render('Name', true)));
    stops.push(observePhoneTables(host)); const input = host.querySelector('input'); if (!input) throw new Error('Missing React input');
    input.value = 'Edited'; await act(async () => react.render(render('Description', true))); await tick();
    expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('Edited');
    expect(cell(host, 'td').dataset.cardLabel).toBe('Description');
    await act(async () => react.render(render('Description', false))); expect(host.querySelectorAll('td')).toHaveLength(0);
    await act(async () => react.unmount());
  });
});
