/**
 * T-380 S4 (unit, mocked domain) - what the S4 actions put in the page address and in the flash.
 * docs/tasks/380-no-typed-values-in-urls.md S4 (R7, R10, REV-8, B2, W-B3). TESTER, not BUILDER.
 *
 * Every leg reads the RAW redirect URL as well as `outcomeOf`: `outcomeOf` falls back to the URL until S6, so a flash
 * assertion alone passes on HEAD. State on HEAD (S4 not built): every leg that asserts the URL is clean is RED, because
 * the banner rides in `?error=` / `?ok=`.
 *
 *  B2-c  commissary createOrderAction: the draft's total is in the banner, not the URL.   RED on HEAD.
 *        Mutant: put `ok` back in a `?`-template -> red.
 *  B2-t  trade createOrderAction, same.                                                    RED on HEAD. Same mutant.
 *  W-B3  settings/expense-categories rename + create: the typed name is in the banner, not the URL.  RED on HEAD.
 *        Mutant: keep `back({ ok: ... })` for one action -> that leg red.
 *  R7    guard clauses (REV-8): trade/returns :63 :85 :112 and commissary/discrepancies :67 :95. The domain answers
 *        `{ok:false}`; the person must get the refusal and NOTHING after it may run (no revalidate, no success banner).
 *        RED on HEAD (the sentence rides in the URL). Mutant: drop `await` (or `return`) on the guard-clause call -> the
 *        success redirect and `revalidatePath` run -> red.
 *  N-keep the `store` nav key survives a refusal (a uuid); a non-uuid `store` is dropped (RED on HEAD).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { captureRedirect, nextNavigationMock } from './helpers/flash-jar-core';
import { outcomeOf } from './helpers/flash-jar';

vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());
const revalidate = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath: revalidate }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('../src/app/settings/expense-categories/lib', () => ({ withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('../src/app/trade/orders/lib', () => ({
  peso: (v: unknown) => `₱${String(v)}`,
  withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../src/app/commissary/orders/lib', async () => {
  const messages = await import('../src/lib/constraint-messages');
  return {
    peso: (v: unknown) => `₱${String(v)}`,
    withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}),
    errorMessageOf: (e: unknown) => messages.errorMessage(e),
  };
});
vi.mock('@shareat/auth', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), authorize: vi.fn(async () => undefined) }));

const d = vi.hoisted(() => ({
  recordCustomerReturn: vi.fn(),
  voidCustomerReturn: vi.fn(),
  applyCredit: vi.fn(),
  createTradeOrder: vi.fn(),
  saveBranchOrderDraft: vi.fn(),
  resolveDiscrepancy: vi.fn(),
  deferDiscrepancy: vi.fn(),
  renameCategory: vi.fn(),
  createCategory: vi.fn(),
}));
vi.mock('@shareat/domain', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...d }));

beforeAll(async () => {
  await import('@shareat/domain');
}, 60_000);
afterEach(() => {
  vi.clearAllMocks();
});

void nextNavigationMock;
const STORE = '3f2b8c1e-7a4d-4e5b-9c61-0d2e8a7b5f10';
const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
async function run(fn: (fd: FormData) => Promise<void>, fd: FormData) {
  const signal = await captureRedirect(() => fn(fd));
  return { raw: signal.url, out: outcomeOf(signal) };
}
const decoded = (raw: string): string => decodeURIComponent(raw.replace(/\+/g, ' '));

describe('B2 - a draft order total leaves the address', () => {
  it('B2-c commissary createOrderAction: the banner says the total, the URL does not', async () => {
    d.saveBranchOrderDraft.mockResolvedValue({ orderId: 'ord-1', totalAmount: '1234.50' });
    const { createOrderAction } = await import('../src/app/commissary/orders/actions');
    const { raw, out } = await run(createOrderAction, form({ branchStoreId: STORE, commissaryStoreId: STORE, orderDate: '2026-10-01', itemId: 'i1', quantity: '2' }));
    expect(out.path).toBe('/commissary/orders/ord-1');
    expect(out.flash.ok, 'the banner keeps its words').toBe('Draft saved at ₱1234.50. Add or change lines, then submit it to the commissary.');
    expect(decoded(raw), `the address must not carry the banner or the total (saw: ${raw})`).not.toMatch(/1234|₱|Draft saved|ok=/);
  });

  it('B2-t trade createOrderAction: same', async () => {
    d.createTradeOrder.mockResolvedValue({ orderId: 'ord-2', totalAmount: '99999.99' });
    const { createOrderAction } = await import('../src/app/trade/orders/actions');
    const { raw, out } = await run(createOrderAction, form({ storeId: STORE, customerId: 'c1', orderDate: '2026-10-01', itemId: 'i1', quantity: '2' }));
    expect(out.path).toBe('/trade/orders/ord-2');
    expect(out.flash.ok).toBe('Draft saved at ₱99999.99. Nothing has posted — dispatch is the event that bills and moves stock.');
    expect(decoded(raw), `the address must not carry the banner or the total (saw: ${raw})`).not.toMatch(/99999|₱|Draft saved|ok=/);
  });

  it('B2-t refusal: a refused draft keeps `store` (a uuid) and loses the sentence', async () => {
    d.createTradeOrder.mockRejectedValue(new Error('"2,0OO" is not a valid quantity.'));
    const { createOrderAction } = await import('../src/app/trade/orders/actions');
    const { raw, out } = await run(createOrderAction, form({ storeId: STORE, customerId: 'c1', orderDate: '2026-10-01', itemId: 'i1', quantity: '2,0OO' }));
    expect(out.path).toBe('/trade/orders');
    expect(out.nav.get('store')).toBe(STORE);
    expect(out.flash.error, 'the person is still told').toBeTruthy();
    expect(decoded(raw), `the typed quantity must not be in the address (saw: ${raw})`).not.toMatch(/2,0OO|error=/);
  });
});

describe('W-B3 - a typed category name leaves the address', () => {
  const NAME = 'Pa-load ni Boss';
  it('rename: the banner names it, the URL does not', async () => {
    d.renameCategory.mockResolvedValue(undefined);
    const { renameCategoryAction } = await import('../src/app/settings/expense-categories/actions');
    const { raw, out } = await run(renameCategoryAction, form({ categoryId: 'cat-1', category: NAME }));
    expect(out.path).toBe('/settings/expense-categories');
    expect(out.flash.ok).toBe(`Renamed to "${NAME}". Everything already recorded in it stays where it is.`);
    expect(decoded(raw), `the name must not be in the address (saw: ${raw})`).not.toMatch(/Pa-load|Boss|ok=/);
  });

  it('create: the banner names it, the URL does not', async () => {
    d.createCategory.mockResolvedValue(undefined);
    const { createCategoryAction } = await import('../src/app/settings/expense-categories/actions');
    const { raw, out } = await run(createCategoryAction, form({ category: NAME, group: 'OPEX', accountCode: '' }));
    expect(out.flash.ok).toBe(`"${NAME}" added. It has no account yet, so expenses in it will not post until one is set.`);
    expect(decoded(raw), `the name must not be in the address (saw: ${raw})`).not.toMatch(/Pa-load|Boss|ok=/);
  });

  it('a refused rename whose sentence quotes the typed name: the sentence is in the flash only', async () => {
    d.renameCategory.mockRejectedValue(new Error(`Another category is already called "${NAME}".`));
    const { renameCategoryAction } = await import('../src/app/settings/expense-categories/actions');
    const { raw, out } = await run(renameCategoryAction, form({ categoryId: 'cat-1', category: NAME }));
    expect(out.flash.error).toBeTruthy();
    expect(decoded(raw), `saw: ${raw}`).not.toMatch(/Pa-load|Boss|error=/);
  });
});

describe('R7 / REV-8 - a guard clause that refuses stops everything after it', () => {
  const REASON = 'That return was already voided.';

  async function refused(call: () => Promise<{ raw: string; out: ReturnType<typeof outcomeOf> }>) {
    const { raw, out } = await call();
    expect(out.flash.error, 'the person gets the refusal').toBeTruthy();
    expect(out.flash.ok, 'no success banner may follow a refusal').toBeUndefined();
    expect(revalidate, 'nothing after the guard clause may run').not.toHaveBeenCalled();
    expect(decoded(raw), `the refusal must not ride in the address (saw: ${raw})`).not.toMatch(/already voided|error=|ok=/);
    return out;
  }

  it('trade/returns recordReturnAction :63 ({ok:false}); `store` survives', async () => {
    d.recordCustomerReturn.mockResolvedValue({ ok: false, reason: REASON });
    const { recordReturnAction } = await import('../src/app/trade/returns/actions');
    const out = await refused(() => run(recordReturnAction, form({ tradeOrderId: 'o1', tradeOrderLineId: 'l1', quantity: '3', reason: 'Spoiled', store: STORE })));
    expect(out.path).toBe('/trade/returns');
    expect(out.nav.get('store')).toBe(STORE);
  });

  it('trade/returns voidReturnAction :85 ({ok:false})', async () => {
    d.voidCustomerReturn.mockResolvedValue({ ok: false, reason: REASON });
    const { voidReturnAction } = await import('../src/app/trade/returns/actions');
    await refused(() => run(voidReturnAction, form({ returnId: 'r1', reason: 'Typed wrong', store: STORE })));
  });

  it('trade/returns applyCreditAction :112 ({ok:false}); the typed amount is not in the address', async () => {
    d.applyCredit.mockResolvedValue({ ok: false, reason: REASON });
    const { applyCreditAction } = await import('../src/app/trade/returns/actions');
    const { raw, out } = await run(applyCreditAction, form({ tradeOrderId: 'o1', moneyAccountId: 'a1', amount: '7,777.77', store: STORE }));
    expect(out.flash.error).toBeTruthy();
    expect(out.flash.ok).toBeUndefined();
    expect(decoded(raw)).not.toMatch(/7,777|7777|error=/);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('trade/returns: a thrown refusal is shown too, and a non-uuid `store` is dropped', async () => {
    d.recordCustomerReturn.mockRejectedValue(new Error(REASON));
    const { recordReturnAction } = await import('../src/app/trade/returns/actions');
    const { raw, out } = await run(recordReturnAction, form({ tradeOrderId: 'o1', tradeOrderLineId: 'l1', quantity: '3', reason: 'Spoiled', store: 'Call 0917 now' }));
    expect(out.flash.error).toBeTruthy();
    expect(out.nav.get('store'), 'a typed `store` that is not an id never reaches the address').toBeNull();
    expect(decoded(raw)).not.toMatch(/0917|error=/);
  });

  it('commissary/discrepancies resolveDiscrepancyAction :67 ({ok:false}); `store` survives', async () => {
    d.resolveDiscrepancy.mockResolvedValue({ ok: false, reason: 'already resolved as loss' });
    const { resolveDiscrepancyAction } = await import('../src/app/commissary/discrepancies/actions');
    const { raw, out } = await run(resolveDiscrepancyAction, form({ storeId: STORE, id: 'd1', disposition: 'loss' }));
    expect(out.path).toBe('/commissary/discrepancies');
    expect(out.nav.get('store')).toBe(STORE);
    expect(out.flash.error, 'the person gets the refusal').toBeTruthy();
    expect(revalidate, 'nothing after the guard clause may run').not.toHaveBeenCalled();
    expect(decoded(raw), `saw: ${raw}`).not.toMatch(/already resolved|error=/);
  });

  it('commissary/discrepancies deferDiscrepancyAction :95 ({ok:false}) - result.reason reaches the flash', async () => {
    d.deferDiscrepancy.mockResolvedValue({ ok: false, reason: 'Pick a later date.' });
    const { deferDiscrepancyAction } = await import('../src/app/commissary/discrepancies/actions');
    const { raw, out } = await run(deferDiscrepancyAction, form({ storeId: STORE, id: 'd1', deferredTo: '2026-10-01' }));
    expect(out.flash.error).toBe('Pick a later date.');
    expect(revalidate).not.toHaveBeenCalled();
    expect(decoded(raw)).not.toMatch(/Pick a later|error=/);
  });

  it('control: an accepted resolve still revalidates and ends with no banner (green on HEAD)', async () => {
    d.resolveDiscrepancy.mockResolvedValue({ ok: true });
    const { resolveDiscrepancyAction } = await import('../src/app/commissary/discrepancies/actions');
    const { out } = await run(resolveDiscrepancyAction, form({ storeId: STORE, id: 'd1', disposition: 'loss' }));
    expect(out.flash.error).toBeUndefined();
    expect(revalidate).toHaveBeenCalledWith('/commissary/discrepancies');
  });
});
