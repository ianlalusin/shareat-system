/**
 * T-598 S8 / DEF-280 - the three inventory/transfers actions that threw a refusal now carry it back as a sentence.
 * Same harness as `t369-s4f-void-actions.test.ts` (redirect captured, session and principal stubbed, the real domain with only the
 * transfer functions replaced).
 *
 * MUTANT: put `if (!result.ok) throw new Error(result.reason)` back outside a try/catch in one of the three actions -> that case reads a thrown error.
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
vi.mock('@/lib/destructive', async () => (await import('./helpers/destructive-mocks')).destructiveLibMock());
vi.mock('@shareat/auth', async (orig) => (await import('./helpers/destructive-mocks')).withApprovalStub({ ...(await orig<object>()), can: async () => false }));
vi.mock('../src/app/expenses/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

const mocks = vi.hoisted(() => ({ transferNow: vi.fn(), saveDraft: vi.fn(), dispatch: vi.fn(), receiveTransfer: vi.fn() }));
vi.mock('@shareat/domain', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, transferNow: mocks.transferNow, saveDraft: mocks.saveDraft, dispatch: mocks.dispatch, receiveTransfer: mocks.receiveTransfer };
});

beforeAll(async () => {
  await import('@shareat/domain');
}, 60_000);
afterEach(() => vi.clearAllMocks());

const SENTENCE = 'There is not enough Pork Belly in that room for this transfer.';

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}
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

describe('a refused transfer step redirects back carrying the sentence, and never throws', () => {
  it('createTransferAction (transferNow answers {ok:false})', async () => {
    const { createTransferAction } = await import('../src/app/inventory/transfers/actions');
    mocks.transferNow.mockResolvedValue({ ok: false, reason: SENTENCE });
    const out = await outcomeOf(() => createTransferAction(form({ storeId: 's-1', fromLocationId: 'a', toLocationId: 'b', itemId: 'i-1', quantity: '2', mode: 'now' })));
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(errorParam(out.redirect)).toBe(SENTENCE);
  });

  it('dispatchTransferAction ({ok:false} from dispatch)', async () => {
    const { dispatchTransferAction } = await import('../src/app/inventory/transfers/actions');
    mocks.dispatch.mockResolvedValue({ ok: false, reason: SENTENCE });
    const out = await outcomeOf(() => dispatchTransferAction(form({ transferId: 't-1' })));
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(errorParam(out.redirect)).toBe(SENTENCE);
  });

  it('receiveTransferAction ({ok:false} from receiveTransfer)', async () => {
    const { receiveTransferAction } = await import('../src/app/inventory/transfers/actions');
    mocks.receiveTransfer.mockResolvedValue({ ok: false, reason: SENTENCE });
    const out = await outcomeOf(() => receiveTransferAction(form({ transferId: 't-1' })));
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(errorParam(out.redirect)).toBe(SENTENCE);
  });
});
