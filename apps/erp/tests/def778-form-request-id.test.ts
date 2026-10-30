import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * DEF-778 - the ordinary transfer form and the supplier payment form carry a hidden `requestId` the page minted for THIS
 * render (the T-488 pattern `SettleBetweenStoresForm` already follows), and each page mints a new one every render.
 * The server actions are mocked: the forms only need them as props.
 */
vi.mock('../src/app/money-transfers/actions', () => ({
  createMoneyTransferAction: vi.fn(),
  settleBetweenStoresAction: vi.fn(),
  voidMoneyTransferAction: vi.fn(),
}));
vi.mock('../src/app/ap/actions', () => ({ recordPaymentAction: vi.fn(), autoAllocatePaymentAction: vi.fn() }));

import { RecordTransferForm } from '../src/app/money-transfers/RecordTransferForm';
import { AutoAllocatePaymentForm } from '../src/app/ap/suppliers/[id]/AutoAllocatePaymentForm';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hidden = (html: string) => [...html.matchAll(/<input[^>]*name="requestId"[^>]*>/g)].map((m) => m[0]);
const valueOf = (tag: string) => tag.match(/value="([^"]*)"/)?.[1];

function transfer(requestId: string): string {
  return renderToStaticMarkup(createElement(RecordTransferForm, { options: [], requestId, today: '2026-01-01' }));
}
function payment(requestId: string): string {
  return renderToStaticMarkup(
    createElement(AutoAllocatePaymentForm as never, {
      postAction: () => {},
      previewAction: async () => ({ ok: true, allocations: [], unallocated: '0.00' }),
      supplierId: '22222222-2222-4222-8222-222222222222',
      storeId: '11111111-1111-4111-8111-111111111111',
      requestId,
      items: [{ expenseId: '33333333-3333-4333-8333-333333333333', particulars: 'Stock purchase', businessDate: '2026-01-10', outstanding: '2000.00' }],
      wallets: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', name: 'Office safe', custodian: 'office', instrument: 'cash', balance: '500000.00' }],
      floats: [],
      today: '2026-01-15',
    } as never),
  );
}

describe('DEF-778 - the forms submit the id they were rendered with', () => {
  it('RecordTransferForm: exactly one hidden requestId input, carrying the prop', () => {
    const tags = hidden(transfer(ID_A));
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('type="hidden"');
    expect(valueOf(tags[0]!)).toBe(ID_A);
    expect(valueOf(hidden(transfer(ID_B))[0]!)).toBe(ID_B);
  });

  it('AutoAllocatePaymentForm: exactly one hidden requestId input, carrying the prop', () => {
    const tags = hidden(payment(ID_A));
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('type="hidden"');
    expect(valueOf(tags[0]!)).toBe(ID_A);
    expect(valueOf(hidden(payment(ID_B))[0]!)).toBe(ID_B);
  });
});

describe('DEF-778 - each page mints a fresh id when it renders', () => {
  const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('money-transfers/page.tsx passes a crypto.randomUUID() minted in the render to RecordTransferForm', () => {
    const page = source('../src/app/money-transfers/page.tsx');
    expect(page).toMatch(/const requestId = crypto\.randomUUID\(\);/);
    expect(page).toMatch(/<RecordTransferForm[^>]*requestId=\{requestId\}/);
  });

  it('ap/suppliers/[id]/page.tsx passes a crypto.randomUUID() minted in the render to AutoAllocatePaymentForm', () => {
    const page = source('../src/app/ap/suppliers/[id]/page.tsx');
    expect(page).toMatch(/<AutoAllocatePaymentForm[\s\S]*?requestId=\{crypto\.randomUUID\(\)\}/);
  });

  it('both server actions read the id from the form, never mint one', () => {
    const transferActions = source('../src/app/money-transfers/actions.ts');
    const apActions = source('../src/app/ap/actions.ts');
    expect(transferActions).toMatch(/createMoneyTransfer\(tx, actor, \{\s*(?:\/\/[^\n]*\n\s*)*requestId: str\(formData, 'requestId'\)/);
    expect(apActions).toMatch(/recordPayment\(tx, actor, \{\s*(?:\/\/[^\n]*\n\s*)*requestId: str\(formData, 'requestId'\)/);
  });
});
