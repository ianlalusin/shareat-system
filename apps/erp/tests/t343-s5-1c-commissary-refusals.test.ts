/**
 * T-343 S5.1c — C1-C9: the commissary order page's own refusal paths (DEF-445, DEF-446, part of
 * DEF-444). `docs/tasks/343-def-417-human-readable-refusals.md` §S5.1c.
 *
 * Same harness as `t343-s5-outcome-message.test.ts`: `next/navigation`'s `redirect` mocked to
 * capture the URL, `@shareat/db`/`@shareat/domain`/`@shareat/auth`/session mocked so no real
 * domain/db code runs. Unlike that file, `../src/app/commissary/orders/lib` is NEVER mocked itself
 * — only ITS dependencies are (`@shareat/db`, `@shareat/domain`, `../src/app/expenses/lib`,
 * `@/lib/constraint-messages`) — so `errorMessageOf` (C1-C3, C9's subject) and `withOrgPrincipal`
 * both run as the REAL `lib.ts` code, per the spec's own instruction ("Use the REAL errorMessageOf
 * for C1-C3 and C8").
 *
 * ⛔ Was red before the builder (DEF-445/446/444): `errorMessageOf` had two regex bypasses
 * (`lib.ts:47-49`) that returned a role/scope sentence instead of decoding the real `userMessage`
 * S2/S2b already attached (C1, C2, C8); `postMessageAction` wrapped nothing in try/catch, so an
 * `authorize()` refusal threw past the action into the framework's error boundary instead of
 * redirecting with a banner (C4); and a gone order's refusal redirected back to the SAME (now
 * 404-ing) order page instead of the list (C6, DEF-444's own live smoketest finding). C3/C5/C7/C9
 * are the negative halves — already true, or (C9) already red for the SAME reason C1/C2 are.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { goneSentence } from '../../../packages/db/src/refusal';
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

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));

// Overridable per-test: the actor's own store-scope rows, and the AuthorizationError `authorize()`
// throws — both `[id]/actions.ts` reads BEFORE (or instead of) calling the domain.
const scopeWhere = vi.fn<(...args: unknown[]) => Promise<{ storeId: string }[]>>(async () => [
  { storeId: 'branch-1' },
]);
const STUB_TX = { select: () => ({ from: () => ({ where: (...args: unknown[]) => scopeWhere(...args) }) }) };

const authorize = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock('@shareat/auth', async () => {
  const { AuthorizationError } = await import('../../../packages/auth/src/errors');
  const { signFlash, flashSignatureMatches } = await vi.importActual<typeof import('@shareat/auth')>('@shareat/auth');
  return {
    signFlash,
    flashSignatureMatches,
    authorize: (...args: unknown[]) => authorize(...args),
    AuthorizationError,
  };
});

// `commissary/orders/lib.ts` re-exports `withOrgPrincipal`/`listStores` from here — the heavy RLS
// chain this test has no business standing up. NOT `../src/app/commissary/orders/lib` itself,
// which stays the REAL module throughout this file (see file header).
vi.mock('../src/app/expenses/lib', () => ({
  listStores: vi.fn(async () => []),
  listActingPersons: vi.fn(async () => []),
  listActivePersons: vi.fn(async () => []),
  listCategoriesGrouped: vi.fn(async () => []),
  listActiveCategoriesGrouped: vi.fn(async () => []),
  categoryLabel: vi.fn(async () => ''),
  recordingRefusalsFor: async (_orgId: unknown, run: () => unknown) => run(),
  journalRepo: {},
  listMoneyAccountsForPicker: vi.fn(async () => []),
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn(STUB_TX),
}));

// Overridable per-test: `orderParties` — `[id]/actions.ts`'s OWN `:75` guard reads this BEFORE
// calling the domain's `postOrderMessage`.
const orderParties = vi.fn<
  (...args: unknown[]) => Promise<{ commissaryStoreId: string; branchStoreId: string } | null>
>(async () => ({ commissaryStoreId: 'com-1', branchStoreId: 'branch-1' }));
vi.mock('@shareat/db', async () => {
  const { goneSentence: real } = await import('../../../packages/db/src/refusal');
  return {
    lowStockRepo: { orderParties: (...args: unknown[]) => orderParties(...args) },
    schema: { personStoreScope: {} },
    goneSentence: real,
    // `lib.ts`'s own imports, unused at runtime by anything these legs exercise.
    commissaryRepo: {},
    itemsRepo: {},
    stockLocationsRepo: {},
    tradeRepo: {},
  };
});

const postOrderMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, id: 'msg-1' }));
const saveBranchOrderDraft = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  orderId: 'order-1',
  totalAmount: '0.00',
}));
vi.mock('@shareat/domain', () => ({
  assertFieldRules: () => ({}),
  postOrderMessage: (...args: unknown[]) => postOrderMessage(...args),
  saveBranchOrderDraft: (...args: unknown[]) => saveBranchOrderDraft(...args),
  acceptOrder: vi.fn(),
  addBranchOrderLine: vi.fn(),
  decideProposedLine: vi.fn(),
  dispatchBranchOrder: vi.fn(),
  fulfilLine: vi.fn(),
  markReady: vi.fn(),
  proposeLine: vi.fn(),
  receiveTradeOrder: vi.fn(),
  rejectOrder: vi.fn(),
  removeBranchOrderLine: vi.fn(),
  submitOrder: vi.fn(),
  voidTradeOrder: vi.fn(),
  // `lib.ts`'s own imports.
  BRANCH_ORDER_STAGE_LABEL: {},
  branchOrderStage: vi.fn(),
  orderableCatalogue: vi.fn(async () => []),
}));

// ⛔ NOT a stub — forwards to the real module (see `t343-s5-outcome-message.test.ts`'s identical
// comment: the bare `@/...` specifier is not resolved by the root `vitest.config.mts`).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

afterEach(() => {
  authorize.mockClear();
  scopeWhere.mockClear();
  orderParties.mockClear();
  postOrderMessage.mockClear();
  saveBranchOrderDraft.mockClear();
  revalidatePath.mockClear();
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

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

describe('C1 — errorMessageOf decodes an AuthorizationError’s userMessage (row 5 shape)', () => {
  it(
    '=== S, not "Your role may not …"',
    async () => {
      const { errorMessageOf } = await import('../src/app/commissary/orders/lib');
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'You cannot fulfil a branch order right now.';
      const err = new AuthorizationError(
        "authorize: role 'staff' may not 'fulfil_branch_order'",
        'fulfil_branch_order' as never,
        S,
      );
      expect(errorMessageOf(err)).toBe(S);
    },
    30000,
  );
});

describe('C2 — errorMessageOf decodes an AuthorizationError’s userMessage (row 2 shape)', () => {
  it(
    '=== S, not the local "You are not assigned…" sentence',
    async () => {
      const { errorMessageOf } = await import('../src/app/commissary/orders/lib');
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = "You aren't assigned to SmokeStore (SMK), so you can't fulfil a branch order there.";
      const err = new AuthorizationError(
        `authorize: person p1 (role 'staff') has no store scope for ${U}`,
        'fulfil_branch_order' as never,
        S,
      );
      expect(errorMessageOf(err)).toBe(S);
    },
    30000,
  );
});

describe('C3 (⛔) — a plain Error with no userMessage still falls through to errorMessage(err)', () => {
  it(
    'green now and after: equals errorMessage(err), no UUID',
    async () => {
      const { errorMessageOf } = await import('../src/app/commissary/orders/lib');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const err = new Error(`someFn: something went wrong with ${U}`);
      const decoded = errorMessageOf(err);
      expect(decoded).toBe(errorMessage(err));
      expect(decoded).not.toContain(U);
    },
    30000,
  );
});

describe('C4 — postMessageAction catches an AuthorizationError and shows its userMessage', () => {
  it(
    'redirects to /commissary/orders/order-1 with error === S (today: throws, no redirect)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'You cannot post a message on this order.';
      authorize.mockRejectedValueOnce(
        new AuthorizationError("authorize: role 'staff' may not 'post_order_message'", 'post_order_message' as never, S),
      );

      const { postMessageAction } = await import('../src/app/commissary/orders/[id]/actions');
      const fd = new FormData();
      fd.set('orderId', 'order-1');
      fd.set('body', 'hello');

      const to = await expectRedirectTo(() => postMessageAction(fd));
      const url = urlOf(to);
      expect(url.pathname).toBe('/commissary/orders/order-1');
      expect(url.searchParams.get('error')).toBe(S);
    },
    30000,
  );
});

describe('C5 (⛔) — postMessageAction succeeds: one post, one revalidate, no redirect', () => {
  it(
    'green now and after',
    async () => {
      const { postMessageAction } = await import('../src/app/commissary/orders/[id]/actions');
      const fd = new FormData();
      fd.set('orderId', 'order-1');
      fd.set('body', 'hello');

      await postMessageAction(fd);

      expect(postOrderMessage).toHaveBeenCalledTimes(1);
      expect(revalidatePath).toHaveBeenCalledWith('/commissary/orders/order-1');
    },
    30000,
  );
});

describe('C6 — DEF-444: a gone order redirects to the LIST, not the dead page', () => {
  it(
    'pathname === /commissary/orders, error === goneSentence("order") (today: still the dead page)',
    async () => {
      orderParties.mockResolvedValueOnce(null);

      const { postMessageAction } = await import('../src/app/commissary/orders/[id]/actions');
      const fd = new FormData();
      fd.set('orderId', 'order-1');
      fd.set('body', 'hello');

      const to = await expectRedirectTo(() => postMessageAction(fd));
      const url = urlOf(to);
      expect(url.pathname).toBe('/commissary/orders');
      expect(url.searchParams.get('error')).toBe(goneSentence('order'));
    },
    30000,
  );
});

describe('C7 (⛔) — not-a-party stays on the order page, never the list', () => {
  it(
    'green now and after',
    async () => {
      scopeWhere.mockResolvedValueOnce([{ storeId: 'store-not-on-this-order' }]);

      const { postMessageAction } = await import('../src/app/commissary/orders/[id]/actions');
      const fd = new FormData();
      fd.set('orderId', 'order-1');
      fd.set('body', 'hello');

      const to = await expectRedirectTo(() => postMessageAction(fd));
      const url = urlOf(to);
      expect(url.pathname).toBe('/commissary/orders/order-1');
    },
    30000,
  );
});

describe('C8 — createOrderAction (orders/actions.ts) decodes an AuthorizationError’s userMessage', () => {
  it(
    'error === S (today: "Your role may not place branch order.")',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'You cannot place an order for this branch.';
      saveBranchOrderDraft.mockRejectedValueOnce(
        new AuthorizationError("authorize: role 'staff' may not 'place_branch_order'", 'place_branch_order' as never, S),
      );

      const { createOrderAction } = await import('../src/app/commissary/orders/actions');
      const fd = new FormData();
      fd.set('branchStoreId', 'branch-1');
      fd.set('commissaryStoreId', 'com-1');
      fd.set('orderDate', '2026-09-27');

      const to = await expectRedirectTo(() => createOrderAction(fd));
      const url = urlOf(to);
      expect(url.searchParams.get('error')).toBe(S);
    },
    30000,
  );
});

describe('C9 — lib.ts source no longer contains the two regex bypasses', () => {
  it(
    'contains neither "may not \'" nor "no store scope" (today: contains both)',
    () => {
      const src = readFileSync(
        join(import.meta.dirname, '..', 'src', 'app', 'commissary', 'orders', 'lib.ts'),
        'utf8',
      );
      expect(src).not.toContain("may not '");
      expect(src).not.toContain('no store scope');
    },
    30000,
  );
});
