/**
 * T-343 S5.1 — A1, and E6's app-level half. `docs/tasks/343-def-417-human-readable-refusals.md`
 * §S5.1 table.
 *
 * A1 follows `t343-s1-action-guard.test.ts`'s R7 pattern exactly: `next/navigation`'s `redirect`
 * mocked to capture the URL, `@shareat/domain` mocked so no real domain/db code runs, and
 * `@/lib/constraint-messages` NOT mocked — `errorMessage` is exactly the function under test.
 * `voidSalesDay` is mocked to throw a `refuse(...)`-shaped error directly (constructed by hand,
 * not via the real `refuse()`, which would need `@shareat/db`'s heavy import chain live for a
 * pure unit test — the two are observably identical: `message`/`userMessage`/`name`).
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

// `sales-days/lib.ts` re-exports `withOrgPrincipal` from `../expenses/lib`, which pulls
// `@shareat/db` and RLS wiring this test has no business standing up.
vi.mock('../src/app/sales-days/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

// T-412: voidSalesDayAction now reads the day's status through lib/destructive (an unverified day is a plain withdraw, a
// verified one needs an administrator's PIN). This test is about how a refusal is DECODED, not about the PIN, so the day is
// "open" (no PIN) and the two helpers that touch the database are stubbed - the real path is t412-destructive-actions.test.ts.
vi.mock('@/lib/destructive', () => ({
  loadDestructiveTarget: async () => ({ storeId: 'store-1', name: null, status: 'open' }),
  assertApprovalStillRight: async () => undefined,
  recordApproval: async () => undefined,
}));

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const VOID_OPEN_DAY_SENTENCE =
  'Only a verified sales day can be voided — this one is open. An unverified day is edited instead.';

const voidSalesDay = vi.fn<(...args: unknown[]) => Promise<never>>(async () => {
  // Same shape `refuse(raw, sentence)` produces (F1): `message` is the raw diagnostic,
  // `userMessage` is the sentence, `name` is `'RefusalError'` — constructed by hand so this file
  // never has to import the real `@shareat/db`/`refuse()` chain (see file header).
  throw Object.assign(new Error(`voidSalesDay: sales day ${U} is open — only a verified day has a posting to reverse`), {
    userMessage: VOID_OPEN_DAY_SENTENCE,
    name: 'RefusalError',
  });
});

vi.mock('@shareat/domain', () => ({
  assertFieldRules: () => ({}),
  createSalesDay: vi.fn(),
  submitSalesDay: vi.fn(),
  verifySalesDay: vi.fn(),
  voidSalesDay: (...args: unknown[]) => voidSalesDay(...args),
  SalesDayBlockedError: class SalesDayBlockedError extends Error {
    constructor(
      message: string,
      public blockingDayId: string,
      public blockingBusinessDate: string,
    ) {
      super(message);
      this.name = 'SalesDayBlockedError';
    }
  },
}));

// ⛔ NOT a stub — forwards to the real module (see `t343-s1-action-guard.test.ts`'s identical
// comment). `errorMessage`'s own redaction is exactly what this test exists to exercise.
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

afterEach(() => {
  vi.restoreAllMocks();
  voidSalesDay.mockClear();
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

describe('A1 — voidSalesDayAction decodes a refuse(...)-shaped error to its exact sentence, no UUID', () => {
  it('the decoded error param equals the userMessage exactly', async () => {
    const { voidSalesDayAction } = await import('../src/app/sales-days/actions');
    const formData = new FormData();
    formData.set('salesDayId', 'day-1');
    formData.set('reason', 'wrong day');

    const to = await expectRedirectTo(() => voidSalesDayAction(formData));
    const url = urlOf(to);
    const errorParam = url.searchParams.get('error');

    expect(errorParam).toBe(VOID_OPEN_DAY_SENTENCE);
    expect(errorParam).not.toContain(U);
  });
});

describe('E6 (app half) — an InternalFaultError (no userMessage) never reaches the screen with its id', () => {
  it('errorMessage(err) never contains the UUID the raw diagnostic carries (Invariant 4)', async () => {
    const { errorMessage } = await import('../src/lib/constraint-messages');
    // Shape-only — `packages/domain/src/shared/refusal.ts`'s `InternalFaultError` is unreachable
    // from this file without dragging in the real `@shareat/domain` chain `vi.mock` above
    // replaces; `errorMessage`/`isPresentable` react to STRUCTURE (an `Error` with no string
    // `userMessage`), never to the class's identity, so this is the same case in every way that
    // matters (S1's own R-series tests use exactly this convention).
    const err = new Error(`verifySalesDay: sales day ${U} is verified but carries no journalEntryId — data inconsistency`);
    err.name = 'InternalFaultError';

    const shown = errorMessage(err);
    expect(shown).not.toContain(U);
    expect(shown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
