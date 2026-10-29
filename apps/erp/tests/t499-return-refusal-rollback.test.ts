/**
 * T-499 (DEF-798) - `recordReturnAction` never commits a refused return. `docs/tasks/499-return-partial-refusal.md` ruling 4.
 *
 * `withOrgPrincipal` commits when its callback returns, even a `{ok:false}` result, and rolls back only when the callback
 * throws. The mock below records which of the two happened, so a refusal that returns (commits) is told apart from one that
 * throws (rolls back). The person must still see the SAME plain sentence in the banner either way.
 * Harness: `t379-s2-customer-return-banners.test.ts`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { paramsOf } from './helpers/flash-jar';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

const tx = vi.hoisted(() => ({ outcomes: [] as string[] }));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));
vi.mock('../src/app/expenses/lib', () => ({
  // The real one commits on a return and rolls back on a throw; this records which.
  withOrgPrincipal: async (_orgId: string, fn: (t: unknown) => unknown) => {
    try {
      const out = await fn({});
      tx.outcomes.push('committed');
      return out;
    } catch (err) {
      tx.outcomes.push('rolled back');
      throw err;
    }
  },
}));

const mocks = vi.hoisted(() => ({ recordCustomerReturn: vi.fn() }));
vi.mock('@shareat/domain', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordCustomerReturn: mocks.recordCustomerReturn,
}));

beforeAll(async () => {
  await import('@shareat/domain');
  await import('../src/app/trade/returns/actions');
}, 120_000);
afterEach(() => {
  vi.clearAllMocks();
  tx.outcomes.length = 0;
});

const STORE = '3f2b8c1e-7a4d-4e5b-9c61-0d2e8a7b5f10';
function form(): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ store: STORE, tradeOrderId: 'to-1', tradeOrderLineId: 'tol-1', quantity: '2', reason: 'Spoiled' })) fd.set(k, v);
  return fd;
}
async function run(): Promise<string> {
  const a = await import('../src/app/trade/returns/actions');
  try {
    await a.recordReturnAction(form());
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('the action did not redirect');
}

describe('T-499 recordReturnAction and a refused result', () => {
  it('a {ok:false} result rolls the transaction back and the banner carries the same sentence', async () => {
    mocks.recordCustomerReturn.mockResolvedValue({ ok: false, reason: 'that money account does not exist.' });
    const to = await run();
    expect(tx.outcomes, 'a refused return must roll back, not commit').toEqual(['rolled back']);
    expect(paramsOf(to).get('error')).toBe('that money account does not exist.');
    expect(paramsOf(to).get('ok')).toBeNull();
    expect(paramsOf(to).get('store')).toBe(STORE);
  });

  it('a thrown refusal rolls back and shows its own sentence (unchanged)', async () => {
    const { refuse } = await import('@shareat/db');
    mocks.recordCustomerReturn.mockRejectedValue(refuse('raw diagnostic', 'only 0.000 was consumed, 5.000 requested.'));
    const to = await run();
    expect(tx.outcomes).toEqual(['rolled back']);
    expect(paramsOf(to).get('error')).toBe('only 0.000 was consumed, 5.000 requested.');
  });

  it('control: an ok result commits and says the settlement sentence', async () => {
    mocks.recordCustomerReturn.mockResolvedValue({ ok: true, returnId: 'r1', journalEntryId: 'j1', settlement: 'reduce_ar' });
    const to = await run();
    expect(tx.outcomes).toEqual(['committed']);
    expect(paramsOf(to).get('ok')).toBe('Return recorded. It comes off what the customer owes.');
  });
});
