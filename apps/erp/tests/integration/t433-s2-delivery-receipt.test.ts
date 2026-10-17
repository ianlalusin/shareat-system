import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-433 S2 (TESTER) cases 22-25 and 30 - the printable delivery receipt and the order page controls, as a
 * server render against the real database (session mocked; auth, reads and money math are real).
 * Mutants: M22 paid = total, M23 drop the status check, M24 session-only gate, M25 title "Sales Invoice",
 * M30 print link on drafts.
 *
 * Route assumed: apps/erp/src/app/trade/orders/[id]/print/page.tsx, default export taking `{ params: Promise<{ id }> }`.
 * A page that does not exist yet is the expected RED for 22-25; the BIR-number display (22b) uses the S2 column
 * (missing column = acceptable red for that one case).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

vi.mock('../../src/lib/session', () => ({ requireSession: vi.fn(), requireActor: vi.fn() }));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { closeDb } from '@shareat/db';
import { recordCharge, recordCollection, voidTradeOrder, WHOLESALE_REVENUE_CODE } from '@shareat/domain';
import { asOrg, buyer, dispatch, fixture, freezeClock, internalOrder, orderWorth, thawClock, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t433-b2b';

const sql = postgres(url, { max: 5 });
let requireSessionMock: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  freezeClock();
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
});
afterAll(async () => {
  thawClock();
  await closeDb();
  await sql.end({ timeout: 5 });
});

const as = (actor: { personId: string; orgId: string }) =>
  requireSessionMock.mockResolvedValue({ actor, sessionId: 's', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });

async function printHtml(id: string): Promise<string> {
  const mod = await import('../../src/app/trade/orders/[id]/print/page');
  const el = await mod.default({ params: Promise.resolve({ id }) } as never);
  return renderToStaticMarkup(el as never);
}
async function orderHtml(id: string): Promise<string> {
  const mod = await import('../../src/app/trade/orders/[id]/page');
  const el = await mod.default({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as never);
  return renderToStaticMarkup(el as never);
}
const is404 = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { digest?: string; message?: string };
    return /404|NOT_FOUND/.test(`${err.digest ?? ''} ${err.message ?? ''}`);
  }
  return false;
};

/** A dispatched 5,000 order (dated 2026-10-10) of which 2,000 is paid, for a buyer who also owes 1,000 at store B. */
async function partlyPaid(f: Fx, opts: { referenceNo?: string } = {}) {
  const customerId = await buyer(sql, f);
  await asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.manager, { storeId: f.otherStoreId, customerId, chargeDate: '2026-10-01', totalAmount: '1000.00', revenueAccountCode: WHOLESALE_REVENUE_CODE }),
  );
  const o = await orderWorth(sql, f, customerId, '5000.00', opts);
  const r = await dispatch(f, f.manager, o.orderId);
  await asOrg(f.orgId, (tx) =>
    recordCollection(tx, f.manager, {
      storeId: f.storeId, customerId, collectionDate: '2026-10-16', amount: '2000.00', moneyAccountId: f.drawerA,
      allocations: [{ chargeId: r.chargeId!, amountApplied: '2000.00' }],
    }),
  );
  return { ...o, customerId };
}

