/**
 * T-369 S4F (iii) — the void sentences must REACH the person. `docs/tasks/369-*.md`, orchestrator task 2026-10-02.
 *
 * ⛔ TESTER. A void that is refused used to `throw new Error(reason)` in two of the actions below; a production build redacts a thrown
 * server-action error to a digest, so the S4F sentences ("March 2026 is closed. Stock can't be voided today …") never showed. The
 * target is the pattern `trade/orders/actions.ts` and `commissary/orders/[id]/actions.ts` already use: catch, then redirect back with
 * `?error=<sentence>`. For each of the four void actions: a refusal yields a redirect carrying the sentence and the action does not
 * throw anything else; a successful void still completes without an error redirect.
 *
 * Harness: same shape as `t343-s7-wrapper-refusals.test.ts` (`RedirectSignal` captures `redirect`; `revalidatePath` and the session are
 * stubbed; each file's own `lib` is a passthrough `withOrgPrincipal`). `@/lib/constraint-messages` is the REAL module. `@shareat/domain`
 * is the real module with only the void functions replaced, so `refuse` (the real RefusalError) builds the refusals.
 *
 * Four actions, not the three the briefing named: the customer-return void (`trade/returns/actions.ts`) throws the same way.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));
// T-412: these actions now read the record and verify an administrator's PIN first; this file is about how a refusal is CARRIED.
vi.mock('@/lib/destructive', async () => (await import('./helpers/destructive-mocks')).destructiveLibMock());
vi.mock('@shareat/auth', async (orig) => (await import('./helpers/destructive-mocks')).withApprovalStub(await orig<object>()));
vi.mock('../src/app/expenses/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../src/app/trade/orders/lib', () => ({
  peso: (v: unknown) => String(v),
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../src/app/commissary/orders/lib', async () => {
  const messages = await import('../src/lib/constraint-messages');
  return {
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
    errorMessageOf: (err: unknown) => messages.errorMessage(err),
  };
});

const mocks = vi.hoisted(() => ({
  voidReturn: vi.fn(),
  voidCustomerReturn: vi.fn(),
  voidTradeOrder: vi.fn(),
}));
vi.mock('@shareat/domain', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, voidReturn: mocks.voidReturn, voidCustomerReturn: mocks.voidCustomerReturn, voidTradeOrder: mocks.voidTradeOrder };
});

// The real domain module is loaded once, up front: the first dynamic import costs more than a test's own 5s.
beforeAll(async () => {
  await import('@shareat/domain');
}, 60_000);

afterEach(() => {
  vi.clearAllMocks();
});

const SENTENCE = "March 2026 is closed. Stock can't be voided today — a closed month's stock stays as it was.";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

/** Runs the action; returns the redirect target, or the non-redirect error it threw, or null if it returned normally. */
async function outcomeOf(run: () => Promise<unknown>): Promise<{ redirect: string | null; thrown: Error | null }> {
  try {
    await run();
    return { redirect: null, thrown: null };
  } catch (err) {
    if (err instanceof RedirectSignal) return { redirect: err.to, thrown: null };
    return { redirect: null, thrown: err as Error };
  }
}
const errorParam = (to: string | null): string | null => (to ? paramsOf(to).get('error') : null);

describe('a refused void redirects back carrying the sentence, and never throws', () => {
  it('inventory/returns voidReturnAction ({ok:false} from voidReturn)', async () => {
    const { voidReturnAction } = await import('../src/app/inventory/returns/actions');
    mocks.voidReturn.mockResolvedValue({ ok: false, reason: SENTENCE });
    const out = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong' })));
    expect(out.thrown, `the action threw (a production build shows this as a digest): ${out.thrown?.message}`).toBeNull();
    expect(errorParam(out.redirect), `no redirect carrying the sentence (redirect: ${out.redirect})`).toBe(SENTENCE);
  });

  it('trade/returns voidReturnAction ({ok:false} from voidCustomerReturn)', async () => {
    const { voidReturnAction } = await import('../src/app/trade/returns/actions');
    mocks.voidCustomerReturn.mockResolvedValue({ ok: false, reason: SENTENCE });
    const out = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong' })));
    expect(out.thrown, `the action threw (a production build shows this as a digest): ${out.thrown?.message}`).toBeNull();
    expect(errorParam(out.redirect), `no redirect carrying the sentence (redirect: ${out.redirect})`).toBe(SENTENCE);
  });

  it('trade/orders voidOrderAction (voidTradeOrder throws a presentable refusal)', async () => {
    const { refuse } = await import('@shareat/domain');
    const { voidOrderAction } = await import('../src/app/trade/orders/actions');
    mocks.voidTradeOrder.mockRejectedValue(refuse(`voidTradeOrder: ${SENTENCE}`, SENTENCE));
    const out = await outcomeOf(() => voidOrderAction(form({ orderId: 'o-1', reason: 'Typed wrong' })));
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(errorParam(out.redirect), `no redirect carrying the sentence (redirect: ${out.redirect})`).toBe(SENTENCE);
  });

  it('commissary/orders/[id] withdrawOrderAction (voidTradeOrder throws a presentable refusal)', async () => {
    const { refuse } = await import('@shareat/domain');
    const { withdrawOrderAction } = await import('../src/app/commissary/orders/[id]/actions');
    mocks.voidTradeOrder.mockRejectedValue(refuse(`voidTradeOrder: ${SENTENCE}`, SENTENCE));
    const out = await outcomeOf(() => withdrawOrderAction(form({ orderId: 'o-1', reason: 'Typed wrong' })));
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(errorParam(out.redirect), `no redirect carrying the sentence (redirect: ${out.redirect})`).toBe(SENTENCE);
  });
});

