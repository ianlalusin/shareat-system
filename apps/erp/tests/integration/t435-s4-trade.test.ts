import { afterAll, describe, expect, it, vi } from 'vitest';

import { M, expectAbsent, expectNotAvailable, expectPresent, pageError, plain, render, sql, world } from './t435-fixture';

/**
 * T-435 S4 (TESTER) - trade: /trade/orders (register + store scope) and /trade/orders/[id] (the credit limit).
 * Spec: docs/tasks/435-personal-data-access-gates.md, cases 32-35 (design 9). Bible row 353. S4 is built after T-433 S3 merges.
 *
 * Contract pinned here:
 *  - orderFormData (trade/orders/lib.ts) no longer carries a `creditLimit` for any customer, for any actor. Nothing in the client form
 *    read it. (Called with the orgId it takes today; if the builder moves it to an Actor the helper below tries that too.)
 *  - the order page shows the buyer's credit limit (the "reason to exceed the limit" field and the warning) only to someone who can
 *    approve_buyer or override_credit_limit at THE ORDER'S store.
 *  - /trade/orders offers and honours only the viewer's scoped stores; a forged ?store= is "This store is not available to you.".
 *
 * Mutants (spec): M32 keep the field; M33 remove the can() at [id]/page.tsx; M34 strip the limit for everyone; M35 validate against
 * listStores.
 *
 * Fixture: a draft sale order for Y at S1 (limit 10,000.00), a draft sale order for X at S2. M1 = manager at S1, M2 = manager at S2
 * (no approve_buyer at S1), C = cashier at S1.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const registerPage = () => import('../../src/app/trade/orders/page');
const orderPage = () => import('../../src/app/trade/orders/[id]/page');
const tradeLib = () => import('../../src/app/trade/orders/lib');

async function formData(actor: { orgId: string; personId: string }): Promise<{ customers: { name: string }[] }> {
  const f = ((await tradeLib()) as Record<string, unknown>)['orderFormData'] as (a: unknown) => Promise<{ customers: { name: string }[] }>;
  if (typeof f !== 'function') throw new Error('orderFormData is not exported');
  const byOrg = await f(actor.orgId).catch(() => null);
  if (byOrg && Array.isArray(byOrg.customers)) return byOrg;
  return f(actor);
}

describe('T-435 S4 trade - case 32: the loader never sends a credit limit to the browser (M32)', () => {
  for (const who of ['A', 'M1', 'C'] as const) {
    it(`orderFormData for ${who} has no creditLimit anywhere in the result`, async () => {
      const w = await world();
      const data = await formData(w[who]);
      const text = JSON.stringify(data);
      expect(text, 'a credit limit key is in the form data').not.toMatch(/creditLimit|credit_limit/i);
      expect(text, 'the limit value is in the form data').not.toMatch(/"10000(\.00)?"/);
    });
  }
  it('the form data is not empty for the admin (the check above is not vacuous)', async () => {
    const w = await world();
    const data = await formData(w.A);
    expect(data.customers.map((c) => c.name)).toContain(M.yName);
  });
});

describe('T-435 S4 trade - case 33: an order at a store is invisible to someone with no money/order role there (M33)', () => {
  const FORGED = '019a0000-0000-7000-8000-000000000003';
  // T-617: M2 holds the trade words (at S2), so passes the route gate and meets the per-order store check.
  it('M2 opens the S1 sale order for Y: the very same not-found as a forged id (no buyer, lines, totals, limit)', async () => {
    const w = await world();
    const forged = await pageError(() => render(orderPage, w.M2, { params: { id: FORGED } }));
    expect(forged).toBe('NEXT_NOT_FOUND');
    const real = await pageError(() => render(orderPage, w.M2, { params: { id: w.orderYS1 } }));
    expect(real, 'M2 must not be able to tell the order exists').toBe(forged);
  });
  // T-617: C holds no trade word, so the route gate answers first - the same refusal card for a real id and a forged one, none of the order on it.
  it('C opens the S1 sale order for Y: the route refusal, identical for a real id and a forged id (nothing of the order)', async () => {
    const w = await world();
    const forged = plain(await render(orderPage, w.C, { params: { id: FORGED } }));
    const real = plain(await render(orderPage, w.C, { params: { id: w.orderYS1 } }));
    expect(forged).toContain(M.refusedCard);
    expect(real).toBe(forged);
    expectAbsent(real, 'C order', M.yName, M.limit);
  });
  it('W1 (create_wholesale_order only, no approve_buyer) still sees the order, but not the credit limit', async () => {
    const w = await world();
    const html = await render(orderPage, w.W1, { params: { id: w.orderYS1 } });
    expectPresent(html, 'W1 order', M.yName);
    expect(plain(html)).not.toMatch(/10,000|10000[.]00/);
    expect(html).not.toContain('10,000');
  });
  it('the orderDetail loader does not return the order to C (null or a refusal)', async () => {
    const w = await world();
    const f = ((await tradeLib()) as Record<string, unknown>)['orderDetail'] as (a: unknown, id: string) => Promise<unknown>;
    const v = await f(w.C, w.orderYS1).catch(() => null);
    expect(v).toBeNull();
  });
});

describe('T-435 S4 trade - case 34: the manager of the order\'s store sees the limit and the override field (M34)', () => {
  it('M1 on the same order sees 10,000.00 and the override-reason field', async () => {
    const w = await world();
    const html = await render(orderPage, w.M1, { params: { id: w.orderYS1 } });
    expectPresent(html, 'M1 order', M.limit);
    expect(html, 'the override field').toContain('name="creditOverrideReason"');
  });
  it('A (admin of every store) sees it too', async () => {
    const w = await world();
    const html = await render(orderPage, w.A, { params: { id: w.orderYS1 } });
    expectPresent(html, 'A order', M.limit);
  });
});

describe('T-435 S4 trade - case 35: the register offers the viewer\'s stores only (M35)', () => {
  it('W1 (T-617: C no longer reaches the register) /trade/orders?store=<S2> is "This store is not available to you."', async () => {
    const w = await world();
    const html = await render(registerPage, w.W1, { search: { store: w.s2 } });
    expectNotAvailable(html, 'W1 /trade/orders?store=S2');
    expectAbsent(html, 'W1 /trade/orders?store=S2', M.s2Name, M.xName);
  });
  it('W1 /trade/orders lists S1 orders only: Y\'s order in, X\'s S2 order and S2 out', async () => {
    const w = await world();
    const html = await render(registerPage, w.W1);
    expectPresent(html, 'W1 /trade/orders', M.s1Name, M.yName);
    expectAbsent(html, 'W1 /trade/orders', M.s2Name, M.xName, w.s2, w.orderXS2);
  });
  it('T-617: C (no trade word) is refused at the register', async () => {
    const w = await world();
    expect(plain(await render(registerPage, w.C))).toContain(M.refusedCard);
  });
  it('M1 /trade/orders also offers S1 only', async () => {
    const w = await world();
    const html = await render(registerPage, w.M1);
    expectPresent(html, 'M1 /trade/orders', M.s1Name);
    expectAbsent(html, 'M1 /trade/orders', M.s2Name, w.s2);
  });
  it('A /trade/orders?store=<S2> shows the S2 order for X (positive control)', async () => {
    const w = await world();
    const html = await render(registerPage, w.A, { search: { store: w.s2 } });
    expectPresent(html, 'A /trade/orders S2', M.xName);
    expect(plain(html)).not.toContain(M.notAvailable);
  });
});