describe('S2 delivery receipt (print view)', () => {
  it('22. shows customer, date, reference, lines, total, paid 2,000.00, balance due 3,000.00 and the account balance 4,000.00 as of (M22: paid = total)', async () => {
    const f = await fixture(sql, 'r22');
    const o = await partlyPaid(f, { referenceNo: 'WO-555' });
    as(f.manager);
    const html = await printHtml(o.orderId);
    const [cust] = await sql<{ name: string }[]>`select name from customers where id = ${o.customerId}`;
    expect(html).toContain(cust!.name);
    expect(html).toContain('2026-10-10');
    expect(html).toContain('WO-555');
    expect(html).toMatch(/Paid on this order[\s\S]{0,200}2,000\.00/);
    expect(html).toMatch(/Balance due on this order[\s\S]{0,200}3,000\.00/);
    expect(html).toMatch(/5,000\.00/);
    expect(html).toMatch(/Account balance[\s\S]{0,300}4,000\.00/);
    expect(html).toMatch(/as of/i);
    expect(html).toMatch(/<h1[^>]*>[^<]*Delivery receipt/i);
  });

  it('22b. the printout carries the BIR invoice number when one is set (needs the 0203 column)', async () => {
    const f = await fixture(sql, 'r22b');
    const o = await partlyPaid(f);
    await sql`update trade_orders set bir_invoice_no = '001234' where id = ${o.orderId}`;
    as(f.manager);
    expect(await printHtml(o.orderId)).toContain('001234');
  });

  it('23. a draft order and a void order are 404 (M23: drop the status check)', async () => {
    const f = await fixture(sql, 'r23');
    const customerId = await buyer(sql, f);
    const draft = await orderWorth(sql, f, customerId, '1000.00');
    const voided = await orderWorth(sql, f, customerId, '1000.00');
    await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: voided.orderId, reason: 'test' }));
    as(f.manager);
    expect(await is404(printHtml(draft.orderId)), 'draft').toBe(true);
    expect(await is404(printHtml(voided.orderId)), 'void').toBe(true);
    // control: a dispatched order renders
    const live = await partlyPaid(f);
    await expect(printHtml(live.orderId)).resolves.toContain('Delivery receipt');
  });

  it('24. staff, and a manager of ANOTHER store, get 404 on a real dispatched order (M24: session-only gate)', async () => {
    const f = await fixture(sql, 'r24');
    const o = await partlyPaid(f);
    as(f.staff);
    expect(await is404(printHtml(o.orderId)), 'staff').toBe(true);
    as(f.managerB);
    expect(await is404(printHtml(o.orderId)), 'manager of the other store').toBe(true);
    as(f.manager);
    await expect(printHtml(o.orderId)).resolves.toContain('Delivery receipt'); // control
  });

  it('25. the footer is there and no "Official Receipt" / "Sales Invoice" title appears (M25: title it Sales Invoice)', async () => {
    const f = await fixture(sql, 'r25');
    const o = await partlyPaid(f);
    as(f.manager);
    const html = await printHtml(o.orderId);
    expect(html).toContain('This is not an official receipt or sales invoice.');
    expect(html).not.toMatch(/Official Receipt|Sales Invoice/);
    expect(html).not.toMatch(/<h1[^>]*>[^<]*(Invoice|Official)/i);
  });
});

describe('S2 order page controls', () => {
  it('30. "Print delivery receipt" and the BIR field show only when dispatched or received, never on a draft or an internal order (M30: link on drafts)', async () => {
    const f = await fixture(sql, 'r30');
    const customerId = await buyer(sql, f);
    const draft = await orderWorth(sql, f, customerId, '1000.00');
    as(f.manager);
    const draftHtml = await orderHtml(draft.orderId);
    expect(draftHtml).not.toContain('Print delivery receipt');
    expect(draftHtml).not.toMatch(/BIR invoice no/i);
    expect(draftHtml).not.toContain(`/trade/orders/${draft.orderId}/print`);

    await dispatch(f, f.manager, draft.orderId);
    const liveHtml = await orderHtml(draft.orderId);
    expect(liveHtml).toContain('Print delivery receipt');
    expect(liveHtml).toContain(`/trade/orders/${draft.orderId}/print`);
    expect(liveHtml).toMatch(/BIR invoice no\. \(booklet\)/);

    const internal = await internalOrder(sql, f);
    await dispatch(f, f.manager, internal.orderId);
    const internalHtml = await orderHtml(internal.orderId);
    expect(internalHtml).not.toContain('Print delivery receipt');
    expect(internalHtml).not.toMatch(/BIR invoice no/i);
  });
});
