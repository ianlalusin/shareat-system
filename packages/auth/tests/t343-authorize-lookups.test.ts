/**
 * T-343 S2 — T2/T3/T4: `authorize()`'s refusal-branch lookups.
 * docs/tasks/343-def-417-human-readable-refusals.md §S2.
 *
 * `@shareat/db` is mocked entirely (`vi.mock`) — this is a UNIT test of `authorize()`'s own control
 * flow, never a real database. Real-DB coverage of the same rows lives in the new describe added to
 * `packages/auth/tests/integration/authorize.test.ts`.
 *
 * ⛔ **T2 (the success-path budget) must be GREEN NOW, before S2 lands** — it is a negative half:
 * `authorize()` making no query beyond what it already makes on a successful check is true both
 * before and after this task, and this test is how a lane discovers immediately if S2 accidentally
 * adds a lookup on the success path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const activeRoleForPerson = vi.fn();
const personHasActiveGrant = vi.fn();
const storeBelongsToOrg = vi.fn();
const personHasStoreScope = vi.fn();
const personCoversWholeOrg = vi.fn();
const grantsForPerson = vi.fn();

// ⛔ Spies that THROW if called — T2's whole point. A real implementation would resolve/return
// data; these must never be reached on a successful `authorize()` call (Invariant 5: "no query on
// the success path; refusal lookups reuse accepted inputs").
const identityOf = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => {
  throw new Error('organizationsRepo.identityOf must not be called on the success path');
});
const getById = vi.fn<(...args: unknown[]) => Promise<{ name: string; code: string } | undefined>>(() => {
  throw new Error('storesRepo.getById must not be called on the success path');
});

vi.mock('@shareat/db', () => ({
  accessRepo: {
    activeRoleForPerson: (...args: unknown[]) => activeRoleForPerson(...args),
    personHasActiveGrant: (...args: unknown[]) => personHasActiveGrant(...args),
    storeBelongsToOrg: (...args: unknown[]) => storeBelongsToOrg(...args),
    personHasStoreScope: (...args: unknown[]) => personHasStoreScope(...args),
    personCoversWholeOrg: (...args: unknown[]) => personCoversWholeOrg(...args),
    grantsForPerson: (...args: unknown[]) => grantsForPerson(...args),
  },
  organizationsRepo: { identityOf: (...args: unknown[]) => identityOf(...args) },
  storesRepo: { getById: (...args: unknown[]) => getById(...args) },
}));

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of [
    activeRoleForPerson,
    personHasActiveGrant,
    storeBelongsToOrg,
    personHasStoreScope,
    personCoversWholeOrg,
    grantsForPerson,
    identityOf,
    getById,
  ]) {
    fn.mockClear();
  }
});

const actor = { personId: 'person-1', orgId: 'org-1' };
// `authorize.ts` now runs every refusal-branch lookup inside a SAVEPOINT (`tx.transaction((t) =>
// …)`, added after Amendment R2) — the mock `tx` needs that method too, or the call blows up before
// any of T3/T4's assertions get a chance to run. `(fn) => fn(tx)` is enough for a unit test: the
// savepoint's OWN isolation is a real-Postgres property, proven separately in
// `packages/auth/tests/integration/authorize.test.ts`'s "T6b" describe — this file only needs the
// call not to throw `tx.transaction is not a function`.
const tx = { transaction: (fn: (t: unknown) => unknown) => fn(tx) } as never;

describe('T2 — success-path budget: no refusal lookup fires when authorize() resolves', () => {
  it('void_expense, admin, in scope — resolves, and neither identityOf nor getById is ever called', async () => {
    const { authorize } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'admin' });
    storeBelongsToOrg.mockResolvedValue(true);
    personHasStoreScope.mockResolvedValue(true);

    await expect(authorize(tx, actor, 'void_expense', { storeId: 'store-1' })).resolves.toBeUndefined();

    expect(identityOf).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });
});

describe('T3 — no store scope: storesRepo.getById is called once, and userMessage names the store', () => {
  it('manager holds void_expense but not this store — userMessage contains "Store Name (CODE)"', async () => {
    const { authorize, AuthorizationError } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'manager' });
    storeBelongsToOrg.mockResolvedValue(true);
    personHasStoreScope.mockResolvedValue(false);
    getById.mockReset().mockResolvedValue({ name: 'Store Name', code: 'CODE' });

    let caught: unknown;
    try {
      await authorize(tx, actor, 'void_expense', { storeId: 'store-1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthorizationError);
    expect(getById).toHaveBeenCalledTimes(1);
    expect((caught as { userMessage?: string }).userMessage).toBeDefined();
    expect((caught as { userMessage?: string }).userMessage).toContain('Store Name (CODE)');
  });
});

describe('T4 — the lookup rejects: still AuthorizationError, userMessage falls back to "that store"', () => {
  it('storesRepo.getById throwing does not blow up the refusal — caught, fallback used', async () => {
    const { authorize, AuthorizationError } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'manager' });
    storeBelongsToOrg.mockResolvedValue(true);
    personHasStoreScope.mockResolvedValue(false);
    getById.mockReset().mockRejectedValue(new Error('connection reset'));

    let caught: unknown;
    try {
      await authorize(tx, actor, 'void_expense', { storeId: 'store-1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as { userMessage?: string }).userMessage).toBeDefined();
    expect((caught as { userMessage?: string }).userMessage).toContain('that store');
  });
});
