import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-589 B4b item 1 - a 404 where a message belongs.
 *  - /trade/orders/[id]/print for a DRAFT (or void, or transfer) order: a plain message plus a link back to the order.
 *  - /commissary/orders/[id] opened with a TRADE order's id: a plain message plus a link to Trade orders.
 * An id that does not exist, belongs to another org or is not the person's to open (`orderDetail` answers null) stays a 404, and so does a
 * dispatched order the person may open but not print (no information given about it).
 *
 * MUTANTS (each turns a case red): `notFound()` back in place of the message branch -> the draft/void/trade cases throw;
 * the message branch run without the `orderDetail` gate (`seen` ignored) -> the foreign-id cases render a message instead of throwing;
 * `receiptRefusal` returns text for a dispatched order with a charge -> the "may open but not print" case renders instead of throwing.
 */
const ACTOR = { orgId: 'org-1', personId: 'p-1' };
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR),
  requireSession: vi.fn(async () => ({ actor: ACTOR, sessionId: 's1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
// T-617: the route gate and the store check are stubbed open; this file is about the refusal messages (the gates are proved in t617-gate-awaiting-routes.test.ts).
vi.mock('../src/lib/page-access', () => ({ requirePageAccess: vi.fn(async () => ({ actor: ACTOR, refusal: null })) }));
vi.mock('../src/lib/store-scope', () => ({ recordInScope: vi.fn(async () => true) }));
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));
const M = vi.hoisted(() => ({ deliveryReceiptData: vi.fn(), orderDetail: vi.fn(), orderView: vi.fn() }));
vi.mock('../src/app/trade/orders/lib', async (orig) => ({
  ...(await orig<typeof import('../src/app/trade/orders/lib')>()),
  deliveryReceiptData: M.deliveryReceiptData,
  orderDetail: M.orderDetail,
}));
vi.mock('../src/app/commissary/orders/lib', async (orig) => ({
  ...(await orig<typeof import('../src/app/commissary/orders/lib')>()),
  orderView: M.orderView,
  actorStoreIds: vi.fn(async () => []),
}));

import DeliveryReceiptPage from '../src/app/trade/orders/[id]/print/page';
import BranchOrderPage from '../src/app/commissary/orders/[id]/page';
import { receiptRefusal } from '../src/app/trade/orders/[id]/print/refusal';

const is404 = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { digest?: string; message?: string };
    return /404|NOT_FOUND/.test(`${err.digest ?? ''} ${err.message ?? ''}`);
  }
  return false;
};
const printPage = async (id: string) => renderToStaticMarkup((await DeliveryReceiptPage({ params: Promise.resolve({ id }) })) as never);
const branchPage = async (id: string) =>
  renderToStaticMarkup((await BranchOrderPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as never);
const order = (status: string, extra: Record<string, unknown> = {}) => ({
  order: { id: 'o-1', status, arChargeId: null, requestedByStoreId: null, ...extra },
});

beforeEach(() => {
  M.deliveryReceiptData.mockReset().mockResolvedValue(null);
  M.orderDetail.mockReset().mockResolvedValue(null);
  M.orderView.mockReset().mockResolvedValue(null);
});

describe('print route', () => {
  it('a draft says it cannot be printed yet and links back to the order', async () => {
    M.orderDetail.mockResolvedValue(order('draft'));
    const html = await printPage('o-1');
    expect(html).toContain('A draft can&#x27;t be printed yet. Dispatch it first.');
    expect(html).toContain('href="/trade/orders/o-1"');
  });
  it('a void order and a no-charge (transfer) order each get their own plain message', async () => {
    M.orderDetail.mockResolvedValue(order('void'));
    expect(await printPage('o-1')).toContain('was voided');
    M.orderDetail.mockResolvedValue(order('dispatched'));
    expect(await printPage('o-1')).toContain('transfer between branches');
  });
  it('a foreign / forged id (orderDetail answers null) is still a 404', async () => {
    expect(await is404(printPage('nope'))).toBe(true);
  });
  it('a dispatched order the person may open but not print stays a 404 (nothing said about it)', async () => {
    M.orderDetail.mockResolvedValue(order('dispatched', { arChargeId: 'c-1' }));
    expect(await is404(printPage('o-1'))).toBe(true);
  });
  it('receiptRefusal speaks for draft, confirmed, void and charge-less orders only', () => {
    expect(receiptRefusal({ status: 'confirmed', arChargeId: null })).toMatch(/Dispatch it first/);
    expect(receiptRefusal({ status: 'received', arChargeId: 'c' })).toBeNull();
    expect(receiptRefusal({ status: 'received', arChargeId: null })).not.toBeNull();
  });
});

describe('branch order route', () => {
  it('a trade order id says it lives under Trade orders and links to it', async () => {
    M.orderDetail.mockResolvedValue(order('dispatched', { arChargeId: 'c-1' }));
    const html = await branchPage('o-1');
    expect(html).toContain('listed under Trade orders');
    expect(html).toContain('href="/trade/orders/o-1"');
    expect(html).toContain('href="/commissary/orders"');
  });
  it('an id nobody can open is still a 404', async () => {
    expect(await is404(branchPage('nope'))).toBe(true);
  });
  it('a branch order that simply cannot be shown (requestedByStoreId set) is still a 404', async () => {
    M.orderDetail.mockResolvedValue(order('draft', { requestedByStoreId: 's-9' }));
    expect(await is404(branchPage('o-1'))).toBe(true);
  });
});
