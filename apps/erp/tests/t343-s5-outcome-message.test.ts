/**
 * T-343 S5.1b — M3, M4, and the auditor's CHANGES (2026-09-27): M5, M6.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5 Amendment R1 item 1.
 *
 * M3: `outcomeMessage` (new, `@/lib/constraint-messages`) turns a commissary `Outcome`'s failure arm
 * into a screen sentence — `errorMessage(Object.assign(new Error(result.reason), result.userReason ?
 * { userMessage: result.userReason } : {}))` — proved directly against the real module, no mocking.
 *
 * M4: `postMessageAction`'s `:106` guard must decode through `outcomeMessage`, never `result.reason`
 * raw. Follows `t343-s5-action-guard.test.ts`'s R7 pattern exactly: `next/navigation`'s `redirect`
 * mocked to capture the URL, `@shareat/domain`/`@shareat/db`/`@shareat/auth`/session/`../lib` mocked
 * so no real domain/db code runs, and `@/lib/constraint-messages` NOT mocked — the bare `@/...`
 * specifier is not resolved by the root `vitest.config.mts` (only `@shareat/*` workspace packages
 * are), so the mock below is a resolution shim forwarding to the real module by relative path;
 * `outcomeMessage`/`errorMessage` are exactly the functions M4 exists to exercise.
 *
 * M5/M6 (auditor's ruling, orchestrator option a): `actions.ts` carries TWO of its OWN pre-domain
 * guards — `:75` (order not found) and `:93` (not a party) — each a literal `{ reason }` with no
 * `userReason` of its own, independent of `messages.ts`'s copies of the same idea. M5 pins `:75`
 * against `goneSentence('order')` imported from `@shareat/db` (never a hand-typed copy). M6 pins
 * `:93` against the REAL domain `postOrderMessage`'s own not-a-party `userReason` (`vi.importActual`
 * — never a hand-typed copy either), so this file cannot pass by coincidence if the two independent
 * copies of that English sentence ever drift apart (the addendum's own concern).
 *
 * ⛔ Explicit 30000ms timeouts on M4-M6 (auditor finding: M4 hit the 5000ms default on a cold module
 * graph).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// ⛔ NOT `@shareat/db` (mocked below, on purpose — see the mock's own comment): a direct relative
// import of the dependency-free leaf (`packages/db/src/refusal.ts`'s own header: "value-import-free")
// so M5 gets the REAL `goneSentence` without dragging in the real `@shareat/db`/RLS module graph
// this file exists to avoid.
import { goneSentence } from '../../../packages/db/src/refusal';

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

// Overridable per-test (M6): the "which store is this actor scoped to" row `actions.ts`'s OWN
// `:89-93` guard reads BEFORE it ever calls the domain's `postOrderMessage`.
const scopeWhere = vi.fn<(...args: unknown[]) => Promise<{ storeId: string }[]>>(async () => [
  { storeId: 'branch-1' },
]);

// `actions.ts` imports `withOrgPrincipal`/`errorMessageOf` from its own `./lib`, which pulls
// `@shareat/db` and RLS wiring this test has no business standing up.
vi.mock('../src/app/commissary/orders/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) =>
    fn({ select: () => ({ from: () => ({ where: (...args: unknown[]) => scopeWhere(...args) }) }) }),
  errorMessageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// Overridable per-test (M5): `orderParties` — `actions.ts`'s OWN `:75` guard reads this BEFORE
// ever calling the domain's `postOrderMessage`.
const orderParties = vi.fn<
  (...args: unknown[]) => Promise<{ commissaryStoreId: string; branchStoreId: string } | null>
>(async () => ({ commissaryStoreId: 'com-1', branchStoreId: 'branch-1' }));
vi.mock('@shareat/db', async () => {
  // `actions.ts:75` itself now calls the real `goneSentence` (the auditor's CHANGES already landed
  // in the builder's source) — forwarded from the dependency-free leaf, same as this file's own
  // top-level import, never a second hand-typed copy.
  const { goneSentence } = await import('../../../packages/db/src/refusal');
  return {
    lowStockRepo: {
      orderParties: (...args: unknown[]) => orderParties(...args),
    },
    schema: { personStoreScope: {} },
    goneSentence,
  };
});

vi.mock('@shareat/auth', () => ({
  authorize: vi.fn(async () => undefined),
}));

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const GONE_ORDER_SENTENCE =
  'That order could not be found. Someone may have changed it — reload the page and try again.';

// Same shape a real `Outcome<T>` failure carries once the builder ships `userReason` (F1-style
// hand construction — this file never has to import the real `@shareat/domain` chain to get it).
const postOrderMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  ok: false,
  reason: `order ${U} does not exist`,
  userReason: GONE_ORDER_SENTENCE,
}));
vi.mock('@shareat/domain', () => ({
  postOrderMessage: (...args: unknown[]) => postOrderMessage(...args),
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
}));

// ⛔ NOT a stub — forwards to the real module (see file header).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

afterEach(() => {
  // ⛔ NOT `vi.restoreAllMocks()` — none of these are `vi.spyOn` on a real module, and restoring a
  // plain `vi.fn(impl)` created at module scope wipes its base implementation along with the call
  // history, breaking every test after the first one that uses it. Clear call history only.
  postOrderMessage.mockClear();
  orderParties.mockClear();
  scopeWhere.mockClear();
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

describe('M3 — outcomeMessage(result) never lets the raw id through', () => {
  it('a reason-only failure (no userReason yet) still redacts the UUID', async () => {
    const { outcomeMessage } = await import('../src/lib/constraint-messages');
    const shown = outcomeMessage({ ok: false, reason: `order ${U} does not exist` });
    expect(shown).not.toContain(U);
  });
});

describe('M4 — postMessageAction decodes to the userReason, never the raw reason', () => {
  it(
    'the decoded error param equals M1’s sentence exactly, no UUID',
    async () => {
      const { postMessageAction } = await import('../src/app/commissary/orders/[id]/actions');
      const fd = new FormData();
      fd.set('orderId', 'order-1');
      fd.set('body', 'two crates were short');

      const to = await expectRedirectTo(() => postMessageAction(fd));
      const url = new URL(to, 'http://localhost');
      const errorParam = url.searchParams.get('error');

      expect(errorParam).toBe(GONE_ORDER_SENTENCE);
      expect(errorParam).not.toContain(U);
    },
    30000,
  );
});

describe('M5 — postMessageAction’s OWN order-gone guard (actions.ts:75) matches goneSentence("order")', () => {
  it(
    'the decoded error param === goneSentence("order") (imported real, never hand-typed), no UUID',
    async () => {
      orderParties.mockResolvedValueOnce(null);

      const { postMessageAction } = await import('../src/app/commissary/orders/[id]/actions');
      const fd = new FormData();
      fd.set('orderId', 'order-1');
      fd.set('body', 'two crates were short');

      const to = await expectRedirectTo(() => postMessageAction(fd));
      const url = new URL(to, 'http://localhost');
      const errorParam = url.searchParams.get('error');

      expect(errorParam).toBe(goneSentence('order'));
    },
    30000,
  );
});

describe('M6 — postMessageAction’s OWN not-a-party guard (actions.ts:93) matches the domain’s own wording', () => {
  it(
    'the decoded error param === the REAL postOrderMessage’s not-a-party userReason (never a hand-typed copy)',
    async () => {
      // Derived from the REAL domain function, by its DIRECT relative path — never the
      // `@shareat/domain` barrel (mocked above), which re-exports the whole package (scheduler,
      // wastage, …) and drags in far more of `@shareat/db`'s real surface than this file's own
      // minimal mock covers. `messages.ts` itself imports only `lowStockRepo`/`goneSentence` from
      // `@shareat/db` (both mocked above), so no real database is touched. This is exactly the
      // domain copy `actions.ts`'s own `:93` must not drift from (the addendum's concern).
      const real = await import('../../../packages/domain/src/commissary/messages');
      const domainResult = await real.postOrderMessage({} as never, {
        orgId: 'org-1',
        orderId: 'order-1',
        body: 'hello',
        authorId: 'person-1',
        actorStoreIds: ['store-not-on-this-order'],
      });
      if (domainResult.ok) throw new Error('expected the real domain call to refuse (not a party)');
      const expectedSentence = domainResult.userReason;
      expect(expectedSentence, 'the domain function must itself carry a userReason to pin against').toBeDefined();

      // `actions.ts`'s OWN guard (:89-93) reads the actor's store scope BEFORE ever calling the
      // domain — force it to resolve to a store that is on NEITHER party, so :93 fires directly and
      // the mocked `postOrderMessage` above is never reached.
      scopeWhere.mockResolvedValueOnce([{ storeId: 'store-not-on-this-order' }]);

      const { postMessageAction } = await import('../src/app/commissary/orders/[id]/actions');
      const fd = new FormData();
      fd.set('orderId', 'order-1');
      fd.set('body', 'two crates were short');

      const to = await expectRedirectTo(() => postMessageAction(fd));
      const url = new URL(to, 'http://localhost');
      const errorParam = url.searchParams.get('error');

      expect(postOrderMessage).not.toHaveBeenCalled();
      expect(errorParam).toBe(expectedSentence);
    },
    30000,
  );
});
