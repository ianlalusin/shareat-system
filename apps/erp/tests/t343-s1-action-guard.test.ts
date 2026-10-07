/**
 * T-343 S1 — R7: a real page guard, end to end, never lets a raw UUID reach the `?error=` URL.
 * docs/tasks/343-def-417-human-readable-refusals.md §S1.
 *
 * Uses `createSupplierAction` (`apps/erp/src/app/ap/actions.ts:92`) exactly as the spec names it,
 * mocking `next/navigation`'s `redirect` to capture the URL instead of throwing Next's internal
 * signal (same posture as `apps/erp/tests/t337-access-defaults-actions.test.ts`).
 *
 * ⛔ **Per the briefing: do NOT mock `@/lib/constraint-messages` with a stub.** `errorMessage` is
 * exactly the function under test here — replacing it with a passthrough would make this file
 * incapable of ever failing for the right reason. The bare `@/...` specifier is not resolved by the
 * root `vitest.config.mts` (only `@shareat/*` workspace packages are — see
 * `t337-access-defaults-actions.test.ts`'s own comment on the same gap), so the mock below forwards
 * to the REAL module by its relative path — a resolution shim, not a stub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { urlOf } from './helpers/flash-jar';

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

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));

// `ap/actions.ts` imports `withOrgPrincipal`/`INVOICE_LINE_ROWS` from its own `./lib`, which itself
// pulls `@shareat/db` and RLS wiring this test has no business standing up.
vi.mock('../src/app/ap/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  INVOICE_LINE_ROWS: 5,
}));

vi.mock('@shareat/db', () => ({
  apRepo: {},
}));

vi.mock('@shareat/domain/money-input', () => ({
  parseMoneyInput: (v: string) => v,
}));

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

const createSupplier = vi.fn<(...args: unknown[]) => Promise<never>>(async () => {
  throw new Error(`createSupplier: org ${U} does not exist`);
});
vi.mock('@shareat/domain', () => ({
  createSupplier: (...args: unknown[]) => createSupplier(...args),
  editSupplier: vi.fn(),
  recordInvoice: vi.fn(),
  setInvoiceLines: vi.fn(),
  uploadFile: vi.fn(),
  verifyInvoice: vi.fn(),
  voidInvoice: vi.fn(),
  recordPayment: vi.fn(),
  voidPayment: vi.fn(),
  suggestPaymentAllocation: vi.fn(),
}));

// ⛔ NOT a stub — forwards to the real module (see file header). `errorMessage`'s own redaction is
// exactly what this test exists to exercise.
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

afterEach(() => {
  vi.restoreAllMocks();
  createSupplier.mockClear();
});

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

describe('R7 — createSupplierAction never puts a raw UUID in the ?error= URL', () => {
  it('the decoded error param has no UUID, even though the domain threw one', async () => {
    const { createSupplierAction } = await import('../src/app/ap/actions');
    const formData = new FormData();
    formData.set('name', 'Acme Trading');

    const to = await expectRedirectTo(() => createSupplierAction(formData));
    const url = urlOf(to);
    const errorParam = url.searchParams.get('error');

    expect(errorParam).not.toBeNull();
    expect(errorParam).not.toContain(U);
  });
});
