/**
 * T-343 S5.5m — H5: `createRemittanceAction`'s re-wrap carries the human sentence through
 * `handedOverOn` (design rule 4). docs/tasks/343-def-417-human-readable-refusals.md §S5.5m.
 *
 * ⛔ TESTER, not BUILDER. `handedOverOn` (`apps/erp/src/app/remittance/actions.ts:96-104`) still
 * re-throws a plain `Error` with only a `.message` — no `userMessage` — so the redirect's `error`
 * param is today's raw, label-leaking sentence. Expected red until the builder applies design
 * rule 4.
 *
 * Action harness: `RedirectSignal` (t337-access-defaults-actions.test.ts precedent), mocked
 * session and `cashierAccounts`/`withOrgPrincipal` (`./lib`), the REAL `@shareat/domain/money-input`
 * and the REAL shared `errorMessage` (`@/lib/constraint-messages`, re-exported through the mock
 * since the root vitest config has no `@/*` alias — never a stub, per the spec's own instruction).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paramsOf } from './helpers/flash-jar';

// T-380: the action now goes through the real `redirectWithFlash`, which signs the flash cookie (`signFlash` ->
// `derivedKey` -> the validated server env). Signing stays real; only the env a unit test lacks is supplied.
process.env['DATABASE_URL'] ??= 'postgresql://postgres:pw@localhost:5435/shareat_dev';
process.env['SESSION_SECRET'] ??= 'x'.repeat(48);
process.env['APP_TIMEZONE'] ??= 'Asia/Manila';

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
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'actor-1' })),
}));

// The real module, reached through the unresolvable `@/` specifier — never a stub. `errorMessage`
// is what turns the caught error into the redirect's `error` param, and H5 is precisely about its
// real behaviour (isPresentable → userMessage).
let lastCaught: unknown;
vi.mock('@/lib/constraint-messages', async () => {
  const actual = await import('../src/lib/constraint-messages');
  return {
    ...actual,
    errorMessage: (err: unknown) => {
      lastCaught = err;
      return actual.errorMessage(err);
    },
  };
});

const GCASH = { id: 'acct-gcash', name: 'GCash', instrument: 'ewallet', custodian: 'cashier', balance: '0.00' };
// Untyped `vi.fn()` (no inline implementation) — an inferred zero-param signature would reject the
// spread below at typecheck (S6b precedent: `Object.assign`/`vi.fn(async () => …)` pins arity).
const cashierAccountsMock = vi.fn();
cashierAccountsMock.mockResolvedValue([GCASH]);
vi.mock('../src/app/remittance/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/remittance/lib')>();
  return { ...actual, cashierAccounts: (...args: unknown[]) => cashierAccountsMock(...args) };
});

afterEach(() => {
  lastCaught = undefined;
});

function lineFormData(amount: string): FormData {
  const fd = new FormData();
  fd.set('storeId', 'store-1');
  fd.append('lineAccountId', GCASH.id);
  fd.set('lineTo_0', 'acct-drawer');
  fd.set('lineAmount_0', amount);
  fd.set('remittedOn', '2026-01-15');
  return fd;
}

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
    throw new Error('expected the action to redirect, but it returned normally');
  } catch (err) {
    if (!(err instanceof RedirectSignal)) throw err;
    return err.to;
  }
}

describe('H5 — createRemittanceAction: a malformed line amount names its account and the human sentence', () => {
  it(
    '"GCash" typed "abc" → error param names the account and the human label',
    async () => {
      const { createRemittanceAction } = await import('../src/app/remittance/actions');
      const to = await expectRedirectTo(() => createRemittanceAction(lineFormData('abc')));
      const params = paramsOf(to);
      expect(params.get('error'), `redirect URL was: ${to}`).toBe(
        '"GCash": the amount handed over — "abc" is not a valid amount. Use at most two decimal places.',
      );

      // H6 — the raw diagnostic stays byte-identical to today's (Invariant 1): the account-prefixed
      // wrap around parseMoneyInput's own raw label, unchanged.
      expect(lastCaught).toBeInstanceOf(Error);
      expect((lastCaught as Error).message).toBe(
        '"GCash": createRemittanceAction: the amount handed over — "abc" is not a valid amount. Use at most two decimal places.',
      );
    },
    // First import of actions.ts drags in schema/domain/auth/drizzle for a fresh transform under
    // load — routinely exceeds vitest's 5000ms default even though the assertions are correct
    // (t337-access-defaults-actions.test.ts precedent).
    30_000,
  );
});
