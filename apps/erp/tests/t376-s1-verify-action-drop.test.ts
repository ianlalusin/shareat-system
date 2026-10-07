/**
 * T-376 S1 (DEF-581), W3b (X-1) - `verifyInvoiceAction` forwards the closed-month override ONLY when the bill's own
 * date is in a closed month, and drops it otherwise (defence in depth: `approveExpense` also ignores it for an open
 * month, so the integration leg W3 cannot tell "dropped by the action" from "forwarded and ignored").
 * `docs/tasks/376-ap-closed-month-and-screen-nits.md` S1, W3b.
 *
 * TESTER, not BUILDER. The DOMAIN is mocked: this file pins what the ACTION hands to `verifyInvoice` (its fifth
 * argument), nothing about posting. The invoice read, the gate, and the closed-month lookup are stubbed so the two
 * legs differ in the bill's date alone.
 *
 *   February invoice + a full, ticked override form -> verifyInvoice(..., undefined)   (Mutant: forward unconditionally -> red)
 *   January invoice  + the same form                -> verifyInvoice(..., { periodOverride: { reason, note } })
 *
 * Harness: `t343-s5-5m-remittance-rewrap.test.ts` (RedirectSignal, mocked session, the REAL `errorMessage` reached
 * through the unresolvable `@/` specifier, never a stub).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { paramsOf } from './helpers/flash-jar';

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
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'actor-1' })),
}));

vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));

// The screen's own org-principal wrapper just runs the callback with a stand-in transaction.
vi.mock('../src/app/ap/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/ap/lib')>();
  return { ...actual, withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}) };
});
vi.mock('../src/app/expenses/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/expenses/lib')>();
  return { ...actual, withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}) };
});

// January 2026 is the org's one closed month.
const JANUARY = { startsOn: '2026-01-01', endsOn: '2026-01-31', label: 'January 2026' };
vi.mock('../src/lib/period-override', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/period-override')>();
  return { ...actual, closedMonths: async () => [JANUARY] };
});
vi.mock('@/lib/period-override', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/period-override')>();
  return { ...actual, closedMonths: async () => [JANUARY] };
});

const INVOICE: { current: { id: string; storeId: string; invoiceDate: string; status: string } } = {
  current: { id: 'inv-1', storeId: 'store-1', invoiceDate: '2026-02-10', status: 'pending' },
};
vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  return { ...actual, apRepo: { ...actual.apRepo, getSupplierInvoiceById: async () => INVOICE.current } };
});
vi.mock('@shareat/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/auth')>();
  return { ...actual, authorize: vi.fn(async () => undefined) };
});

const verifyInvoiceMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/domain')>();
  return { ...actual, verifyInvoice: (...args: unknown[]) => verifyInvoiceMock(...args) };
});

beforeAll(async () => {
  await import('../src/app/ap/actions'); // the first import is slow; keep it out of the legs' 5 s budget
}, 60_000);

beforeEach(() => {
  verifyInvoiceMock.mockClear();
});

function form(): FormData {
  const fd = new FormData();
  fd.set('invoiceId', 'inv-1');
  for (const k of ['attestSupplier', 'attestInvoice', 'attestItems', 'attestPrice']) fd.set(k, 'on');
  fd.set('periodOverrideConfirm', 'on');
  fd.set('periodOverrideReason', 'late_supplier_invoice');
  fd.set('periodOverrideNote', 'Bill arrived in October');
  return fd;
}
async function submit(invoiceDate: string): Promise<string> {
  INVOICE.current = { id: 'inv-1', storeId: 'store-1', invoiceDate, status: 'pending' };
  const { verifyInvoiceAction } = await import('../src/app/ap/actions');
  try {
    await verifyInvoiceAction(form());
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => paramsOf(to).get(k);

describe('W3b - verifyInvoiceAction forwards the override only for a closed-month bill', () => {
  it('a FEBRUARY (open) bill with a full, ticked override: verifyInvoice is called once with NO options - Mutant: forward unconditionally -> red', async () => {
    const to = await submit('2026-02-10');

    expect(param(to, 'error'), `refused before reaching the domain: ${param(to, 'error')}`).toBeNull();
    expect(verifyInvoiceMock).toHaveBeenCalledTimes(1);
    const args = verifyInvoiceMock.mock.calls[0]!;
    expect(args[2], 'the invoice id the form named').toBe('inv-1');
    expect(args[4], 'the open-month bill must not carry the override into the domain').toBeUndefined();
  });

  it('a JANUARY (closed) bill with the same form: verifyInvoice is called once WITH the typed reason and note - positive control for the leg above, red on HEAD (options never passed)', async () => {
    const to = await submit('2026-01-10');

    expect(param(to, 'error'), `refused before reaching the domain: ${param(to, 'error')}`).toBeNull();
    expect(verifyInvoiceMock).toHaveBeenCalledTimes(1);
    const args = verifyInvoiceMock.mock.calls[0]!;
    expect(args[4]).toEqual({ periodOverride: { reason: 'late_supplier_invoice', note: 'Bill arrived in October' } });
  });
});
