/**
 * T-376 S2 (DEF-582) - a supplier return and a supplier-credit refund say what happened.
 * `docs/tasks/376-ap-closed-month-and-screen-nits.md` S2, R8.
 *
 * TESTER, not BUILDER. `recordReturnAction` and `refundCreditAction` used to return normally on success (no banner) and
 * `throw new Error(reason)` on a refusal (a production build shows a digest). The target is `voidReturnAction`'s shape:
 * success -> `?store=<storeId>&ok=<sentence>`; `{ok:false}` and a thrown refusal -> `?store=<storeId>&error=<sentence>`
 * through the REAL `errorMessage`; `revalidatePath('/inventory/returns')` is called BEFORE the success redirect.
 *
 * Harness: `t369-s4f-void-actions.test.ts` (RedirectSignal captures `redirect`; the domain is the real module with only
 * the three supplier-return functions replaced, so `refuse` builds real refusals).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

const calls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    calls.order.push(`redirect:${to}`);
    throw new RedirectSignal(to);
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (p: string) => {
    calls.order.push(`revalidate:${p}`);
  },
}));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));
vi.mock('../src/app/expenses/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

const mocks = vi.hoisted(() => ({
  recordReturn: vi.fn(),
  refundSupplierCredit: vi.fn(),
  voidReturn: vi.fn(),
}));
vi.mock('@shareat/domain', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    recordReturn: mocks.recordReturn,
    refundSupplierCredit: mocks.refundSupplierCredit,
    voidReturn: mocks.voidReturn,
  };
});

beforeAll(async () => {
  await import('@shareat/domain');
  await import('../src/app/inventory/returns/actions');
}, 120_000);

afterEach(() => {
  vi.clearAllMocks();
  calls.order.length = 0;
});

const RECORD_OK = 'Return recorded. The stock is taken out, and the supplier owes us the credit.';
const REFUND_OK = "Refund recorded. The supplier's credit is reduced by what they paid back.";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}
const RETURN_FORM = {
  storeId: 'store-9',
  supplierId: 'sup-1',
  itemId: 'item-1',
  itemKind: 'raw_material',
  locationId: 'loc-1',
  quantity: '2',
  reason: 'Spoiled',
};
const REFUND_FORM = { storeId: 'store-9', supplierId: 'sup-1', moneyAccountId: 'acct-1', amount: '100.00' };

async function outcomeOf(run: () => Promise<unknown>): Promise<{ redirect: string | null; thrown: Error | null }> {
  try {
    await run();
    return { redirect: null, thrown: null };
  } catch (err) {
    if (err instanceof RedirectSignal) return { redirect: err.to, thrown: null };
    return { redirect: null, thrown: err as Error };
  }
}
const param = (to: string | null, key: string): string | null =>
  to ? new URLSearchParams(to.split('?')[1] ?? '').get(key) : null;

const ACTIONS = [
  ['recordReturnAction', 'recordReturn', RETURN_FORM, RECORD_OK],
  ['refundCreditAction', 'refundSupplierCredit', REFUND_FORM, REFUND_OK],
] as const;

describe.each(ACTIONS)('%s', (actionName, domainFn, formData, okSentence) => {
  const run = async () => {
    const actions = await import('../src/app/inventory/returns/actions');
    return outcomeOf(() => actions[actionName](form(formData)));
  };
  const domain = () => mocks[domainFn];

  it('success: redirects to /inventory/returns with the store kept and the ok sentence', async () => {
    domain().mockResolvedValue({ ok: true });
    const out = await run();
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(out.redirect, 'no redirect on success (the screen stays silent)').not.toBeNull();
    expect(out.redirect!.startsWith('/inventory/returns?'), `redirect: ${out.redirect}`).toBe(true);
    expect(param(out.redirect, 'ok'), `redirect: ${out.redirect}`).toBe(okSentence);
    expect(param(out.redirect, 'store'), `store lost (redirect: ${out.redirect})`).toBe('store-9');
    expect(param(out.redirect, 'error'), `redirect: ${out.redirect}`).toBeNull();
  });

  it('revalidatePath is called BEFORE the success redirect', async () => {
    domain().mockResolvedValue({ ok: true });
    await run();
    const rev = calls.order.indexOf('revalidate:/inventory/returns');
    const red = calls.order.findIndex((m) => m.startsWith('redirect:'));
    expect(rev, `no revalidate (order: ${calls.order.join(' | ')})`).toBeGreaterThanOrEqual(0);
    expect(red, `no redirect (order: ${calls.order.join(' | ')})`).toBeGreaterThanOrEqual(0);
    expect(rev, `order: ${calls.order.join(' | ')}`).toBeLessThan(red);
  });

  it('{ok:false, reason}: a redirect carrying the reason in ?error= with the store kept, nothing thrown', async () => {
    const reason = 'a return with no lines returns nothing';
    domain().mockResolvedValue({ ok: false, reason });
    const out = await run();
    expect(out.thrown, `the action threw (a production build shows a digest): ${out.thrown?.message}`).toBeNull();
    expect(param(out.redirect, 'error'), `redirect: ${out.redirect}`).toBe(reason);
    expect(param(out.redirect, 'store'), `store lost (redirect: ${out.redirect})`).toBe('store-9');
    expect(param(out.redirect, 'ok'), `redirect: ${out.redirect}`).toBeNull();
  });

  it('{ok:false} with an id in the reason: redacted exactly as the thrown path redacts it', async () => {
    const withId = 'return 0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b does not exist';
    const { errorMessage } = await import('../src/lib/constraint-messages');
    domain().mockResolvedValue({ ok: false, reason: withId });
    const out = await run();
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    const shown = param(out.redirect, 'error');
    expect(shown, `no ?error= (redirect: ${out.redirect})`).not.toBeNull();
    expect(shown, 'a uuid reached the page').not.toMatch(UUID_RE);
    expect(shown).toBe(errorMessage(new Error(withId)));
  });

  it('a thrown refusal: ?error= carries the user sentence, not the raw text; nothing thrown', async () => {
    const { refuse } = await import('@shareat/domain');
    const sentence = 'The quantity must be a number.';
    domain().mockRejectedValue(refuse('raw: quantity failed parse 0190a3b4', sentence));
    const out = await run();
    expect(out.thrown, `the action threw (a digest in production): ${out.thrown?.message}`).toBeNull();
    expect(param(out.redirect, 'error'), `redirect: ${out.redirect}`).toBe(sentence);
    expect(param(out.redirect, 'store'), `store lost (redirect: ${out.redirect})`).toBe('store-9');
  });

  it('a refused call never shows the ok banner', async () => {
    domain().mockResolvedValue({ ok: false, reason: 'refused' });
    const out = await run();
    expect(out.redirect, 'a refusal produced no redirect at all').not.toBeNull();
    expect(param(out.redirect, 'ok'), `redirect: ${out.redirect}`).toBeNull();
  });

  it('revalidatePath is NOT called on a refusal ({ok:false} or thrown); control: called once on success', async () => {
    const { refuse } = await import('@shareat/domain');
    domain().mockResolvedValue({ ok: false, reason: 'refused' });
    await run();
    expect(calls.order.filter((m) => m.startsWith('revalidate:')), `{ok:false} order: ${calls.order.join(' | ')}`).toEqual([]);

    calls.order.length = 0;
    domain().mockRejectedValue(refuse('raw', 'A sentence.'));
    await run();
    expect(calls.order.filter((m) => m.startsWith('revalidate:')), `thrown order: ${calls.order.join(' | ')}`).toEqual([]);

    calls.order.length = 0;
    domain().mockReset();
    domain().mockResolvedValue({ ok: true });
    await run();
    expect(calls.order.filter((m) => m.startsWith('revalidate:')), `success order: ${calls.order.join(' | ')}`).toEqual([
      'revalidate:/inventory/returns',
    ]);
  });

  it('an empty storeId omits the store key (success and refusal); control: a real storeId keeps it', async () => {
    const actions = await import('../src/app/inventory/returns/actions');
    const noStore = { ...formData, storeId: '' };
    domain().mockResolvedValue({ ok: true });
    const okOut = await outcomeOf(() => actions[actionName](form(noStore)));
    expect(okOut.redirect, 'no redirect').not.toBeNull();
    expect(new URLSearchParams(okOut.redirect!.split('?')[1]).has('store'), `ok redirect: ${okOut.redirect}`).toBe(false);
    expect(param(okOut.redirect, 'ok'), `ok redirect: ${okOut.redirect}`).toBe(okSentence);

    domain().mockResolvedValue({ ok: false, reason: 'refused' });
    const errOut = await outcomeOf(() => actions[actionName](form(noStore)));
    expect(new URLSearchParams(errOut.redirect!.split('?')[1]).has('store'), `error redirect: ${errOut.redirect}`).toBe(false);
    expect(param(errOut.redirect, 'error'), `error redirect: ${errOut.redirect}`).toBe('refused');

    domain().mockResolvedValue({ ok: true });
    const keepOut = await outcomeOf(() => actions[actionName](form(formData)));
    expect(param(keepOut.redirect, 'store'), `control redirect: ${keepOut.redirect}`).toBe('store-9');
  });
});

describe('control - voidReturnAction is untouched', () => {
  it('success still redirects with its own ok sentence; a refusal still redirects with ?error=', async () => {
    const { voidReturnAction } = await import('../src/app/inventory/returns/actions');
    mocks.voidReturn.mockResolvedValue({ ok: true });
    const okOut = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong', store: 'store-9' })));
    expect(param(okOut.redirect, 'ok'), `redirect: ${okOut.redirect}`).toBe(
      'Return voided. The stock is given back and the credit it held is reversed.',
    );
    mocks.voidReturn.mockResolvedValue({ ok: false, reason: 'closed' });
    const badOut = await outcomeOf(() => voidReturnAction(form({ returnId: 'r-1', reason: 'Typed wrong', store: 'store-9' })));
    expect(param(badOut.redirect, 'error'), `redirect: ${badOut.redirect}`).toBe('closed');
  });
});
