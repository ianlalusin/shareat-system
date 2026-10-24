/**
 * T-343 S5.2 — P5 (auditor CHANGES, 2026-09-27): `verifyInvoice`'s draft-expense rewrap
 * (`packages/domain/src/ap/index.ts`) must keep an `AuthorizationError`'s OWN `userMessage`, not
 * fall back to the generic "This invoice could not be verified…" sentence.
 *
 * `approveExpense`'s cross-store `transfer_funds` gate throws an `AuthorizationError` (S2's own
 * `userMessage`), and the rewrap's `err instanceof RefusalError` check is false for it — an
 * `AuthorizationError` is a sibling class, not a `RefusalError` — so it fell through to the
 * generic fallback, discarding a perfectly good, specific sentence.
 *
 * Unit-level (mocked `approveExpense`), per the auditor's own suggestion: a real cross-store
 * `transfer_funds` fixture needs a second store, a second money account and a capability-scope
 * setup on top of `ap.test.ts`'s existing fixture, for one rewrap line — the mock proves the same
 * control-flow defect without that weight.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shareat/auth', async () => {
  const { AuthorizationError } = await import('../../auth/src/errors');
  return {
    authorize: vi.fn(async () => undefined),
    AuthorizationError,
  };
});

const approveExpense = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../src/expenses/approve', () => ({
  approveExpense: (...args: unknown[]) => approveExpense(...args),
}));

vi.mock('../src/expenses/create', () => ({ createExpense: vi.fn() }));
vi.mock('../src/expenses/void', () => ({ voidExpense: vi.fn() }));
vi.mock('../src/expenses/delete', () => ({ deleteExpenseDraft: vi.fn() }));
vi.mock('../src/items', () => ({ validateInvoiceLines: vi.fn() }));
vi.mock('../src/ledger/post-entry', () => ({ postEntry: vi.fn() }));
vi.mock('../src/ledger/reverse-entry', () => ({ reverseEntry: vi.fn() }));
vi.mock('../src/money-accounts/overdraft', () => ({ checkDraw: vi.fn() }));
vi.mock('../src/shared/money-input', () => ({ parseMoneyInput: vi.fn() }));
vi.mock('../src/shared/allocate-oldest-first', () => ({ allocateOldestFirst: vi.fn() }));

const getSupplierInvoiceById = vi.fn();
const getSupplierById = vi.fn();
const markInvoiceVerified = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
const liveExpensesForInvoice = vi.fn();
vi.mock('@shareat/db', async () => {
  // `../shared/refusal` (real, not mocked) itself imports `RefusalError`/`refuse`/`goneSentence`
  // from `@shareat/db` — forwarded here from the dependency-free leaf, never a second hand-typed
  // copy (same posture as `apps/erp/tests/t343-s5-outcome-message.test.ts`).
  const real = await import('../../db/src/refusal');
  return {
    apRepo: {
      AP_CONTROL_CODE: '2110',
      ADVANCES_CODE: '1290',
      getSupplierInvoiceById: (...args: unknown[]) => getSupplierInvoiceById(...args),
      getSupplierById: (...args: unknown[]) => getSupplierById(...args),
      markInvoiceVerified: (...args: unknown[]) => markInvoiceVerified(...args),
      liveExpensesForInvoice: (...args: unknown[]) => liveExpensesForInvoice(...args),
    },
    itemsRepo: {},
    expensesRepo: {},
    filesRepo: {},
    moneyAccountsRepo: {},
    transaction: async (fn: (tx: unknown) => unknown) => fn({}),
    RefusalError: real.RefusalError,
    refuse: real.refuse,
    goneSentence: real.goneSentence,
  };
});

afterEach(() => {
  approveExpense.mockClear();
  getSupplierInvoiceById.mockClear();
  getSupplierById.mockClear();
  markInvoiceVerified.mockClear();
  liveExpensesForInvoice.mockClear();
});

describe('P5 — verifyInvoice keeps an AuthorizationError’s own userMessage, not the generic fallback', () => {
  it(
    'the rewrap userMessage === the AuthorizationError’s sentence (today: the generic "could not be verified")',
    async () => {
      const { verifyInvoice } = await import('../src/ap/index');
      const { AuthorizationError } = await import('../../auth/src/errors');

      getSupplierInvoiceById.mockResolvedValue({
        id: 'inv-1',
        storeId: 'store-1',
        status: 'pending',
        createdBy: 'other-person',
        supplierId: 'sup-1',
      });
      // A commissary-mirror supplier skips the receipt-photo branch entirely — irrelevant to this
      // leg, which is about the draft-expense rewrap further down.
      getSupplierById.mockResolvedValue({
        id: 'sup-1',
        name: 'Acme',
        status: 'active',
        counterpartyStoreId: 'mirror-store-1',
      });
      liveExpensesForInvoice.mockResolvedValue([{ id: 'exp-1', status: 'draft' }]);

      const S = 'You cannot move money out of Malvar’s till from here.';
      approveExpense.mockRejectedValue(
        new AuthorizationError("authorize: role 'staff' may not 'transfer_funds'", 'transfer_funds' as never, S),
      );

      const caught = await verifyInvoice({} as never, { personId: 'p1', orgId: 'org-1' }, 'inv-1', {
        supplier: true,
        invoice: true,
        items: true,
        price: true,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(caught, 'verifyInvoice should have refused').not.toBeNull();
      const userMessage = (caught as { userMessage?: string }).userMessage;
      expect(userMessage).toBe(S);
    },
    30000,
  );
});
