import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-374 S2 / DEF-577 - the four POSTED dates in the returns server actions. They have no clock seam by design (the
 * spec forbids adding one), so the proof here fakes `Date` and captures what the action hands the domain:
 *   inventory/returns/actions.ts:43   recordReturn.returnedOn
 *   inventory/returns/actions.ts:90   refundSupplierCredit.businessDate
 *   trade/returns/actions.ts:39       recordCustomerReturn.returnedOn
 *   trade/returns/actions.ts:84       applyCredit.collectionDate
 * At 02:00 Manila on the 1st each posts to YESTERDAY (last month's last day) on HEAD.
 *
 * ⭐ RED FIRST on HEAD. Positive control: at 12:00 Manila both calendars give the same date, so it must pass before
 * and after.
 */
const captured: Record<string, unknown> = {};
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`redirect:${u}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../src/lib/session', () => ({ requireActor: async () => ({ orgId: 'org', personId: 'p' }) }));
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: async (_org: string, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/lib/constraint-messages', () => ({ errorMessage: (e: unknown) => String(e) }));
vi.mock('@shareat/domain', () => ({
  recordReturn: async (_tx: unknown, i: { returnedOn: string }) => ((captured.supplierReturnedOn = i.returnedOn), { ok: true }),
  refundSupplierCredit: async (_tx: unknown, i: { businessDate: string }) => ((captured.refundBusinessDate = i.businessDate), { ok: true }),
  voidReturn: async () => ({ ok: true }),
  recordCustomerReturn: async (_tx: unknown, i: { returnedOn: string }) => ((captured.customerReturnedOn = i.returnedOn), { ok: true }),
  applyCredit: async (_tx: unknown, _a: unknown, i: { collectionDate: string }) => ((captured.collectionDate = i.collectionDate), { ok: true }),
  voidCustomerReturn: async () => ({ ok: true }),
}));

import * as supplier from '../src/app/inventory/returns/actions';
import * as customer from '../src/app/trade/returns/actions';

const MANILA_2AM_APR_1 = new Date('2026-03-31T18:00:00Z');
const MANILA_NOON_APR_1 = new Date('2026-04-01T04:00:00Z');

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/** T-376 S2 (X-4): the two supplier actions now end in a redirect. Swallow ONLY that; rethrow anything else. */
async function untilRedirect(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    if (err instanceof Error && /^redirect:/.test(err.message)) return;
    throw err;
  }
}

async function runAll() {
  await untilRedirect(() => supplier.recordReturnAction(fd({ storeId: 's', supplierId: 'x', itemId: 'i', itemKind: 'raw_material', locationId: 'l', quantity: '1', reason: 'r' })));
  await untilRedirect(() => supplier.refundCreditAction(fd({ storeId: 's', supplierId: 'x', moneyAccountId: 'm', amount: '1.00' })));
  await untilRedirect(() => customer.recordReturnAction(fd({ tradeOrderId: 't', tradeOrderLineId: 'l', quantity: '1', reason: 'r' })));
  await untilRedirect(() => customer.applyCreditAction(fd({ tradeOrderId: 't', moneyAccountId: 'm', amount: '1.00' })));
}

beforeEach(() => {
  for (const k of Object.keys(captured)) delete captured[k];
});
afterEach(() => vi.useRealTimers());

describe('the four posted dates are the Manila business date', () => {
  it('02:00 Manila on 1 April posts 2026-04-01 at all four sites (HEAD: 2026-03-31)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: MANILA_2AM_APR_1 });
    await runAll();
    expect(captured).toEqual({
      supplierReturnedOn: '2026-04-01',
      refundBusinessDate: '2026-04-01',
      customerReturnedOn: '2026-04-01',
      collectionDate: '2026-04-01',
    });
  });

  it.each([
    ['supplier return returnedOn', 'supplierReturnedOn'],
    ['supplier credit refund businessDate', 'refundBusinessDate'],
    ['customer return returnedOn', 'customerReturnedOn'],
    ['customer credit collectionDate', 'collectionDate'],
  ])('%s: 02:00 Manila on 1 April is not last month', async (_n, key) => {
    vi.useFakeTimers({ toFake: ['Date'], now: MANILA_2AM_APR_1 });
    await runAll();
    expect(captured[key], key).toBe('2026-04-01');
  });

  it('CONTROL: at 12:00 Manila both calendars agree, so the date is 2026-04-01 before and after the fix', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: MANILA_NOON_APR_1 });
    await runAll();
    expect(Object.values(captured)).toEqual(['2026-04-01', '2026-04-01', '2026-04-01', '2026-04-01']);
  });

  it('CONTROL (harness not vacuous): the captured values really come from the actions', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-09T04:00:00Z') });
    await runAll();
    expect(captured.supplierReturnedOn).toBe('2026-07-09');
  });
});
