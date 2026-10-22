/**
 * T-343 S7 — change 5 (trade line numbers), the action and form legs (N1, N3).
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S7. N2/N2n (the domain leg, real Postgres)
 * are in `apps/erp/tests/integration/t343-s7-trade-line-numbers.test.ts`.
 *
 * ⛔ TESTER, not BUILDER.
 * - N1 is red until `createOrderAction` numbers each row `lineNo: i + 1` BEFORE dropping the ones
 *   with no `itemId` — today it drops first, so the mocked `createTradeOrder` sees plain
 *   `{ itemId, quantity, rate }` lines with no `lineNo` at all.
 * - N3 is red until `NewOrderForm` renders a visible `Line {idx + 1}` span per row — today no line
 *   shows a number (`NewOrderForm.tsx:161-215`: Item, Quantity, Rate only).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));

vi.mock('../src/app/trade/orders/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  peso: (v: unknown) => `₱${v}`,
}));

vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

const createTradeOrder = vi.fn();
vi.mock('@shareat/domain', () => ({
  createTradeOrder: (...args: unknown[]) => createTradeOrder(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('N1 — createOrderAction numbers each posted row by its VISIBLE form position, before dropping empties', () => {
  it(
    'itemId = [\'a\', \'\', \'b\']: createTradeOrder receives 2 lines, with lineNo 1 and 3',
    async () => {
      createTradeOrder.mockResolvedValueOnce({ orderId: 'order-1', totalAmount: '100.00' });
      const { createOrderAction } = await import('../src/app/trade/orders/actions');

      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('customerId', 'cust-1');
      fd.set('orderDate', '2026-01-10');
      fd.append('itemId', 'a');
      fd.append('itemId', '');
      fd.append('itemId', 'b');
      fd.append('quantity', '1');
      fd.append('quantity', '');
      fd.append('quantity', '2');
      fd.append('rate', '10');
      fd.append('rate', '');
      fd.append('rate', '20');

      await expect(createOrderAction(fd)).rejects.toBeInstanceOf(RedirectSignal);

      expect(createTradeOrder).toHaveBeenCalledTimes(1);
      const input = createTradeOrder.mock.calls[0]![2] as { lines: { itemId: string; lineNo?: number }[] };
      expect(input.lines).toHaveLength(2);
      expect(input.lines.map((l) => l.itemId)).toEqual(['a', 'b']);
      expect(input.lines.map((l) => l.lineNo)).toEqual([1, 3]);
    },
    30000,
  );
});

describe('N3 — NewOrderForm shows a visible line number per row, with every control unchanged', () => {
  it(
    'one item: visible text contains "Line 1", and itemId/quantity/rate/Add line/Remove all remain',
    async () => {
      const { NewOrderForm } = await import('../src/app/trade/orders/NewOrderForm');
      const html = renderToStaticMarkup(
        createElement(NewOrderForm, {
          action: () => undefined,
          stores: [{ id: 'store-1', code: 'S1', name: 'Store One' }],
          storeId: 'store-1',
          customers: [
            {
              id: 'cust-1',
              name: 'Buyer One',
              customerGroup: 'wholesale',
              treatment: 'external',
              counterpartyStoreId: null,
              priceListId: null,
              creditLimit: null,
            },
          ],
          items: [{ id: 'item-1', code: 'ITM1', name: 'Widget', baseUnit: 'kg' }],
          quotes: {},
          branchPrices: {},
          today: '2026-01-10',
        }),
      );

      expect(html).toContain('Line 1');
      // Controls unchanged (Invariant 17 — no import added, no control added or removed).
      expect(html).toContain('name="itemId"');
      expect(html).toContain('name="quantity"');
      expect(html).toContain('name="rate"');
      // T-448: "+ Add line" is a round icon button; its accessible name is "Add line" (leading "+ " dropped).
      expect(html).toContain('aria-label="Add line"');
      expect(html).toContain('Remove');
    },
    30000,
  );
});
