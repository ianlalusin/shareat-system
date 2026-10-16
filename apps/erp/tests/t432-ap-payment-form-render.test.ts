import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * T-432 cases 4-5 - the supplier payment form's "Pay from" list. `docs/tasks/432-ap-payment-float-picker.md` rulings 1-2.
 *
 *   4  an open float is an option `float:<cashRequestId>` labelled exactly "{holder} · cash request — Balance ₱{outstanding}".  M4: label `· float`.
 *   5  the store's staff cash account is NOT a plain option (a request is the only way to it); the office safe is.  M5: remove the staff filter.
 *
 * The form takes a new `floats` prop (the shape `openFloatsForStore` returns) and renders `<Select name="source">`.
 * `actions.ts` is mocked: the form only imports types from it, but the mock keeps a stray runtime import from reaching the db.
 */
vi.mock('../src/app/ap/actions', () => ({ recordPaymentAction: vi.fn(), autoAllocatePaymentAction: vi.fn() }));

import { AutoAllocatePaymentForm } from '../src/app/ap/suppliers/[id]/AutoAllocatePaymentForm';

const STORE = '11111111-1111-4111-8111-111111111111';
const SAFE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_CASH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BANK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function render(floats: unknown[] = [{ cashRequestId: REQ, holderName: 'Ana', outstanding: '1000.00', moneyAccountId: STAFF_CASH, storeId: STORE }]): string {
  return renderToStaticMarkup(
    createElement(AutoAllocatePaymentForm as never, {
      postAction: () => {},
      previewAction: async () => ({ ok: true, allocations: [], unallocated: '0.00' }),
      supplierId: '22222222-2222-4222-8222-222222222222',
      storeId: STORE,
      items: [{ expenseId: '33333333-3333-4333-8333-333333333333', particulars: 'Stock purchase', businessDate: '2026-01-10', outstanding: '2000.00' }],
      wallets: [
        { id: SAFE, name: 'Office safe', custodian: 'office', instrument: 'cash', balance: '500000.00' },
        { id: STAFF_CASH, name: 'Staff cash', custodian: 'staff', instrument: 'cash', balance: '1000.00' },
        { id: BANK, name: 'BDO', custodian: 'office', instrument: 'bank', balance: '9000.00' },
      ],
      floats,
      today: '2026-01-15',
    } as never),
  );
}
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
function sourceSelect(html: string): string {
  const m = html.match(/<select[^>]*name="source"[^>]*>[\s\S]*?<\/select>/);
  expect(m, 'a <select name="source"> must exist').not.toBeNull();
  return m![0];
}
const optionValues = (sel: string) => [...sel.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]!);

describe('case 4 - the float option (M4)', () => {
  it('value float:<id>, label exactly "Ana · cash request — Balance ₱1,000.00"', () => {
    const sel = sourceSelect(render());
    expect(optionValues(sel)).toContain(`float:${REQ}`);
    const opt = sel.match(new RegExp(`<option[^>]*value="float:${REQ}"[^>]*>([^<]*)</option>`));
    expect(opt, 'the float option must render').not.toBeNull();
    expect(decode(opt![1]!)).toBe('Ana · cash request — Balance ₱1,000.00');
  });

  it('holders listed in the order given; no float -> no float option', () => {
    const two = render([
      { cashRequestId: REQ, holderName: 'Ana', outstanding: '1000.00', moneyAccountId: STAFF_CASH, storeId: STORE },
      { cashRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', holderName: 'Zed', outstanding: '5.50', moneyAccountId: STAFF_CASH, storeId: STORE },
    ]);
    expect(optionValues(sourceSelect(two)).filter((v) => v.startsWith('float:'))).toEqual([`float:${REQ}`, 'float:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
    expect(decode(sourceSelect(two))).toContain('Zed · cash request — Balance ₱5.50');
    expect(optionValues(sourceSelect(render([]))).filter((v) => v.startsWith('float:'))).toEqual([]);
  });
});

describe('case 5 - the staff cash account is not a plain option (M5)', () => {
  it('the office safe and the bank are options; the staff cash account id is not', () => {
    const sel = sourceSelect(render());
    const values = optionValues(sel);
    expect(values).toContain(SAFE);
    expect(values).toContain(BANK);
    expect(values).not.toContain(STAFF_CASH);
  });

  it('with no floats the staff cash account is still not offered', () => {
    expect(optionValues(sourceSelect(render([])))).not.toContain(STAFF_CASH);
  });
});