describe('control — a successful void still completes, with no error redirect', () => {
  it('inventory/returns voidReturnAction', async () => {
    const { voidReturnAction } = await import('../src/app/inventory/returns/actions');
    mocks.voidReturn.mockResolvedValue({ ok: true });
    const out = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong' })));
    expect(out.thrown).toBeNull();
    expect(errorParam(out.redirect)).toBeNull();
  });

  it('trade/returns voidReturnAction', async () => {
    const { voidReturnAction } = await import('../src/app/trade/returns/actions');
    mocks.voidCustomerReturn.mockResolvedValue({ ok: true });
    const out = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong' })));
    expect(out.thrown).toBeNull();
    expect(errorParam(out.redirect)).toBeNull();
  });

  it('trade/orders voidOrderAction redirects with ok=', async () => {
    const { voidOrderAction } = await import('../src/app/trade/orders/actions');
    mocks.voidTradeOrder.mockResolvedValue({ reversedEntryId: 'e-1' });
    const out = await outcomeOf(() => voidOrderAction(form({ orderId: 'o-1', reason: 'Typed wrong' })));
    expect(out.thrown).toBeNull();
    expect(paramsOf(out.redirect!).get('ok')).toBeTruthy();
  });

  it('commissary/orders/[id] withdrawOrderAction redirects with ok=', async () => {
    const { withdrawOrderAction } = await import('../src/app/commissary/orders/[id]/actions');
    mocks.voidTradeOrder.mockResolvedValue({ reversedEntryId: 'e-1' });
    const out = await outcomeOf(() => withdrawOrderAction(form({ orderId: 'o-1', reason: 'Typed wrong' })));
    expect(out.thrown).toBeNull();
    expect(paramsOf(out.redirect!).get('ok')).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------------------------
// (iv) — a `{ok:false, reason}` carrying an identifier must be redacted exactly as the thrown path redacts it.
// -----------------------------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WITH_ID = 'return 0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b does not exist';
const returnsActions = [
  ['inventory/returns voidReturnAction', () => import('../src/app/inventory/returns/actions'), mocks.voidReturn],
  ['trade/returns voidReturnAction', () => import('../src/app/trade/returns/actions'), mocks.voidCustomerReturn],
] as const;

describe.each(returnsActions)('%s — an {ok:false} reason is redacted like a thrown one', (_name, load, domainFn) => {
  it('a reason carrying a uuid: ?error= has no uuid shape and equals what errorMessage makes of the same text thrown', async () => {
    const { errorMessage } = await import('../src/lib/constraint-messages');
    const { voidReturnAction } = await load();
    domainFn.mockResolvedValue({ ok: false, reason: WITH_ID });
    const out = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong' })));
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    const shown = errorParam(out.redirect);
    expect(shown, `no ?error= (redirect: ${out.redirect})`).not.toBeNull();
    expect(shown, 'a uuid reached the page').not.toMatch(UUID_RE);
    expect(shown, 'not the same text the thrown path produces').toBe(errorMessage(new Error(WITH_ID)));
  });

  it('control: a reason with no id reaches ?error= unchanged', async () => {
    const { voidReturnAction } = await load();
    domainFn.mockResolvedValue({ ok: false, reason: SENTENCE });
    const out = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong' })));
    expect(errorParam(out.redirect)).toBe(SENTENCE);
  });
});
